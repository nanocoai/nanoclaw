/**
 * CLI audit adapter (installed by add-audit-log) — owns how the dispatcher
 * describes itself to the audit log: the dispatch middleware plus the
 * CLI-specific actor/origin/resource mapping. Composed in dispatch.ts as
 * `export const dispatch = withAudit(dispatchInner)`; business logic there
 * contains zero audit calls.
 *
 * Recording model: the log stores WHO did WHICH action to WHAT target and the
 * outcome — never raw argument VALUES. `dimensions` carries only the arg key
 * names that were passed. There is no value redactor because free-form values
 * never cross this adapter. Target identifiers (ids, users, groups) are
 * structural and surface separately in `resources`.
 *
 * Loading this module registers audit startup through the inert host lifecycle;
 * no database or network work runs during barrel import. Missing PostgreSQL
 * composition or a pending module migration refuses startup. Once started, an
 * individual audit-write failure is awaited, reported, and isolated from the
 * business response without an ambiguous-commit retry.
 */
import { AUDIT_ENABLED } from '../audit/config.js';
import { mapNclAction } from '../audit/activity-mappers.js';
import { emitAuditEvent } from '../audit/emit.js';
import '../audit/init.js';
import { emitSuccessfulCliSemantics } from '../audit/runtime-emitters.js';
import {
  HOST_AUDIT_ARG_NAME_RE,
  hostAuditResourceRef,
  type AuditActor,
  type AuditEventInput,
  type AuditOutcome,
  type HostAuditErrorCode,
  type HostAuditDimensions,
  type HostAuditResourceRef,
  type HostAuditResourceType,
} from '../audit/types.js';
import { containerDimensions, hostUser } from '../audit/vocab.js';
import { getPendingApprovalsByAction } from '../db/sessions.js';
import { log } from '../log.js';
import type { PendingApproval } from '../types.js';
import type { CallerContext, RequestFrame, ResponseFrame } from './frame.js';
import { commandGuardAction } from './guard.js';
import { type CommandDef, lookup } from './registry.js';

// ── CLI mapping ──

/**
 * Host callers stamp `host:<install user>` daemon-side (the ncl socket is
 * 0600 and owned by the install user); container callers are their agent group.
 */
export function actorForCaller(ctx: CallerContext): AuditActor {
  return ctx.caller === 'host' ? { type: 'human', id: `host:${hostUser()}` } : { type: 'agent', id: ctx.agentGroupId };
}

export async function dimensionsForCaller(ctx: CallerContext): Promise<HostAuditDimensions> {
  if (ctx.caller === 'host') return { transport: 'socket' };
  return await containerDimensions(ctx.messagingGroupId || null);
}

/**
 * Frame-level args use `--hyphen-keys`; recorded key names use the same
 * underscore form the parsed handlers see. Mirrors crud's normalizeArgs
 * (kept local so audit doesn't depend on a module tests commonly mock).
 */
export function normalizeArgKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.replace(/-/g, '_')] = v;
  }
  return out;
}

/** Every live ncl resource plural mapped into the closed audit vocabulary. */
export const HOST_AUDIT_CLI_RESOURCE_TYPES = {
  approvals: 'approval',
  audit: 'audit_event',
  destinations: 'destination',
  'dropped-messages': 'dropped_message',
  groups: 'agent_group',
  members: 'member',
  'messaging-groups': 'messaging_group',
  policies: 'policy',
  roles: 'role',
  sessions: 'session',
  tasks: 'task',
  'user-dms': 'user_dm',
  users: 'user',
  wirings: 'wiring',
} as const satisfies Readonly<Record<string, HostAuditResourceType>>;

/**
 * Derive touched/attempted resources from a command's args. Generic by design:
 * `id` → the command's own resource, group/user args → their types, and a bare
 * `{type}` entry when nothing else is known (a denied `users list` still names
 * what was attempted). Ids are structured identifiers, not secrets.
 */
export function resourcesForCli(cmd: CommandDef, args: Record<string, unknown>): HostAuditResourceRef[] {
  if (!cmd.resource) return [];
  const type = (HOST_AUDIT_CLI_RESOURCE_TYPES as Readonly<Record<string, HostAuditResourceType>>)[cmd.resource];
  if (!type) return [];

  const out: HostAuditResourceRef[] = [];
  const push = (resourceType: HostAuditResourceType, identifier: unknown): void => {
    if (typeof identifier !== 'string') return;
    const ref = hostAuditResourceRef(resourceType, identifier);
    if (ref && !out.includes(ref)) out.push(ref);
  };
  push(type, args.id);
  push('agent_group', args.agent_group_id ?? args.group);
  push('user', args.user);
  if (out.length === 0) out.push(type);
  return out.slice(0, 16);
}

/** Collapse live dispatcher errors into the stable, privacy-safe wire enum. */
export function normalizeNclAuditErrorCode(errorCode: string): HostAuditErrorCode | null {
  switch (errorCode) {
    case 'approval-pending':
      return null;
    case 'unknown-command':
      return 'unknown-command';
    case 'forbidden':
      return 'forbidden';
    case 'invalid-args':
    case 'handler-error':
    case 'transport-error':
    default:
      return 'command-failed';
  }
}

// ── Command resolution, mirrored for the record ──
// Dispatch resolves the command on a local copy of the frame that never leaves
// it, so the middleware mirrors the one documented mechanic below. The mirror
// is mechanical, and drift only ever degrades a record's detail (a fallback
// action name) — never dispatch behavior, and never an outcome.

/**
 * Mirror of dispatch's command resolution: exact lookup, then the longest
 * registered dash-prefix with the remainder recorded as --id.
 */
function resolveForRecord(req: RequestFrame): { cmd?: CommandDef; args: Record<string, unknown> } {
  const direct = lookup(req.command);
  if (direct) return { cmd: direct, args: req.args };
  let shortened = req.command;
  let idx: number;
  while ((idx = shortened.lastIndexOf('-')) > 0) {
    shortened = shortened.slice(0, idx);
    const fallback = lookup(shortened);
    if (fallback) {
      const tail = req.command.slice(shortened.length + 1);
      return { cmd: fallback, args: { ...req.args, id: req.args.id ?? tail } };
    }
  }
  return { args: req.args };
}

/**
 * The approval row a hold just created for this frame — it gives the pending
 * event the same dimensions.correlation_id the approved replay will carry as its guard
 * grant. requestApproval keeps the minted id internal, so the row is
 * recovered by the frame id it stored in its payload; no row (e.g. no
 * configured approver) → the hold is still recorded, uncorrelated.
 */
async function holdApprovalIdFor(frameId: string): Promise<string | null> {
  const rows = await getPendingApprovalsByAction('cli_command');
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      const payload = JSON.parse(rows[i].payload) as { frame?: { id?: string } };
      if (payload.frame?.id === frameId) return rows[i].approval_id;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a row with an unparseable payload is simply not this frame's hold
    } catch {
      continue;
    }
  }
  return null;
}

// ── The dispatch middleware ──

type DispatchInner = (
  req: RequestFrame,
  ctx: CallerContext,
  opts?: { grant?: PendingApproval },
) => Promise<ResponseFrame>;

/**
 * Build the audit record for one dispatch. `res` is the response frame, or
 * null when `inner` threw (`err` set) — a crash still leaves a record.
 *
 * Outcome: ok → success (or `approved` when a grant drove the replay),
 * forbidden → denied (captures pre-handler scope denials), approval-pending →
 * pending (the record of a hold), a thrown/other error → failure. A `--help`
 * probe is introspection, not the verb, so it records under a neutral
 * `cli.help` action with no target — never as the real command succeeding.
 * Correlation is the approval id: a replay carries the row as its grant, and a
 * fresh hold recovers the row it just created.
 */
async function buildEvent(
  req: RequestFrame,
  ctx: CallerContext,
  opts: { grant?: PendingApproval },
  res: ResponseFrame | null,
  err: unknown,
): Promise<AuditEventInput | null> {
  const resolved = resolveForRecord(req);
  const cmd = resolved.cmd;
  const normArgs = normalizeArgKeys(resolved.args);

  const isHelp = req.args.help === true && !!res && res.ok;
  const pending = !!res && !res.ok && res.error.code === 'approval-pending';
  const approved = !!res && res.ok && !!opts.grant && !isHelp;

  const outcome: AuditOutcome = !res
    ? 'failure' // inner threw
    : res.ok
      ? approved
        ? 'approved'
        : 'success'
      : res.error.code === 'forbidden'
        ? 'denied'
        : pending
          ? 'pending'
          : 'failure';

  // Dimensions keep arg key names only. Even enum-looking values are caller
  // controlled and therefore remain outside durable reporting evidence.
  const origin = await dimensionsForCaller(ctx);
  const argNames = Object.keys(normArgs)
    .filter((key) => HOST_AUDIT_ARG_NAME_RE.test(key))
    .sort()
    .slice(0, 32);
  let errorCode: HostAuditErrorCode | null = null;
  if (err) {
    errorCode = 'exception'; // the throw's message is never stored
  } else if (res && !res.ok && !pending) {
    errorCode = normalizeNclAuditErrorCode(res.error.code);
  }

  const correlationId = opts.grant?.approval_id ?? (pending ? await holdApprovalIdFor(req.id) : null);

  const action = isHelp ? 'cli.help' : cmd ? commandGuardAction(cmd) : 'cli.unknown-command';
  const resources = isHelp ? [] : cmd ? resourcesForCli(cmd, normArgs) : [];
  const approvalRef = correlationId ? hostAuditResourceRef('approval', correlationId) : null;
  if (approvalRef && resources.length < 16) resources.push(approvalRef);

  return mapNclAction({
    actor: actorForCaller(ctx),
    agentId: ctx.caller === 'agent' ? ctx.agentGroupId : null,
    sessionId: ctx.caller === 'agent' ? ctx.sessionId : null,
    origin,
    action,
    outcome,
    argNames,
    resourceRefs: resources,
    correlationId,
    errorCode,
  });
}

/**
 * Async DB lookups enrich container origin and approval correlation on current
 * NanoClaw. Keep those reads inside the same fail-open boundary as the append:
 * an unavailable enrichment read must not change the audited command result.
 */
async function emitDispatchEvent(
  req: RequestFrame,
  ctx: CallerContext,
  opts: { grant?: PendingApproval },
  res: ResponseFrame | null,
  err: unknown,
): Promise<void> {
  if (!AUDIT_ENABLED) return;
  try {
    const event = await buildEvent(req, ctx, opts, res, err);
    if (event) await emitAuditEvent(event);
    if (res?.ok && !err) {
      await emitSuccessfulCliSemantics({
        command: req.command,
        args: normalizeArgKeys(req.args),
        responseData: res.data,
        actor: actorForCaller(ctx),
        agentId: ctx.caller === 'agent' ? ctx.agentGroupId : null,
        sessionId: ctx.caller === 'agent' ? ctx.sessionId : null,
        transport: ctx.caller === 'agent' ? 'container' : 'socket',
      });
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- audit enrichment and append are fail-open by contract
  } catch (auditErr) {
    log.error('Audit event derivation failed — action proceeding (fail-open)', {
      command: req.command,
      err: auditErr,
    });
  }
}

/**
 * Dispatch middleware — the exported `dispatch` is the wrapped function, so
 * the socket server, the container delivery-action, and the in-module
 * approved replay are all covered by the one composition.
 *
 * The emit brackets `inner` so a thrown dispatcher still leaves a record: on
 * throw we emit a `failure` event and re-raise unchanged, so an approval-gated
 * command whose hold crashes on the DB write is not a silent governance gap.
 */
export function withAudit(inner: DispatchInner): DispatchInner {
  return async (req, ctx, opts = {}) => {
    let res: ResponseFrame;
    try {
      res = await inner(req, ctx, opts);
    } catch (err) {
      await emitDispatchEvent(req, ctx, opts, null, err);
      throw err;
    }
    await emitDispatchEvent(req, ctx, opts, res, null);
    return res;
  };
}
