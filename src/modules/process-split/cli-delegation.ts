/**
 * Cross-plane CLI dispatch — how the gateway asks and the controller answers.
 *
 * Recipes overlay module (process-split skill). Agent mailbox `cli_request`
 * frames are picked up by the delivery poll, and delivery runs on the gateway
 * plane — but the surfaces several resources dispatch INTO exist only on the
 * controller: the dev-env driver registry (envs, stamps), the container
 * runtime and door sessions (sandboxes, groups). A split relay dispatching
 * `envs-list` answers the driver's own refusal — "dev-env is not enabled on
 * this host" — with the driver alive one pod over (measured: the
 * stanford-demo bring-up, PR #323 finding #19; ~6s relay pickup, wrong-plane
 * refusal in the response frame).
 *
 * Same doctrine as the wake and DM seams: the request is a row, never RPC.
 * The gateway's `cli_request` handler defers controller-owned commands as a
 * durable `controller_cli_requests` row; the controller's consumer polls,
 * claims, dispatches with its full in-process surface (same guard, same
 * agent actor), and writes the `cli-resp-<requestId>` frame to the session's
 * inbound mailbox byte-identically to the local path — the in-container
 * client cannot tell the planes apart. A dispatch that never lands keeps the
 * trunk contract: the client's bounded poll lapses to its own timeout error,
 * exactly as a slow local dispatch always could.
 *
 * In role 'all' none of this engages: every surface is in-process, the
 * handler's local dispatch runs verbatim, and no consumer is started.
 */
import type { CallerContext, RequestFrame } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getHostInstanceId } from '../../host-instance.js';
import { log } from '../../log.js';

registerMigration({
  // Module migrations order by registration, not version; the field is
  // informational. One row per request id: mailbox redelivery of the same
  // frame is an upsert (claim cleared), never a duplicate dispatch queue.
  version: 1,
  name: 'module:process-split:controller-cli-requests',
  async up(db) {
    await db.exec(`
      CREATE TABLE controller_cli_requests (
        request_id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        claimed_by TEXT,
        claimed_at TEXT
      );
    `);
  },
});

/**
 * The resources whose dispatch surface lives on the controller plane, BY
 * MECHANISM, not preference:
 *
 *   envs, stamps — the dev-env driver registry; its lifecycle is
 *     controller-gated by this same skill ("the tokenless relay would start
 *     dev-env and die on its first Kubernetes call"), so on the relay these
 *     verbs can only ever refuse.
 *   sandboxes, groups — container lifecycle and the door's session runtime;
 *     the runtime registry lives with the containers.
 *
 * Everything else stays local to the plane that picked the frame up: the
 * registry carries no plane metadata (the trunk is split-unaware), DB-backed
 * resources work anywhere the central database is, and user-dms needs the
 * channel adapter — which is the gateway's own. An explicit list is the
 * honest spelling of that until the registry learns ownership.
 */
const CONTROLLER_OWNED_RESOURCES = ['envs', 'stamps', 'sandboxes', 'groups'] as const;

/** Registry commands are dash-joined ("envs-list", "stamps-set-pool") — match
 *  the resource token exactly or as a dash-prefix, never substrings. */
export function isControllerOwnedCommand(command: string): boolean {
  return CONTROLLER_OWNED_RESOURCES.some(
    (resource) => command === resource || command.startsWith(`${resource}-`),
  );
}

/** The agent variant is the only caller that can arrive by mailbox. */
type AgentCallerContext = Extract<CallerContext, { caller: 'agent' }>;

/**
 * Gateway side: record the durable ask. The response's whole journey back is
 * the controller's — this plane writes nothing further for the request.
 */
export async function deferCliRequestToController(req: RequestFrame, ctx: AgentCallerContext): Promise<void> {
  await getDb().run(
    `INSERT INTO controller_cli_requests
       (request_id, command, args_json, session_id, agent_group_id, messaging_group_id, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (request_id) DO UPDATE SET
       command = excluded.command,
       args_json = excluded.args_json,
       session_id = excluded.session_id,
       agent_group_id = excluded.agent_group_id,
       messaging_group_id = excluded.messaging_group_id,
       requested_at = excluded.requested_at,
       claimed_by = NULL,
       claimed_at = NULL`,
    req.id,
    req.command,
    JSON.stringify(req.args ?? {}),
    ctx.sessionId,
    ctx.agentGroupId,
    ctx.messagingGroupId,
    new Date().toISOString(),
  );
}

const CONSUMER_POLL_MS = 2_000;
/** A claim older than this is a crashed consumer's; re-claimable. ISO stamps
 *  compared lexicographically, caller clocks — the coordination-table rule. */
const STALE_CLAIM_MS = 60_000;

let consumerTimer: NodeJS.Timeout | null = null;
let consumerBusy = false;

/** Controller side: serve the gateway's deferred CLI requests. Runs only in
 *  the split controller; mirror of the gateway's DM-resolution consumer. */
export function startCliDispatchConsumer(pollMs: number = CONSUMER_POLL_MS): void {
  if (consumerTimer) throw new Error('CLI-dispatch consumer already started');
  consumerTimer = setInterval(() => {
    if (consumerBusy) return; // a slow poll must not stack another behind it
    consumerBusy = true;
    void consumeCliRequestsOnce().finally(() => {
      consumerBusy = false;
    });
  }, pollMs);
  consumerTimer.unref?.();
}

export function stopCliDispatchConsumer(): void {
  if (consumerTimer) {
    clearInterval(consumerTimer);
    consumerTimer = null;
  }
}

interface ControllerCliRequestRow {
  request_id: string;
  command: string;
  args_json: string;
  session_id: string;
  agent_group_id: string;
  messaging_group_id: string;
}

/** One consumer pass. Exported for tests; never throws. */
export async function consumeCliRequestsOnce(): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- the consumer is a background loop; a failed pass costs latency and the client's bounded poll covers it */
  try {
    const db = getDb();
    const now = new Date();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
    const consumerId = getHostInstanceId() ?? 'controller';
    const pending = await db.all<ControllerCliRequestRow>(
      `SELECT request_id, command, args_json, session_id, agent_group_id, messaging_group_id
       FROM controller_cli_requests
       WHERE claimed_at IS NULL OR claimed_at < ? ORDER BY requested_at`,
      staleBefore,
    );
    if (pending.length === 0) return;
    // Lazy imports keep module init acyclic: delivery-action imports this
    // module for the gateway branch; only the controller's consumer needs the
    // dispatcher and the mailbox writer back.
    const { dispatch } = await import('../../cli/dispatch.js');
    const { writeSessionMessage } = await import('../../session-manager.js');
    for (const request of pending) {
      const claim = await db.run(
        `UPDATE controller_cli_requests SET claimed_by = ?, claimed_at = ?
         WHERE request_id = ? AND (claimed_at IS NULL OR claimed_at < ?)`,
        consumerId,
        nowIso,
        request.request_id,
        staleBefore,
      );
      if (claim.changes === 0) continue; // another consumer took it
      const req: RequestFrame = {
        id: request.request_id,
        command: request.command,
        args: JSON.parse(request.args_json) as Record<string, unknown>,
      };
      const ctx: CallerContext = {
        caller: 'agent',
        sessionId: request.session_id,
        agentGroupId: request.agent_group_id,
        messagingGroupId: request.messaging_group_id,
      };
      log.info('CLI request from agent (deferred from the gateway plane)', {
        requestId: request.request_id,
        command: request.command,
        sessionId: request.session_id,
      });
      const response = await dispatch(req, ctx);
      // The response envelope is delivery-action's, byte for byte — same id,
      // same kind, same content shape, no wake. The in-container client polls
      // findCliResponse and must not be able to tell which plane answered.
      await writeSessionMessage(request.agent_group_id, request.session_id, {
        id: `cli-resp-${request.request_id}`,
        kind: 'system',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({
          type: 'cli_response',
          requestId: request.request_id,
          frame: response,
        }),
        trigger: false,
      });
      log.info('CLI response written', {
        requestId: request.request_id,
        ok: response.ok,
        sessionId: request.session_id,
      });
      // Delete after the response is durable: a crash between dispatch and
      // write leaves the claim to go stale and the request to re-dispatch —
      // command handlers are the same ones a retried socket call reaches, and
      // the client's correlation id makes the second response a no-op.
      await db.run('DELETE FROM controller_cli_requests WHERE request_id = ?', request.request_id);
    }
  } catch (err) {
    log.warn('CLI-dispatch consumer pass failed', { err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
