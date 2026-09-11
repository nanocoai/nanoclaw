import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { wireDoor, type Door } from '../../code-mode/remote/door.js';
import { openStream } from '../../code-mode/remote/stream.js';
import {
  CellLink,
  DeviceClient,
  errorCode,
  errorStatus,
  type Journal,
  type LinkEvent,
  type LinkSocketConstructor,
  portalError,
  processLock,
  readDeviceKey,
  readInstallIdentity,
  readJson,
  terminalSnapshotOf,
} from '../../community-portal/index.js';
import { launchSlackJob, readSlackJob } from '../../community-portal/slack-job.js';

/**
 * Keeps a running host connected to its account cell for as long as the
 * machine is signed in and the checkout has a registered device. The identity
 * is account.json (install token and ids) + device-key.json + the journal's
 * device id; the runtime reads all three without taking the journal lock, so
 * the link survives while foreground setup owns it. One link per checkout,
 * guarded by `data/community-portal-runtime.lock`. Reconciling goes over
 * bearer routes through a locked DeviceClient; the link dials with a proofed
 * ticket. Cell pushes only trigger a fresh read of locally saved, authorized
 * work: perk credentials and the saved Slack install worker.
 *
 * While the loopback door is enabled the link also announces the `ssh` cap
 * and pipes every `ssh` channel the cell opens into the door from a distinct
 * loopback source port; the door's state is part of the identity, so
 * `remote enable|disable` restarts the link and the caps are re-announced
 * (the door's state report wakes the runtime, and a poll catches the rest).
 * Every perks snapshot's `terminal` section goes to the door, and the door's
 * state is reported to the account service every fifteen minutes.
 */
export interface PortalRuntimeOptions {
  root?: string;
  homeDir?: string;
  signal?: AbortSignal;
  log?: (event: LinkEvent) => void;
  intervalMs?: number;
  /** Test seam: the WebSocket constructor the link dials with. */
  Socket?: LinkSocketConstructor;
  /** Test seam: the door as the link sees it; the real door is wired by default. */
  door?: Door;
  terminalReportMs?: number;
}

interface Identity {
  origin: string;
  token: string;
  accountId: string;
  installId: string;
  deviceId: string;
  fingerprint: string;
  /** The door's loopback port while it is enabled. */
  doorPort?: number;
}

const RECONCILE_INTERVAL_MS = 60_000;
export const TERMINAL_REPORT_INTERVAL_MS = 15 * 60_000;

export function startPortalRuntime({
  root = process.cwd(),
  homeDir,
  signal,
  log = () => {},
  intervalMs = 5000,
  Socket,
  door: providedDoor,
  terminalReportMs = TERMINAL_REPORT_INTERVAL_MS,
}: PortalRuntimeOptions = {}): { stop(): Promise<void> } {
  const abort = new AbortController();
  const file = path.join(root, 'data/community-portal.json');
  const door = providedDoor ?? wireDoor({ root, homeDir, log, onReported: () => wake() });
  let link: CellLink | undefined;
  let identity: Identity | undefined;
  let rejected = false;
  let release: (() => void) | null = null;
  let pending: Promise<void> | undefined;
  let again = false;
  let dirty = true;
  let nextSync = 0;
  let nextTerminalReport = 0;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let lastError = '';
  const denied = (error: unknown): boolean => [401, 403].includes(errorStatus(error) ?? 0);
  const rejectIdentity = (): void => {
    if (!rejected) log({ event: 'sign_in_required' });
    rejected = true;
    dirty = true;
    link?.stop();
    wake();
  };

  async function check(): Promise<void> {
    release ||= await processLock(path.join(root, 'data/community-portal-runtime.lock'));
    if (!release || stopped) return;
    const local = await readJson<Partial<Journal>>(file);
    const account = local?.deviceId && local.origin ? await readInstallIdentity({ homeDir }) : null;
    const key = account ? readDeviceKey({ homeDir }) : null;
    if (account && !key) {
      link?.stop();
      link = undefined;
      identity = undefined;
      throw portalError('The device key is missing. Run the portal setup step again.', 'device_key_missing');
    }
    const doorState = await door.status();
    const current: Identity | undefined =
      local?.deviceId && local.origin && account && key
        ? {
            origin: local.origin,
            token: account.token,
            accountId: account.accountId,
            installId: account.installId,
            deviceId: local.deviceId,
            fingerprint: key.fingerprint,
            ...(doorState.enabled && doorState.port !== undefined ? { doorPort: doorState.port } : {}),
          }
        : undefined;
    if (!isDeepStrictEqual(current, identity)) {
      link?.stop();
      link = undefined;
      identity = current;
      rejected = false;
      dirty = true;
      nextTerminalReport = 0;
      if (current && key) {
        const tickets = new DeviceClient({
          origin: current.origin,
          identity: account ?? undefined,
          deviceKey: key,
          file,
          signal: abort.signal,
        });
        tickets.local = { origin: current.origin, deviceId: current.deviceId, credentials: {}, operations: {} };
        const changed = (): void => {
          dirty = true;
          wake();
        };
        const linkLog = (event: LinkEvent): void => log({ ...event, deviceId: current.deviceId });
        const doorPort = current.doorPort;
        link = new CellLink({
          origin: tickets.origin,
          getTicket: async (requestSignal) => {
            try {
              return await tickets.ticket(requestSignal);
            } catch (error) {
              if (denied(error) && isDeepStrictEqual(identity, current)) rejectIdentity();
              throw error;
            }
          },
          onSnapshot: ({ snapshot }) => {
            door
              .applyTerminalSnapshot(terminalSnapshotOf(snapshot))
              .catch((error: unknown) => linkLog({ event: 'terminal_snapshot_failed', code: errorCode(error) }));
            changed();
          },
          onChange: changed,
          onForbidden: () => {
            if (isDeepStrictEqual(identity, current)) rejectIdentity();
          },
          ...(doorPort === undefined
            ? {}
            : { ssh: (open, channel) => openStream({ open, channel, doorPort, door, log: linkLog }) }),
          log: linkLog,
          ...(Socket ? { Socket } : {}),
        });
        link.start();
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
      job.identity.install_id === current.installId &&
      job.identity.account_id === current.accountId &&
      job.origin === current.origin
    ) {
      if (await launchSlackJob(root)) log({ event: 'slack_install_resumed', deviceId: current.deviceId });
    }
    if (stopped || (!dirty && Date.now() < nextSync)) return;
    const client = new DeviceClient({
      origin: current.origin,
      identity: account ?? undefined,
      file,
      exclusive: true,
      existingOnly: true,
      signal: abort.signal,
      log,
    });
    try {
      await client.initialize();
      // The CLI may have changed identity while we acquired the journal.
      if (client.local.deviceId !== current.deviceId) return;
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
      if (doorState.enabled && Date.now() >= nextTerminalReport) {
        try {
          await client.reportTerminal({
            enabled: true,
            ...(doorState.hostKey ? { hostKey: doorState.hostKey } : {}),
            ...(doorState.port === undefined ? {} : { doorPort: doorState.port }),
            authorizedFingerprints: doorState.authorizedFingerprints,
          });
          nextTerminalReport = Date.now() + terminalReportMs;
          log({ event: 'terminal_reported', deviceId: current.deviceId });
        } catch (error) {
          if (denied(error)) throw error;
          // The service may not carry the route yet; try again with the next reconcile.
          nextTerminalReport = Date.now() + RECONCILE_INTERVAL_MS;
          log({ event: 'terminal_report_failed', code: errorCode(error), deviceId: current.deviceId });
        }
      }
      nextSync = Date.now() + RECONCILE_INTERVAL_MS;
    } catch (error) {
      if (errorCode(error, '') === 'journal_busy') return;
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

  function wake(): void {
    if (stopped) return;
    if (pending) {
      again = true;
      return;
    }
    pending = check()
      .then(() => {
        lastError = '';
      })
      .catch((error: unknown) => {
        if (stopped) return;
        const code = errorCode(error);
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
    link?.stop();
    signal?.removeEventListener('abort', onAbort);
    stopping = (async () => {
      await pending;
      release?.();
      release = null;
    })();
    return stopping;
  }
  const onAbort = (): void => {
    void stop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) void stop();
  else wake();
  return { stop };
}
