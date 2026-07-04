/**
 * Transport-agnostic dispatcher. Both the socket server (host caller) and
 * the per-session DB poller (container caller) call dispatch() with the
 * same frame and a transport-supplied CallerContext.
 *
 * Approval gating for risky calls from the container is the only branch
 * that differs by caller. Host callers and `open` commands run inline.
 */
import { getContainerConfig } from '../db/container-configs.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getSession } from '../db/sessions.js';
import { registerApprovalHandler, requestApproval } from '../modules/approvals/index.js';
import type { CallerContext, ErrorCode, RequestFrame, ResponseFrame } from './frame.js';
import { getResource } from './crud.js';
import { lookup } from './registry.js';

type DispatchOptions = {
  /** True when a command is being replayed after approval. */
  approved?: boolean;
};

export async function dispatch(
  req: RequestFrame,
  ctx: CallerContext,
  opts: DispatchOptions = {},
): Promise<ResponseFrame> {
  let cmd = lookup(req.command);

  // Fallback: if the full command isn't registered, split the dash-joined
  // command and treat the longest registered prefix as the command, with the
  // re-joined remainder as the target ID. Clients join all positional args
  // with dashes (e.g. `ncl groups get abc123` → command "groups-get-abc123"),
  // and generated ids (UUIDs, `sess-…`, `appr-…`) themselves contain dashes,
  // so trimming a single trailing segment isn't enough — walk prefixes from
  // longest to shortest so `groups-get-<uuid-with-dashes>` still resolves to
  // "groups-get" + id "<uuid-with-dashes>".
  if (!cmd) {
    const parts = req.command.split('-');
    for (let i = parts.length - 1; i > 0; i--) {
      const shortened = parts.slice(0, i).join('-');
      const fallback = lookup(shortened);
      if (fallback) {
        const tail = parts.slice(i).join('-');
        cmd = fallback;
        req = { ...req, command: shortened, args: { ...req.args, id: req.args.id ?? tail } };
        break;
      }
    }
  }

  if (!cmd) {
    return err(req.id, 'unknown-command', `no command "${req.command}"`);
  }

  // CLI scope enforcement for agent callers
  if (ctx.caller === 'agent') {
    const configRow = getContainerConfig(ctx.agentGroupId);
    const cliScope = configRow?.cli_scope ?? 'group';

    if (cliScope === 'disabled') {
      return err(req.id, 'forbidden', 'CLI access is disabled for this agent group.');
    }

    if (cliScope === 'group') {
      const allowed = new Set(['groups', 'sessions', 'destinations', 'members']);
      // Only allow whitelisted resources and general commands (no resource, like help)
      if (cmd.resource && !allowed.has(cmd.resource)) {
        return err(req.id, 'forbidden', `CLI access is scoped to this agent group. Cannot access "${cmd.resource}".`);
      }

      // Enforce group scope on all agent-group-related args.
      // Different resources use different arg names for the agent group ID.
      // Only check --id for resources where it IS the agent group ID.
      const groupArgs = ['agent_group_id', 'group'] as const;
      for (const key of groupArgs) {
        if (req.args[key] && req.args[key] !== ctx.agentGroupId) {
          return err(req.id, 'forbidden', 'CLI access is scoped to this agent group.');
        }
      }
      if (
        (cmd.resource === 'groups' || cmd.resource === 'destinations') &&
        req.args.id &&
        req.args.id !== ctx.agentGroupId
      ) {
        return err(req.id, 'forbidden', 'CLI access is scoped to this agent group.');
      }

      // Block cli_scope changes from group-scoped agents (privilege escalation)
      if (req.args.cli_scope !== undefined || req.args['cli-scope'] !== undefined) {
        return err(req.id, 'forbidden', 'Cannot change cli_scope from a group-scoped agent.');
      }

      // Auto-fill agent-group-related args so the agent doesn't need
      // to pass its own group ID explicitly.
      const fill: Record<string, unknown> = {
        agent_group_id: req.args.agent_group_id ?? ctx.agentGroupId,
        group: req.args.group ?? ctx.agentGroupId,
      };
      // Only auto-fill --id for resources where it IS the agent group ID
      // (groups, destinations). For sessions/members --id is a different key.
      if (cmd.resource === 'groups' || cmd.resource === 'destinations') {
        fill.id = req.args.id ?? ctx.agentGroupId;
      }
      req = { ...req, args: { ...req.args, ...fill } };

      // Fail-closed pre-handler check for sessions-get: returns "not found"
      // regardless of whether the UUID exists in another group, preventing an
      // existence oracle across group boundaries.
      if (cmd.resource === 'sessions' && req.command === 'sessions-get' && req.args.id) {
        const s = getSession(req.args.id as string);
        if (!s || s.agent_group_id !== ctx.agentGroupId) {
          return err(req.id, 'handler-error', `session not found: ${req.args.id}`);
        }
      }
    }
  }

  if (ctx.caller !== 'host' && cmd.access === 'approval' && !opts.approved) {
    const session = getSession(ctx.sessionId);
    if (!session) {
      return err(req.id, 'handler-error', 'Session not found.');
    }
    const agentGroup = getAgentGroup(ctx.agentGroupId);
    const agentName = agentGroup?.name ?? ctx.agentGroupId;

    const argSummary = Object.entries(req.args)
      .map(([k, v]) => `--${k} ${v}`)
      .join(' ');

    await requestApproval({
      session,
      agentName,
      action: 'cli_command',
      payload: { frame: { id: req.id, command: req.command, args: req.args }, callerContext: ctx },
      title: `CLI: ${req.command}`,
      question: `Agent "${agentName}" wants to run:\n\`ncl ${req.command}${argSummary ? ' ' + argSummary : ''}\``,
    });

    return err(req.id, 'approval-pending', 'Approval request sent to admin. You will be notified of the result.');
  }

  let parsed: unknown;
  try {
    parsed = cmd.parseArgs(req.args);
  } catch (e) {
    return err(req.id, 'invalid-args', errMsg(e));
  }

  try {
    let data = await cmd.handler(parsed, ctx);

    // Post-handler group-scope enforcement. Applies only to the auto-generated
    // `list` / `get` handlers (`cmd.generic`), which return raw DB rows carrying
    // the resource's `scopeField`:
    //   - `list` → drop rows that don't belong to the caller's agent group
    //              (covers `groups list`, where the generic list handler ignores
    //              the auto-filled `--id`)
    //   - `get`  → reject if the single row belongs to another group
    // Custom operations return ad-hoc shapes (e.g. `groups config get` → a config
    // object with no `id`) and are NOT checked here — they would be falsely
    // rejected, and they're already pinned to the caller's group by the
    // pre-handler `--id` auto-fill (groups/destinations) or gated behind approval,
    // so they can't reach another group's data anyway.
    if (ctx.caller === 'agent' && cmd.resource && cmd.generic) {
      const configRow = getContainerConfig(ctx.agentGroupId);
      if ((configRow?.cli_scope ?? 'group') === 'group') {
        const def = getResource(cmd.resource);
        const groupField = def?.scopeField;
        if (!groupField) {
          // Fail closed: a whitelisted resource exposing list/get must declare
          // `scopeField` so its rows can be filtered.
          return err(req.id, 'forbidden', `"${cmd.resource}" is not available in group scope.`);
        }
        if (Array.isArray(data)) {
          data = data.filter(
            (row) =>
              typeof row === 'object' &&
              row !== null &&
              (row as Record<string, unknown>)[groupField] === ctx.agentGroupId,
          );
        } else if (data && typeof data === 'object') {
          if ((data as Record<string, unknown>)[groupField] !== ctx.agentGroupId) {
            return err(req.id, 'forbidden', 'Resource belongs to a different agent group.');
          }
        }
      }
    }

    return { id: req.id, ok: true, data };
  } catch (e) {
    return err(req.id, 'handler-error', errMsg(e));
  }
}

registerApprovalHandler('cli_command', async ({ payload, notify }) => {
  const frame = payload.frame as RequestFrame;
  const callerContext = parseCallerContext(payload.callerContext) ?? { caller: 'host' };
  const response = await dispatch(frame, callerContext, { approved: true });

  if (response.ok) {
    const data = typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
    notify(`Your \`ncl ${frame.command}\` request was approved and executed.\n\n${data}`);
  } else {
    notify(`Your \`ncl ${frame.command}\` request was approved but failed: ${response.error.message}`);
  }
});

function parseCallerContext(value: unknown): CallerContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.caller === 'host') return { caller: 'host' };
  if (
    record.caller === 'agent' &&
    typeof record.sessionId === 'string' &&
    typeof record.agentGroupId === 'string' &&
    typeof record.messagingGroupId === 'string'
  ) {
    return {
      caller: 'agent',
      sessionId: record.sessionId,
      agentGroupId: record.agentGroupId,
      messagingGroupId: record.messagingGroupId,
    };
  }
  return undefined;
}

function err(id: string, code: ErrorCode, message: string): ResponseFrame {
  return { id, ok: false, error: { code, message } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
