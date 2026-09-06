import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CellConnection, DeviceClient, readJson, processLock } from './portal-client.mjs';
import { launchSlackJob, readSlackJob } from './slack-job.js';

export interface PortalRuntimeOptions {
  root?: string;
  signal?: AbortSignal;
  log?: (event: { event: string; code?: string; deviceId?: string }) => void;
  intervalMs?: number;
}

/** One connection per running checkout. Only locally saved, authorized work
 * can run; cell notifications cause a fresh read of that durable work. */
export function startPortalRuntime({
  root = process.cwd(),
  signal,
  log = () => {},
  intervalMs = 5000,
}: PortalRuntimeOptions = {}) {
  const abort = new AbortController();
  const file = path.join(root, 'data/community-portal.json');
  let connection: CellConnection | undefined;
  let identity: unknown;
  let rejected = false;
  let release: (() => void) | null = null;
  let pending: Promise<void> | undefined;
  let again = false;
  let dirty = true;
  let nextSync = 0;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let lastError = '';
  const denied = (error: any) => [401, 403].includes(error.status);
  const rejectIdentity = () => {
    if (!rejected) log({ event: 'sign_in_required' });
    rejected = true;
    dirty = true;
    connection?.stop();
    wake();
  };
  async function check() {
    release ||= await processLock(path.join(root, 'data/community-portal-runtime.lock'));
    if (!release || stopped) return;
    // Read without owning the setup journal so the connection stays alive
    // while the CLI waits for a browser choice. All writes below are locked.
    const local = await readJson(file);
    if (
      local?.registryAccount?.token &&
      (!local.installId ||
        local.installId !== local.registryAccount.install_id ||
        !local.deviceId ||
        !local.privateKey ||
        !local.origin)
    ) {
      connection?.stop();
      connection = undefined;
      identity = undefined;
      throw Object.assign(new Error('Installation state is incomplete.'), { code: 'installation_state_invalid' });
    }
    const current =
      local?.registryAccount?.token && local.deviceId && local.privateKey && local.origin
        ? {
            origin: local.origin,
            installId: local.installId,
            deviceId: local.deviceId,
            privateKey: local.privateKey,
            registryAccount: local.registryAccount,
          }
        : undefined;
    if (!isDeepStrictEqual(current, identity)) {
      connection?.stop();
      connection = undefined;
      identity = current;
      rejected = false;
      dirty = true;
      if (current) {
        const proof = new DeviceClient({
          origin: current.origin,
          token: current.registryAccount.token,
          file,
          signal: abort.signal,
        });
        proof.local = current;
        connection = new CellConnection({
          origin: proof.origin,
          getTicket: async (requestSignal) => {
            try {
              return await proof.request('POST', '/api/v1/cell-ticket', {}, requestSignal);
            } catch (error) {
              if (denied(error) && isDeepStrictEqual(identity, current)) rejectIdentity();
              throw error;
            }
          },
          onChange: () => {
            dirty = true;
            wake();
          },
          log: (event) => log({ ...event, deviceId: current.deviceId }),
        });
        connection.start();
      }
    }
    if (!current || stopped) return;
    const job = await readSlackJob(root);
    // Supervise only the saved installation bound to this account/checkout.
    // A live worker keeps its existing approval polling; no duplicate spawns.
    if (
      !rejected &&
      job &&
      job.identity.deviceId === current.deviceId &&
      job.identity.registryAccount?.install_id === current.installId &&
      job.identity.registryAccount?.account_id === current.registryAccount.account_id &&
      job.origin === current.origin
    ) {
      if (await launchSlackJob(root)) log({ event: 'slack_install_resumed', deviceId: current.deviceId });
    }
    if (stopped || (!dirty && Date.now() < nextSync)) return;
    const client = new DeviceClient({
      origin: current.origin,
      file,
      exclusive: true,
      existingOnly: true,
      signal: abort.signal,
      log,
    });
    try {
      await client.initialize();
      // The CLI may have changed identity while we acquired the journal.
      if (client.local.deviceId !== current.deviceId || client.token !== current.registryAccount.token) return;
      if (rejected) {
        client.local.credentials = {};
        client.local.operations = {};
        await client.save();
        dirty = false;
        nextSync = Infinity;
        return;
      }
      dirty = false;
      await client.reconcile();
      nextSync = Date.now() + 60_000;
    } catch (error: any) {
      if (error.code === 'journal_busy') return;
      if (denied(error)) {
        rejectIdentity();
        if (client.local) {
          client.local.credentials = {};
          client.local.operations = {};
          await client.save();
        }
        return;
      }
      dirty = true;
      throw error;
    } finally {
      await client.stop();
    }
  }
  function wake() {
    if (stopped) return;
    if (pending) {
      again = true;
      return;
    }
    pending = check()
      .then(() => {
        lastError = '';
      })
      .catch((error: any) => {
        if (stopped) return;
        const code = error.code || 'unavailable';
        if (code !== lastError) log({ event: 'runtime_retry', code });
        lastError = code;
      })
      .finally(() => {
        pending = undefined;
        if (again) {
          again = false;
          wake();
        }
      });
  }
  const timer = setInterval(wake, intervalMs);
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    abort.abort();
    clearInterval(timer);
    connection?.stop();
    signal?.removeEventListener('abort', onAbort);
    stopping = (async () => {
      await pending;
      release?.();
      release = null;
    })();
    return stopping;
  }
  const onAbort = () => {
    void stop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) void stop();
  else wake();
  return { stop };
}
