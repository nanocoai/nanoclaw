/**
 * `ncl sandboxes new | list | attach` — the sandbox lifecycle verbs.
 *
 * A sandbox IS a code-mode agent group. The lifecycle itself lives in
 * code-mode/sandboxes.ts (create, list, attach); this resource parses the
 * verb's arguments, renders, and hands the attach over to the ncl client,
 * which owns the terminal and execs the attach client into the session.
 *
 * All three verbs are hostOnly + 'open': the socket IS the auth boundary
 * (a host caller is the operator), and the guard refuses every agent
 * caller before a handler runs — the identity story is unchanged.
 */
import {
  createSandbox,
  findSandboxGroup,
  listSandboxes,
  NEW_SANDBOX_WAKE_WAIT_MS,
  type SandboxListRow,
} from '../../code-mode/sandboxes.js';
import { renderSeamRefusals } from '../../seams.js';
import { collectSandboxDiff } from '../../code-mode/surface/diff-view.js';
import { sandboxStatus, type SandboxStatus } from '../../code-mode/surface/index.js';
import { interruptCodingSession } from '../../code-mode/surface/stop.js';
import type { AgentGroup } from '../../types.js';
import { resolveAttachForGroup } from '../attach-resolve.js';
import { registerResource } from '../crud.js';

/** id-first, then folder — the attach resolution order; the not-found text names the verb. */
export async function resolveSandboxGroup(raw: unknown, verb: string): Promise<AgentGroup> {
  const id = raw === undefined || raw === null ? '' : String(raw);
  if (!id) throw new Error(`usage: ncl sandboxes ${verb} <name-or-id>`);
  const group = await findSandboxGroup(id);
  if (!group) throw new Error(`no sandbox '${id}' — create it: ncl sandboxes new --name ${id}`);
  return group;
}

function renderSandboxTable(rows: SandboxListRow[]): string {
  // A module this host refused (seam mismatch) is an operator's fact: it
  // shows here, above the table, until the module is rebuilt.
  const refused = renderSeamRefusals();
  const table = renderSandboxRows(rows);
  return refused.length > 0 ? [...refused, table].join('\n') : table;
}

function renderSandboxRows(rows: SandboxListRow[]): string {
  if (rows.length === 0) return 'no sandboxes — create one: ncl sandboxes new [--name <name>]';
  const header = ['SANDBOX', 'STATUS', 'SESSIONS', 'LAST-ACTIVE', 'ID'];
  const cells = rows.map((r) => [r.sandbox, r.status, String(r.sessions), r.last_active ?? '-', r.id]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) =>
    c
      .map((v, i) => v.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(header), ...cells.map(line)].join('\n');
}

registerResource({
  name: 'sandbox',
  plural: 'sandboxes',
  // Nominal CRUD anchors: every verb below is a custom operation and
  // operations is empty, so no generic op ever registers over these — they
  // exist because ResourceDef requires them (help rendering reads them).
  table: 'agent_groups',
  description:
    'Sandbox — a code-mode agent group: a durable workspace whose disposable session container wakes on attach and reaps on the idle lease. Operator-only.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Agent group UUID.', generated: true },
    {
      name: 'folder',
      type: 'string',
      description:
        'The sandbox name — the group folder under groups/ on the host, unique, and the session-driver group-folder label verbatim.',
      generated: true,
    },
  ],
  operations: {},
  customOperations: {
    new: {
      access: 'open',
      hostOnly: true,
      description:
        'Create a fresh sandbox and land attached to its coding session (host operators only).\n' +
        'Usage: ncl sandboxes new [name] [--name <name>] [--provider <p>] [--permission-mode auto|bypass] ' +
        '[--timezone <IANA id>] [--no-attach]. The name is the group folder (generated when omitted); ' +
        'an existing name is refused — attach to it instead. --no-attach creates without handing the ' +
        'terminal over (scripting). Detach later with Ctrl-b then d; the session keeps running until the ' +
        'idle lease reaps the container — the workspace is durable and re-attach wakes it again.',
      handler: async (args) => {
        // `ncl sandboxes new t1` arrives through the dispatch trailing-
        // positional trim as args.id — the same mechanism that makes
        // `sandboxes attach t1` work. The positional IS the name; ignoring
        // it would mint a generated-name box and land the caller attached
        // to the wrong sandbox.
        const positional = args.id === undefined ? undefined : String(args.id);
        const flagged = args.name === undefined ? undefined : String(args.name);
        if (positional !== undefined && flagged !== undefined && positional !== flagged) {
          throw new Error(
            `conflicting sandbox names: positional '${positional}' vs --name '${flagged}' — pass exactly one`,
          );
        }
        const name = flagged ?? positional;
        const permissionMode = args['permission-mode'] ?? args.permission_mode;
        const { group, session } = await createSandbox({
          ...(name !== undefined ? { name } : {}),
          ...(args.provider !== undefined ? { provider: String(args.provider) } : {}),
          ...(permissionMode !== undefined ? { permissionMode: String(permissionMode) } : {}),
          ...(args.timezone !== undefined ? { timezone: String(args.timezone) } : {}),
        });

        if (args['no-attach'] === true || args.no_attach === true) {
          return {
            sandbox: group.folder,
            id: group.id,
            sessionId: session.id,
            attach: `ncl sandboxes attach ${group.folder}`,
          };
        }
        return resolveAttachForGroup(group, { wakeWaitMs: NEW_SANDBOX_WAKE_WAIT_MS });
      },
    },
    list: {
      access: 'open',
      hostOnly: true,
      description:
        'List sandboxes (every code-mode group) with live runtime status (host operators only).\n' +
        "Usage: ncl sandboxes list. STATUS 'running' means a live session runtime exists right now; " +
        "'cold' means the idle lease reaped the container — the workspace is durable and " +
        '`ncl sandboxes attach <name>` wakes it again. No reaper runs here: TTL posture is ' +
        'the existing in-container lease, list only shows the result.',
      handler: async () => listSandboxes(),
      formatHuman: (data) => renderSandboxTable(data as SandboxListRow[]),
    },
    attach: {
      access: 'open',
      hostOnly: true,
      description:
        "Attach this terminal to a sandbox's coding session (host operators only).\n" +
        'Usage: ncl sandboxes attach <name-or-id>. Resolution, lazy wake and the exec handover are ' +
        'exactly `ncl groups attach`. Detach with Ctrl-b then d; the session keeps running.',
      handler: async (args) => {
        if (!args.id) throw new Error('usage: ncl sandboxes attach <name-or-id>');
        return resolveAttachForGroup(await resolveSandboxGroup(args.id, 'attach'));
      },
    },
    status: {
      access: 'open',
      hostOnly: true,
      description:
        "Show a sandbox's session state (host operators only).\n" +
        'Usage: ncl sandboxes status <name-or-id>. Reports what the host reads for the coding session — ' +
        'active (idle between turns), processing (a turn is running) or suspended (the container was ' +
        'retired by the idle lease) — the last turn stamp, and the chat surface bound to it, if any.',
      handler: async (args) => sandboxStatus(await resolveSandboxGroup(args.id, 'status')),
      formatHuman: (data) => {
        const d = data as SandboxStatus;
        const lines = [
          `${d.sandbox}: ${d.status}${d.running ? '' : ' (container not running)'}`,
          `  turn:     ${d.turn ? `${d.turn.state} #${d.turn.seq} at ${d.turn.at}` : '-'}`,
        ];
        if (d.surface) {
          lines.push(
            `  surface:  ${d.surface.provider} ${d.surface.surfaceId} (${d.surface.title})` +
              `${d.surface.archivedAt ? ' archived' : d.surface.stoppedAt ? ' stopped by the user' : ''}`,
            `  mirrored: ${d.surface.mirrored ? 'yes' : 'no'}; last sent ${d.surface.lastStatus ?? '-'}` +
              `${d.surface.lastStatusAt ? ` at ${d.surface.lastStatusAt}` : ''}`,
          );
        } else {
          lines.push('  surface:  none');
        }
        return lines.join('\n');
      },
    },
    diff: {
      access: 'open',
      hostOnly: true,
      description:
        "Show what changed in a sandbox's working tree (host operators only).\n" +
        'Usage: ncl sandboxes diff <name-or-id>. The same view a chat surface gets after each turn: ' +
        'tracked changes and new files against HEAD, bounded in size, read by git inside the running ' +
        'session. Empty when the tree is clean; a workspace that is not a git repository says so; a ' +
        'sandbox whose container is not running has no diff until it wakes.',
      handler: async (args) => {
        const group = await resolveSandboxGroup(args.id, 'diff');
        const result = await collectSandboxDiff(group.id);
        if (!result.live)
          return { sandbox: group.folder, running: false, repository: false, content: '', truncated: false };
        if (!result.ok) {
          const message = result.error instanceof Error ? result.error.message : String(result.error);
          throw new Error(`${group.folder}: the diff could not be read in the session — ${message}`);
        }
        const { view } = result;
        return {
          sandbox: group.folder,
          running: true,
          repository: view !== null,
          ...(view ?? { content: '', truncated: false }),
        };
      },
      formatHuman: (data) => {
        const d = data as { sandbox: string; running: boolean; repository: boolean; content: string };
        if (!d.running) return `${d.sandbox}: the session is not running — no diff collected (attach to wake it)`;
        if (!d.repository) return `${d.sandbox}: the workspace is not a git repository`;
        return d.content || `${d.sandbox}: no changes`;
      },
    },
    stop: {
      access: 'open',
      hostOnly: true,
      description:
        "Interrupt a sandbox's current turn (host operators only).\n" +
        'Usage: ncl sandboxes stop <name-or-id>. Presses Escape in the coding session, exactly as a human ' +
        'at the terminal or a Stop on its chat surface would: the action in flight stops, the session ' +
        'stays, and the next message resumes it. A sandbox with no running container has nothing to stop.',
      handler: async (args) => {
        const group = await resolveSandboxGroup(args.id, 'stop');
        const interrupted = await interruptCodingSession(group.id);
        return { sandbox: group.folder, interrupted };
      },
      formatHuman: (data) => {
        const d = data as { sandbox: string; interrupted: boolean };
        return d.interrupted ? `${d.sandbox}: interrupted` : `${d.sandbox}: not running — nothing to interrupt`;
      },
    },
  },
});
