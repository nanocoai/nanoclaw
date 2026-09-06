// host-integration/setup/portal-runtime.ts
import path2 from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CellConnection, DeviceClient, readJson, processLock as processLock3 } from "./portal-client.mjs";

// host-integration/setup/slack-job.ts
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writePrivate, SetupClient, processLock, processLockOwner } from "./portal-client.mjs";
import { processLock as processLock2 } from "./portal-client.mjs";
var slackJobFile = (root = process.cwd()) => path.join(root, "data/slack-install.json");
async function readSlackJob(root = process.cwd()) {
  try {
    return JSON.parse(await readFile(slackJobFile(root), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function launchSlackJob(root = process.cwd()) {
  const job = await readSlackJob(root);
  if (!job || !(["awaiting_approval", "installing"].includes(job.status) || job.status === "complete" && job.reportedStatus !== "complete"))
    return false;
  if (processLockOwner(`${slackJobFile(root)}.lock`)) return false;
  const env = { ...process.env };
  delete env.NANOCLAW_SETUP_LOCK;
  delete env.NANOCLAW_TEMPLATE_AGENT_ID;
  const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "setup/slack-worker.ts")], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The Slack background worker could not start. Resume the Slack setup step."));
    }, 1e4);
    child.once("message", (message) => {
      if (message?.type !== "slack-worker-ready") return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("The Slack background worker failed to start. Resume the Slack setup step."));
    });
  });
  child.unref();
  return true;
}

// host-integration/setup/portal-runtime.ts
function startPortalRuntime({
  root = process.cwd(),
  signal,
  log = () => {
  },
  intervalMs = 5e3
} = {}) {
  const abort = new AbortController();
  const file = path2.join(root, "data/community-portal.json");
  let connection;
  let identity;
  let rejected = false;
  let release = null;
  let pending;
  let again = false;
  let dirty = true;
  let nextSync = 0;
  let stopped = false;
  let stopping;
  let lastError = "";
  const denied = (error) => [401, 403].includes(error.status);
  const rejectIdentity = () => {
    if (!rejected) log({ event: "sign_in_required" });
    rejected = true;
    dirty = true;
    connection?.stop();
    wake();
  };
  async function check() {
    release ||= await processLock3(path2.join(root, "data/community-portal-runtime.lock"));
    if (!release || stopped) return;
    const local = await readJson(file);
    if (local?.registryAccount?.token && (!local.installId || local.installId !== local.registryAccount.install_id || !local.deviceId || !local.privateKey || !local.origin)) {
      connection?.stop();
      connection = void 0;
      identity = void 0;
      throw Object.assign(new Error("Installation state is incomplete."), { code: "installation_state_invalid" });
    }
    const current = local?.registryAccount?.token && local.deviceId && local.privateKey && local.origin ? {
      origin: local.origin,
      installId: local.installId,
      deviceId: local.deviceId,
      privateKey: local.privateKey,
      registryAccount: local.registryAccount
    } : void 0;
    if (!isDeepStrictEqual(current, identity)) {
      connection?.stop();
      connection = void 0;
      identity = current;
      rejected = false;
      dirty = true;
      if (current) {
        const proof = new DeviceClient({
          origin: current.origin,
          token: current.registryAccount.token,
          file,
          signal: abort.signal
        });
        proof.local = current;
        connection = new CellConnection({
          origin: proof.origin,
          getTicket: async (requestSignal) => {
            try {
              return await proof.request("POST", "/api/v1/cell-ticket", {}, requestSignal);
            } catch (error) {
              if (denied(error) && isDeepStrictEqual(identity, current)) rejectIdentity();
              throw error;
            }
          },
          onChange: () => {
            dirty = true;
            wake();
          },
          log: (event) => log({ ...event, deviceId: current.deviceId })
        });
        connection.start();
      }
    }
    if (!current || stopped) return;
    const job = await readSlackJob(root);
    if (!rejected && job && job.identity.deviceId === current.deviceId && job.identity.registryAccount?.install_id === current.installId && job.identity.registryAccount?.account_id === current.registryAccount.account_id && job.origin === current.origin) {
      if (await launchSlackJob(root)) log({ event: "slack_install_resumed", deviceId: current.deviceId });
    }
    if (stopped || !dirty && Date.now() < nextSync) return;
    const client = new DeviceClient({
      origin: current.origin,
      file,
      exclusive: true,
      existingOnly: true,
      signal: abort.signal,
      log
    });
    try {
      await client.initialize();
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
      nextSync = Date.now() + 6e4;
    } catch (error) {
      if (error.code === "journal_busy") return;
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
    pending = check().then(() => {
      lastError = "";
    }).catch((error) => {
      if (stopped) return;
      const code = error.code || "unavailable";
      if (code !== lastError) log({ event: "runtime_retry", code });
      lastError = code;
    }).finally(() => {
      pending = void 0;
      if (again) {
        again = false;
        wake();
      }
    });
  }
  const timer = setInterval(wake, intervalMs);
  function stop() {
    if (stopping) return stopping;
    stopped = true;
    abort.abort();
    clearInterval(timer);
    connection?.stop();
    signal?.removeEventListener("abort", onAbort);
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
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) void stop();
  else wake();
  return { stop };
}
export {
  startPortalRuntime
};
