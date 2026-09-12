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
  },
});
