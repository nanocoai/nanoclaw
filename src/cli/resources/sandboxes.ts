/**
 * Sandboxes — the ssh-door lifecycle verbs: new / list / attach.
 *
 * A sandbox IS a code-mode agent group (sandbox-spec vocabulary — no new
 * registry, no new label). `new` composes the EXISTING creation machinery
 * with code_mode written before the first spawn (runner selection happens
 * only at spawn, D22, so a creation-time config write needs no restart),
 * creates the group's door session, and lands the caller attached. `list`
 * is the reap-visibility surface: pods reap on the in-pod idle lease (D14),
 * the group + workspace stay durable, and list just shows what has gone
 * cold. `attach` reuses the exact groups-attach resolution (D13 lazy wake
 * included) via cli/attach-resolve.ts.
 *
 * All three verbs are hostOnly + 'open': the socket IS the auth boundary
 * (a host caller is the operator, D20), and the guard refuses every agent
 * caller before a handler runs — the identity story is unchanged.
 */
import { randomUUID } from 'crypto';

import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { findAttachableSessions } from '../../db/sessions.js';
import { updateContainerConfigScalars } from '../../db/container-configs.js';
import { getSessionDriver, labelValueLegal } from '../../drivers/index.js';
import { getInstallSlug } from '../../install-slug.js';
import { groupFolderExistsOnDisk, isValidGroupFolder } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { resolveDoorSession } from '../../session-manager.js';
import { isValidTimezone } from '../../timezone.js';
import type { AgentGroup, Session } from '../../types.js';
import { resolveAttachForGroup } from '../attach-resolve.js';
import { registerResource } from '../crud.js';

/**
 * The first-ever spawn of a brand-new group is the slow path — a cold k8s
 * pod measured ~10s on a warm node (cycle-1 log §3) and an image pull blows
 * the default 15s attach wait — so `new` waits longer than plain attach.
 */
const NEW_SANDBOX_WAKE_WAIT_MS = 30_000;

const GENERATED_NAME_BASE = 'sandbox';

/**
 * A sandbox name is the group folder AND rides the k8s group-folder label
 * VERBATIM (SessionSpec label `nanoclaw-group-folder`, refused at
 * composition when label-illegal) — so both grammars must hold at the door,
 * not at first spawn. isValidGroupFolder alone would admit 64 chars and a
 * trailing underscore, both label-illegal.
 */
function validateSandboxName(name: string): void {
  if (!isValidGroupFolder(name) || !labelValueLegal(name)) {
    throw new Error(
      `invalid sandbox name "${name}" — up to 63 chars of [A-Za-z0-9_-], starting and ending ` +
        `alphanumeric ('global' is reserved; the name is the group folder and rides the k8s ` +
        `group-folder label verbatim)`,
    );
  }
}

/**
 * Suffix-dedupe name generation (create-agent.ts precedent), globally across
 * agent_groups.folder AND the on-disk groups/ dir: a folder on disk with no
 * claiming DB row is deleted-group residue and must never be adopted.
 */
async function generateSandboxName(): Promise<string> {
  let folder = GENERATED_NAME_BASE;
  let suffix = 2;
  while ((await getAgentGroupByFolder(folder)) || groupFolderExistsOnDisk(folder)) {
    folder = `${GENERATED_NAME_BASE}-${suffix}`;
    suffix++;
  }
  return folder;
}

/**
 * The owner of record for a door-created sandbox (D20, single-operator
 * posture). The gateway resolves session-channel identity from the group's
 * provisioned user: without one, every governed egress connection is
 * silently reset — fail-closed, but undiagnosable from inside the sandbox.
 * Resolution: --owner flag → NANOCLAW_SANDBOX_OWNER → the sole global owner
 * row. A populated directory that cannot disambiguate refuses at create
 * time; an empty directory (no provisioning reality) resolves null.
 */
async function resolveSandboxOwner(flagged: string | undefined): Promise<string | null> {
  const candidate = flagged ?? process.env.NANOCLAW_SANDBOX_OWNER;
  if (candidate) {
    const known = await getDb().get('SELECT id FROM users WHERE id = ?', candidate);
    if (!known) {
      throw new Error(
        `sandbox owner '${candidate}' is not a known user — the gateway silently refuses ` +
          `all egress for an unresolvable identity. Check: ncl users list`,
      );
    }
    return candidate;
  }
  const directorySize = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM users'))?.n ?? 0;
  if (directorySize === 0) return null;
  const owners = await getDb().all<{ user_id: string }>(
    `SELECT user_id FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL`,
  );
  if (owners.length === 1) return owners[0].user_id;
  throw new Error(
    'a sandbox needs an owner of record: pass --owner <user-id> or set NANOCLAW_SANDBOX_OWNER ' +
      '(single-operator installs) — without one the gateway refuses all sandbox egress',
  );
}

interface SandboxListRow {
  sandbox: string;
  id: string;
  status: 'running' | 'cold';
  sessions: number;
  container_status: string | null;
  last_active: string | null;
  created_at: string;
}

function newestActivity(sessions: Session[]): { container_status: string | null; last_active: string | null } {
  let best: Session | undefined;
  for (const s of sessions) {
    const stamp = s.last_active ?? s.created_at;
    if (!best || stamp > (best.last_active ?? best.created_at)) best = s;
  }
  return { container_status: best?.container_status ?? null, last_active: best?.last_active ?? null };
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
    'Sandbox — a code-mode agent group behind the ssh door: a durable workspace whose disposable session pod wakes on attach (D13) and reaps on the in-pod idle lease (D14). Operator-only.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Agent group UUID.', generated: true },
    {
      name: 'folder',
      type: 'string',
      description:
        'The sandbox name — the group folder under groups/ on the host, unique, and the k8s group-folder label verbatim.',
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
        'terminal over (scripting). Detach later with Ctrl-]; the session keeps running until the ' +
        'idle lease reaps the pod — the workspace is durable and re-attach wakes it again.',
      handler: async (args) => {
        // `ncl sandboxes new t1` / `ssh door new t1` arrives through the
        // dispatch trailing-positional trim as args.id — the same mechanism
        // that makes `sandboxes attach t1` work. The positional IS the name;
        // ignoring it would mint a generated-name box and land the caller
        // attached to the wrong sandbox.
        const positional = args.id === undefined ? undefined : String(args.id);
        const flagged = args.name === undefined ? undefined : String(args.name);
        if (positional !== undefined && flagged !== undefined && positional !== flagged) {
          throw new Error(
            `conflicting sandbox names: positional '${positional}' vs --name '${flagged}' — pass exactly one`,
          );
        }
        const requested = flagged ?? positional;
        if (requested !== undefined) validateSandboxName(requested);

        const provider = args.provider === undefined ? undefined : String(args.provider);

        let permissionMode: string | undefined;
        if (args['permission-mode'] !== undefined || args.permission_mode !== undefined) {
          permissionMode = String(args['permission-mode'] ?? args.permission_mode);
          if (permissionMode !== 'auto' && permissionMode !== 'bypass') {
            throw new Error('--permission-mode must be auto or bypass');
          }
        }

        let timezone: string | undefined;
        if (args.timezone !== undefined) {
          timezone = String(args.timezone);
          if (!isValidTimezone(timezone)) {
            throw new Error(`invalid --timezone: "${timezone}" is not an IANA timezone id (e.g. "Europe/Lisbon")`);
          }
        }

        // Collision is a refusal, deliberately NOT groups-create's
        // idempotent-return: `new` promises a FRESH box, and silently
        // landing someone in an existing agent's workspace would hand over
        // that agent's memory and materials.
        if (requested !== undefined) {
          if (await getAgentGroupByFolder(requested)) {
            throw new Error(`sandbox '${requested}' already exists — attach to it: ncl sandboxes attach ${requested}`);
          }
          if (groupFolderExistsOnDisk(requested)) {
            throw new Error(
              `group folder 'groups/${requested}' already exists on disk but no sandbox claims it — ` +
                `deleted-group residue is never adopted under a new identity. Move or remove the folder, ` +
                `or pick a different --name.`,
            );
          }
        }
        const folder = requested ?? (await generateSandboxName());

        // The exact creation machinery of `groups create` (fresh branch):
        // agent_groups row, then workspace folder + container_configs row.
        const id = `ag-${randomUUID()}`;
        const group: AgentGroup = {
          id,
          name: folder,
          folder,
          agent_provider: null,
          created_at: new Date().toISOString(),
          provisioned_user_id: await resolveSandboxOwner(args.owner === undefined ? undefined : String(args.owner)),
        };
        await createAgentGroup(group);
        await initGroupFilesystem(group, provider !== undefined ? { provider } : undefined);

        // Creation-time code mode — written BEFORE the first spawn, so no
        // restart is needed: spawn reads the flag for entrypoint selection,
        // code-mode mounts and code env (D13/D22). This config write IS the
        // door's "thin composition" — no other creation path sets it.
        await updateContainerConfigScalars(id, {
          code_mode: 1,
          ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
        });

        const { session } = await resolveDoorSession(id);

        if (args['no-attach'] === true || args.no_attach === true) {
          return {
            sandbox: folder,
            id,
            sessionId: session.id,
            attach: `ncl sandboxes attach ${folder}`,
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
        "'cold' means the idle lease reaped the pod (D14) — the workspace is durable and " +
        '`ncl sandboxes attach <name>` wakes it again (D13). No reaper runs here: TTL posture is ' +
        'the existing in-pod lease, list only shows the result.',
      handler: async () => {
        const groups = await getDb().all<Pick<AgentGroup, 'id' | 'folder' | 'created_at'>>(
          `SELECT g.id, g.folder, g.created_at
               FROM agent_groups g
               JOIN container_configs c ON c.agent_group_id = g.id
              WHERE c.code_mode = 1
              ORDER BY g.created_at`,
        );

        // Live phase through the driver's own discovery (the adoption
        // contract — lineage names lie): one listSessions sweep, where each
        // snapshot carries the phase the listing itself observed, grouped by
        // owning agent group.
        const running = new Set<string>();
        for (const snapshot of await getSessionDriver().listSessions(getInstallSlug())) {
          if (snapshot.phase === 'running') running.add(snapshot.handle.key.agentGroupId);
        }

        return Promise.all(
          groups.map(async (g): Promise<SandboxListRow> => {
            const sessions = await findAttachableSessions(g.id);
            const { container_status, last_active } = newestActivity(sessions);
            return {
              sandbox: g.folder,
              id: g.id,
              status: running.has(g.id) ? 'running' : 'cold',
              sessions: sessions.length,
              container_status,
              last_active,
              created_at: g.created_at,
            };
          }),
        );
      },
      formatHuman: (data) => renderSandboxTable(data as SandboxListRow[]),
    },
    attach: {
      access: 'open',
      hostOnly: true,
      description:
        "Attach this terminal to a sandbox's coding session (host operators only).\n" +
        'Usage: ncl sandboxes attach <name-or-id>. Resolution, lazy wake and the exec handover are ' +
        'exactly `ncl groups attach` (cli/attach-resolve.ts). Detach with Ctrl-]; the session keeps running.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('usage: ncl sandboxes attach <name-or-id>');
        // id-first, then folder — mirrors the groups-attach resolution order.
        const group = (await getAgentGroup(id)) ?? (await getAgentGroupByFolder(id));
        if (!group) throw new Error(`no sandbox '${id}' — create it: ncl sandboxes new --name ${id}`);
        return resolveAttachForGroup(group);
      },
    },
  },
});
