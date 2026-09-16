/**
 * Action-specific approval-card renderers for `access:'approval'` CLI commands.
 *
 * The dispatcher (dispatch.ts) gates approval-required commands behind an admin
 * card. By default that card just echoes the raw `ncl <command> <args>` line —
 * fine for a benign command, opaque for a sensitive one (a privilege change
 * shows a namespaced handle, no effect, no before/after).
 *
 * This module is the seam: a sensitive command registers a builder keyed by its
 * command name; the builder returns a structured `{ title, question }` the
 * dispatcher uses in place of the generic wording. Commands without a builder
 * render exactly as before. Role grant/revoke is the first consumer; the actual
 * role-change summary + wording lives in the permissions module so Issue C's
 * routing can reuse it.
 */
import { getMessagingGroup } from '../db/messaging-groups.js';
import { describeRoleChange, renderRoleChangeCard, type RoleChangeOp } from '../modules/permissions/role-change.js';
import type { Session } from '../types.js';

export interface ApprovalCard {
  title: string;
  question: string;
}

export interface ApprovalCardContext {
  command: string;
  args: Record<string, unknown>;
  agentName: string;
  session: Session;
}

type ApprovalCardBuilder = (ctx: ApprovalCardContext) => ApprovalCard;

const builders = new Map<string, ApprovalCardBuilder>();

/** Register a structured card builder for a specific `access:'approval'` command. */
export function registerApprovalCard(command: string, builder: ApprovalCardBuilder): void {
  builders.set(command, builder);
}

/**
 * Build a structured approval card for `ctx.command`, or undefined when no
 * builder is registered (dispatcher falls back to the generic raw-command card).
 */
export function buildApprovalCard(ctx: ApprovalCardContext): ApprovalCard | undefined {
  return builders.get(ctx.command)?.(ctx);
}

/** Reconstruct the raw command line for the card's secondary "Command:" detail. */
function rawCommandLine(command: string, args: Record<string, unknown>): string {
  const argStr = Object.entries(args)
    .map(([k, v]) => `--${k} ${v}`)
    .join(' ');
  return `ncl ${command}${argStr ? ' ' + argStr : ''}`;
}

/** Human-readable origin channel for a session, e.g. `slack (T012/C345)`. */
function channelOf(session: Session): string {
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (mg) return `${mg.channel_type} (${mg.platform_id})`;
  return session.messaging_group_id ?? 'direct (agent)';
}

// ── Registered builders ──

for (const op of ['grant', 'revoke'] as const satisfies readonly RoleChangeOp[]) {
  registerApprovalCard(`roles-${op}`, (ctx) => {
    const summary = describeRoleChange(op, ctx.args);
    return renderRoleChangeCard(summary, {
      agentName: ctx.agentName,
      channel: channelOf(ctx.session),
      commandLine: rawCommandLine(ctx.command, ctx.args),
    });
  });
}
