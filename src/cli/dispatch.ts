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
import { localizeIsoTimestamps } from './format.js';
import { getResource } from './crud.js';
import { listVerbs, renderVerbHelp } from './help-render.js';
import { GROUP_SCOPE_RESOURCES, listCommands, lookup } from './registry.js';

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

  // Fallback: if the full command isn't registered, find the LONGEST registered
  // command that is a dash-prefix of req.command; the remainder is the target ID,
  // kept intact (dashes and all). This lets clients join all positional args with
  // dashes — e.g. `ncl groups get abc123` → "groups-get-abc123" → "groups-get" +
  // id "abc123", and crucially `ncl tasks cancel task-374f-...-442` →
  // "tasks-cancel" + id "task-374f-...-442" (a dashed id is no longer shredded).
  // Trimming from the end (longest→shortest) means a multi-segment verb like
  // "groups-config-add-mcp-server" still matches before any shorter prefix.
  if (!cmd) {
    let shortened = req.command;
    let idx: number;
    while ((idx = shortened.lastIndexOf('-')) > 0) {
      shortened = shortened.slice(0, idx);
      const fallback = lookup(shortened);
      if (fallback) {
        const tail = req.command.slice(shortened.length + 1); // full remainder = id, dashes intact
        cmd = fallback;
        req = { ...req, command: shortened, args: { ...req.args, id: req.args.id ?? tail } };
        break;
      }
    }
  }

  if (!cmd) {
    return err(req.id, 'unknown-command', unknownCommandMessage(req.command));
  }

  // CLI scope enforcement for agent callers
  if (ctx.caller === 'agent') {
    const configRow = getContainerConfig(ctx.agentGroupId);
    const cliScope = configRow?.cli_scope ?? 'group';

    if (cliScope === 'disabled') {
      return err(req.id, 'forbidden', 'CLI access is disabled for this agent group.');
    }

    if (cliScope === 'group') {
      // Only allow whitelisted resources and general commands (no resource, like help)
      if (cmd.resource && !GROUP_SCOPE_RESOURCES.has(cmd.resource)) {
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

  // `--help` interception: answer with the command's generated help instead of
  // executing. Placed after scope enforcement (a group-scoped agent can't probe
  // forbidden resources) and BEFORE approval gating — asking for help on an
  // approval-gated verb must never mint an approval card.
  if (req.args.help === true) {
    // Carry the help text in `human` too, so both clients print it verbatim
    // as clean multi-line text instead of a JSON-stringified blob.
    const helpText = commandHelp(cmd.name, cmd.resource, cmd.description);
    return { id: req.id, ok: true, data: helpText, human: helpText };
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

    // Server-render the human view once, so every transport — host CLI and
    // the Bun container client (which can't import host formatters) — prints
    // one canonical rendering. Runs after scope filtering; a throwing
    // formatter degrades to plain `data`, never fails the response.
    if (cmd.formatHuman) {
      try {
        return { id: req.id, ok: true, data, human: cmd.formatHuman(data) };
      } catch {
        // fall through to the plain frame
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
    const localized = localizeIsoTimestamps(response.data);
    const data = typeof localized === 'string' ? localized : JSON.stringify(localized, null, 2);
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

/** Help text for a resolved command: deep verb help when derivable, else description. */
function commandHelp(name: string, resource: string | undefined, description: string): string {
  if (resource && name.startsWith(`${resource}-`)) {
    const res = getResource(resource);
    const verb = name.slice(resource.length + 1);
    const deep = res && renderVerbHelp(res, verb);
    if (deep) return deep;
    // Custom-operation KEYS may contain spaces ('config update') while command
    // names are dash-joined ('groups-config-update'). Resolve by matching keys
    // normalized the same way registerResource builds command names.
    if (res?.customOperations) {
      const spaced = Object.keys(res.customOperations).find((k) => k.replace(/ /g, '-') === verb);
      const deepSpaced = spaced && renderVerbHelp(res, spaced);
      if (deepSpaced) return deepSpaced;
    }
  }
  return description;
}

/**
 * Unknown-command error that carries its fix: if the command names a known
 * resource, list that resource's verbs; otherwise suggest the closest
 * registered command. Resource detection walks dash-prefixes longest-first,
 * same as the ID fallback above, so multi-word plurals (messaging-groups,
 * user-dms) resolve.
 */
function unknownCommandMessage(command: string): string {
  const parts = command.split('-');
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join('-');
    const res = getResource(prefix);
    if (res) {
      return (
        `no command "${command}" — verbs for ${res.plural}: ${listVerbs(res).join(', ')}. ` +
        `Run \`ncl ${res.plural} help <verb>\` for flags and examples.`
      );
    }
  }
  const names = listCommands()
    .filter((c) => c.access !== 'hidden')
    .map((c) => c.name);
  const closest = closestName(command, names);
  return `no command "${command}"${closest ? ` — did you mean "${closest}"?` : ''} Run \`ncl help\`.`;
}

/** Closest name by edit distance, only when convincingly close (≤2 edits). */
function closestName(input: string, names: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const name of names) {
    if (Math.abs(name.length - input.length) >= bestDist) continue;
    const d = editDistance(input, name, bestDist);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

function editDistance(a: string, b: string, cap: number): number {
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      rowMin = Math.min(rowMin, prev[j]);
    }
    if (rowMin >= cap) return cap;
  }
  return prev[b.length];
}

function err(id: string, code: ErrorCode, message: string): ResponseFrame {
  return { id, ok: false, error: { code, message } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
