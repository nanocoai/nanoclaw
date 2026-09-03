/**
 * slack-agent-flow module — guarded re-registration of `create_agent`.
 *
 * Re-registers the delivery action with the SAME guard pieces as upstream
 * (agents.create decision, validateCreateAgent precheck) and a handler that
 * first runs the upstream `createAgent()` (with its premature success notify
 * suppressed on the Slack path — see slackAwareCreateAgent), then — only when
 * the request originated from a Slack session — provisions a dedicated Slack
 * bot for the new group (orchestrate.ts). The barrel imports this module AFTER
 * agent-to-agent's registration, so this entry wins; the expected boot log is
 * `Delivery action handler overwritten`. Approved replays re-enter this
 * wrapper automatically — reenterGuardedDeliveryAction resolves the entry at
 * call time, so no approval-handler re-registration is needed.
 *
 * Also registers the agent-facing room actions: `create_room` (one
 * MPIM with N bots + the operator over ensureAgentRoom) and `add_to_room`
 * (superset re-open — MPIM fork), each guard-wrapped with the same
 * cli_scope trust split as create_agent (./guard.ts, ./room-actions.ts).
 *
 * The handler never touches inbound DBs (guarded handlers replay without
 * one); all requester notifications go through the approvals module's
 * notifyAgent. Token values never appear in notify texts or logs.
 */
import { SlackApiError } from '../../channels/slack-lib.js';
import { reenterGuardedDeliveryAction, registerDeliveryAction, registerDeliveryBatchPreview } from '../../delivery.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getDestinationByName, normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import { createAgent, requestCreateAgentHold, validateCreateAgent } from '../agent-to-agent/create-agent.js';
import { agentsCreate } from '../agent-to-agent/guard.js';
import { notifyAgent, registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { roomsAddAgent, roomsCreate } from './guard.js';
import { dedupeSlug, deriveInstanceSlug, runSlackAgentFlow } from './orchestrate.js';
import {
  handleAddToRoom,
  handleCreateRoom,
  requestAddToRoomHold,
  requestCreateRoomHold,
  validateAddToRoom,
  validateCreateRoom,
} from './room-actions.js';
import { pendingInstall, prefetchAvatar, resolveProvisioningCredential } from './provision.js';
import { SlackFlowError } from './types.js';

/** The Slack gate: the request came in through a Slack-channel session. */
async function isSlackOriginSession(session: Session): Promise<boolean> {
  if (!session.messaging_group_id) return false;
  return (await getMessagingGroup(session.messaging_group_id))?.channel_type === 'slack';
}

// Avatar prefetch for multi-agent creates ("build me a team"): the batch
// preview sees every create_agent row in the session's outbound batch before
// they are processed sequentially, and starts all their avatar generations in
// parallel — each is an independent async Lambda on the broker, so N waits
// collapse to ~one (~23s). Gated on ≥2 creates: a single create starts its
// flow immediately anyway, and skipping the single case means a guard-HELD
// lone request never generates an avatar it might not get approval for.
// The (displayName, description) derivation MUST mirror runSlackAgentFlow /
// orchestrate exactly — a mismatch is harmless (fresh request) but wastes the
// prefetch.
registerDeliveryBatchPreview(async (batch, session) => {
  if (!(await isSlackOriginSession(session))) return;
  const creates = batch
    .filter((m) => m.kind === 'system')
    .map((m) => {
      try {
        return JSON.parse(m.content) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (c): c is Record<string, unknown> =>
        c !== null && c.action === 'create_agent' && typeof c.name === 'string' && c.name !== '',
    );
  if (creates.length < 2) return;
  const credential = resolveProvisioningCredential(process.cwd());
  if (credential?.mode !== 'broker') return;
  for (const c of creates) {
    prefetchAvatar(
      credential.baseUrl,
      credential.installToken,
      c.name as string,
      typeof c.instructions === 'string' ? c.instructions.slice(0, 300) : undefined,
    );
  }
  log.info('Avatar prefetch started for multi-create batch', { count: creates.length });
});

function successText(name: string, roomChannelId: string | undefined, deferredInstall = false): string {
  // The user already knows they were waiting on their workspace — name what
  // unblocked it so the relay reads as an ending, not a fresh announcement.
  const installed = deferredInstall ? ' The workspace approved the install, which is what the wait was for.' : '';
  // room:'none': no shared room was opened — the multi-create
  // pattern finishes with one create_room naming every agent.
  if (roomChannelId === undefined) {
    return (
      `Agent "${name}" is live on Slack with its own bot and a DM with the operator. No shared room was ` +
      `opened (room:'none') — when the set is complete, open ONE room for all of them with create_room. ` +
      `It came online just now; if it doesn't respond within a minute, an operator can run: bash setup/lib/restart.sh` +
      installed
    );
  }
  return (
    `Agent "${name}" is live on Slack with its own bot. I opened a DM between it and the operator, ` +
    `and a shared room (${roomChannelId}) where you, I, and it can talk — @-mention it there to engage it. ` +
    `It came online just now; if it doesn't respond within a minute, an operator can run: bash setup/lib/restart.sh` +
    installed
  );
}

function failureText(
  name: string,
  localName: string,
  step: string,
  message: string,
  newAgentGroupId: string,
  slug: string,
  sourceGroupId: string,
  roomNone: boolean,
): string {
  // room:'none' must survive into the printed finish command too — omitting
  // it would make the retry grow a room the multi-create pattern skipped.
  return (
    `Agent "${name}" was created and is reachable via send_message({ to: "${localName}", ... }), ` +
    `but its Slack setup failed at step '${step}': ${message}. An operator can finish it with: ` +
    `pnpm exec tsx scripts/slack-agent-flow-finish.ts --group ${newAgentGroupId} --name ${slug} ` +
    `--source-group ${sourceGroupId}${roomNone ? ' --room none' : ''} [--origin-instance <key>] [--restart]`
  );
}

/** Run the Slack leg for an already-created agent group and report the outcome. */
async function runSlackLeg(
  content: Record<string, unknown>,
  session: Session,
  args: {
    name: string;
    localName: string;
    newAgentGroupId: string;
    slug: string;
  },
): Promise<void> {
  const { name, localName, newAgentGroupId, slug } = args;
  try {
    const r = await runSlackAgentFlow({ content, session, newAgentGroupId, slug });
    await notifyAgent(session, successText(name, r.roomChannelId, r.deferredInstall));
  } catch (err) {
    // SlackApiError carries the flow step id its call site passed to the
    // shared Slack lib — surface it like a typed flow step.
    const step = err instanceof SlackFlowError || err instanceof SlackApiError ? err.step : 'unknown';
    const message = err instanceof Error ? err.message : String(err);
    await notifyAgent(
      session,
      failureText(
        name,
        localName,
        step,
        message,
        newAgentGroupId,
        slug,
        session.agent_group_id,
        content.room === 'none',
      ),
    );
    log.error('slack-agent-flow failed', { step });
  }
}

async function slackAwareCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const localName = normalizeName(name);
  const before = await getDestinationByName(session.agent_group_id, localName);
  const slackOrigin = await isSlackOriginSession(session);

  // Resume, not collide: the agent group exists and its Slack app exists, but
  // the workspace never approved the install, so the flow parked. Asking for
  // the same agent again is how a user says "finish that" — take them back to
  // waiting on the app they already have rather than reporting a name clash
  // (upstream's answer) or provisioning a second one.
  if (slackOrigin && before?.target_type === 'agent' && name) {
    const slug = await dedupeSlug(deriveInstanceSlug(name), before.target_id);
    if (pendingInstall(process.cwd(), slug)) {
      await runSlackLeg(content, session, { name, localName, newAgentGroupId: before.target_id, slug });
      return;
    }
  }

  // Upstream behavior byte-for-byte on non-Slack sessions. On the Slack path
  // the upstream "created — you can now message it" success notify is
  // suppressed: it fires BEFORE Slack provisioning, so relaying it would
  // report "done" ~a minute early — this wrapper's successText/failureText
  // is the only completion signal. Upstream error notifies (collision,
  // invalid path) still fire either way.
  await createAgent(content, session, slackOrigin ? { suppressCreatedNotify: true } : undefined);

  const after = await getDestinationByName(session.agent_group_id, localName);
  // Creation bailed or collided — upstream already answered the requester.
  if (!after || after.target_type !== 'agent' || before) return;
  // Non-Slack sessions (and task/a2a sessions with no messaging group) behave exactly as upstream.
  if (!slackOrigin) return;

  await runSlackLeg(content, session, {
    name,
    localName,
    newAgentGroupId: after.target_id,
    slug: await dedupeSlug(deriveInstanceSlug(name), after.target_id),
  });
}

/**
 * Slack-aware hold: same payload shape as upstream ({ name, instructions })
 * so the approved replay re-enters this wrapper unchanged; only the card text
 * differs, telling the admin a Slack bot comes with the sub-agent.
 */
async function requestSlackCreateAgentHold(content: Record<string, unknown>, session: Session): Promise<void> {
  if (!(await isSlackOriginSession(session))) {
    await requestCreateAgentHold(content, session);
    return;
  }
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_agent',
    // allow_guests must survive the hold: the approved replay re-enters the
    // wrapper with this payload, and dropping it would silently upgrade a
    // guest-accessible request to the agent-view variant.
    payload: {
      name,
      instructions,
      ...(typeof content.purpose === 'string' ? { purpose: content.purpose } : {}),
      ...(content.allow_guests === true ? { allow_guests: true } : {}),
      // room:'none' must survive the hold too — dropping it would grow a
      // room the multi-create pattern deliberately skipped.
      ...(content.room === 'none' ? { room: 'none' } : {}),
    },
    title: `Create agent: ${name}`,
    question:
      `Agent "${sourceGroup.name}" wants to create a new sub-agent "${name}" AND provision a dedicated ` +
      `Slack bot for it (new Slack app, DM with you, and a shared three-way room). Approve?`,
  });
}

registerDeliveryAction('create_agent', slackAwareCreateAgent, {
  guardAction: agentsCreate,
  precheck: validateCreateAgent,
  requestHold: requestSlackCreateAgentHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `create_agent denied: ${reason}`),
});

// Agent-facing room actions — guard-wrapped like create_agent:
// global-scope groups act directly, everything else holds for the admin
// chain, and the approval continuation re-enters the same wrapped entry with
// the approval row as its grant.
registerDeliveryAction('create_room', handleCreateRoom, {
  guardAction: roomsCreate,
  precheck: validateCreateRoom,
  requestHold: requestCreateRoomHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `create_room denied: ${reason}`),
});
registerApprovalHandler('create_room', reenterGuardedDeliveryAction('create_room'));

registerDeliveryAction('add_to_room', handleAddToRoom, {
  guardAction: roomsAddAgent,
  precheck: validateAddToRoom,
  requestHold: requestAddToRoomHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `add_to_room denied: ${reason}`),
});
registerApprovalHandler('add_to_room', reenterGuardedDeliveryAction('add_to_room'));
