/**
 * Sandboxes — the sandbox lifecycle verbs: new / list / attach.
 *
 * A sandbox IS a code-mode agent group . `new` composes the EXISTING creation machinery
 * with code_mode written before the first spawn (runner selection happens
 * only at spawn, so a creation-time config write needs no restart),
 * creates the group's sandbox session, and lands the caller attached. `list`
 * is the reap-visibility surface: containers reap on the in-container idle lease ,
 * the group + workspace stay durable, and list just shows what has gone
 * cold. `attach` reuses the exact groups-attach resolution (lazy wake
 * included) via cli/attach-resolve.ts.
 *
 * All three verbs are hostOnly + 'open': the socket IS the auth boundary
 * (a host caller is the operator), and the guard refuses every agent
 * caller before a handler runs — the identity story is unchanged.
 */
import { randomUUID } from 'crypto';

import {
  archiveSandboxChannel,
  bindSandboxChannel,
  sandboxChannelStatus,
} from '../../code-mode/session-channel/index.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { findAttachableSessions } from '../../db/sessions.js';
import { updateContainerConfigScalars } from '../../db/container-configs.js';
import { getSessionDriver, labelValueLegal } from '../../drivers/index.js';
import { getInstallSlug } from '../../install-slug.js';
import { groupFolderExistsOnDisk, isValidGroupFolder } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { resolveSandboxSession } from '../../session-manager.js';
import { isValidTimezone } from '../../timezone.js';
import type { AgentGroup, Session } from '../../types.js';
import { resolveAttachForGroup } from '../attach-resolve.js';
import { registerResource } from '../crud.js';
import { remoteOperations } from './sandboxes-remote.js';

/**
 * The first-ever spawn of a brand-new group is the slow path — a cold session
 * runtime can take ~10s to come up and an image pull blows the default 15s
 * attach wait — so `new` waits longer than plain attach.
 */
const NEW_SANDBOX_WAKE_WAIT_MS = 30_000;

const GENERATED_NAME_BASE = 'sandbox';

/**
 * A sandbox name is the group folder AND rides the session driver's
 * group-folder label VERBATIM (SessionSpec label `nanoclaw-group-folder`,
 * refused at composition when label-illegal) — so both grammars must hold at
 * creation, not at first spawn. isValidGroupFolder alone would admit 64 chars
 * and a trailing underscore, both label-illegal.
 */
function validateSandboxName(name: string): void {
  if (!isValidGroupFolder(name) || !labelValueLegal(name)) {
    throw new Error(
      `invalid sandbox name "${name}" — up to 63 chars of [A-Za-z0-9_-], starting and ending ` +
        `alphanumeric ('global' is reserved; the name is the group folder and rides the session ` +
        `driver's group-folder label verbatim)`,
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

/** id-first, then folder — the attach resolution order; the not-found text names the verb. */
async function resolveSandboxGroup(raw: unknown, verb: string): Promise<AgentGroup> {
  const id = raw === undefined || raw === null ? '' : String(raw);
  if (!id) throw new Error(`usage: ncl sandboxes ${verb} <name-or-id>`);
  const group = (await getAgentGroup(id)) ?? (await getAgentGroupByFolder(id));
  if (!group) throw new Error(`no sandbox '${id}' — create it: ncl sandboxes new --name ${id}`);
  return group;
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
    'Sandbox — a code-mode agent group behind the sandbox entry: a durable workspace whose disposable session container wakes on attach and reaps on the idle lease. Operator-only.',
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
        '[--timezone <IANA id>] [--no-attach] [--no-channel]. The name is the group folder (generated when omitted); ' +
        'an existing name is refused — attach to it instead. --no-attach creates without handing the ' +
        'terminal over (scripting). Detach later with Ctrl-b then d; the session keeps running until the ' +
        'idle lease reaps the container — the workspace is durable and re-attach wakes it again. ' +
        'On a host with a managed Slack app the session also gets a chat channel of its own (status, a diff ' +
        'view after each turn, messages both ways, Stop); --no-channel skips that.',
      handler: async (args) => {
        // `ncl sandboxes new t1` / `sandbox entry new t1` arrives through the
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

        const provider = args.provider === undefined ? 'claude' : String(args.provider);
        if (provider !== 'claude') {
          throw new Error('code mode currently supports only Claude Code');
        }

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
        };
        await createAgentGroup(group);
        await initGroupFilesystem(group, provider !== undefined ? { provider } : undefined);

        // Creation-time code mode — written BEFORE the first spawn, so no
        // restart is needed: spawn reads the flag for entrypoint selection,
        // code-mode mounts and code env . This config write IS the
        // verb's "thin composition" — no other creation path sets it.
        await updateContainerConfigScalars(id, {
          code_mode: 1,
          ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
        });

        const { session } = await resolveSandboxSession(id);

        // The chat surface for this session, when the host has a managed
        // Slack app: opened here, after the session row exists (the channel
        // wiring routes into it) and before the first wake. Best-effort by
        // contract — no install, no sign-in, a workspace that cannot do it
        // yet, or a service that is down all leave a plain sandbox.
        const skipChannel = args['no-channel'] === true || args.no_channel === true;
        const channel = skipChannel ? null : await bindSandboxChannel(group);

        if (args['no-attach'] === true || args.no_attach === true) {
          return {
            sandbox: folder,
            id,
            sessionId: session.id,
            attach: `ncl sandboxes attach ${folder}`,
            channel: channel ? { channelId: channel.row.channel_id, created: channel.created } : null,
          };
        }
        return resolveAttachForGroup(group, { wakeWaitMs: NEW_SANDBOX_WAKE_WAIT_MS });
      },
    },
    'channel status': {
      access: 'open',
      hostOnly: true,
      description:
        "Show the chat channel bound to a sandbox's coding session (host operators only).\n" +
        'Usage: ncl sandboxes channel status <name-or-id>. Reports the channel id, the status the service ' +
        'holds (active, processing, suspended, stopped, closed), the last status this host sent, whether ' +
        'this host process is mirroring it, and the views it carries. A sandbox created with --no-channel, ' +
        'or on a host without a managed Slack app, has none.',
      handler: async (args) => {
        const group = await resolveSandboxGroup(args.id, 'channel status');
        const status = await sandboxChannelStatus(group);
        if (!status) return { sandbox: group.folder, channel: null };
        return status;
      },
      formatHuman: (data) => {
        const d = data as { sandbox: string; channel?: null } & Partial<
          Awaited<ReturnType<typeof sandboxChannelStatus>> & object
        >;
        if (!d.channelId) return `${d.sandbox}: no session channel`;
        const lines = [
          `${d.sandbox}: channel ${d.channelId} (${d.title ?? ''})`,
          `  status:     ${d.status ?? '-'}${d.archivedAt ? ' (archived)' : ''}${d.stoppedAt && !d.archivedAt ? ' (stopped by the user)' : ''}`,
          `  last sent:  ${d.lastStatusSent ?? '-'}${d.lastStatusAt ? ` at ${d.lastStatusAt}` : ''}`,
          `  mirrored:   ${d.mirrored ? 'yes' : 'no'}`,
          `  views:      ${d.views && d.views.length > 0 ? d.views.map((v) => `${v.viewKey} (${v.type})`).join(', ') : '-'}`,
        ];
        if (d.serviceError) lines.push(`  service:    ${d.serviceError}`);
        return lines.join('\n');
      },
    },
    'channel archive': {
      access: 'open',
      hostOnly: true,
      description:
        "Archive the chat channel bound to a sandbox's coding session (host operators only).\n" +
        'Usage: ncl sandboxes channel archive <name-or-id> [--summary <text>]. The explicit wrap-up: the ' +
        'channel closes at the service (with the summary posted first, when given) and this host stops ' +
        'mirroring it. Nothing else archives a channel — not a Stop, not deleting the sandbox. The sandbox ' +
        'itself is untouched; a later `sandboxes new` binds a fresh channel.',
      handler: async (args) => {
        const group = await resolveSandboxGroup(args.id, 'channel archive');
        const summary = args.summary === undefined ? undefined : String(args.summary);
        return archiveSandboxChannel(group, summary ? { summary } : {});
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
        'exactly `ncl groups attach` (cli/attach-resolve.ts). Detach with Ctrl-b then d; the session keeps running.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('usage: ncl sandboxes attach <name-or-id>');
        // id-first, then folder — mirrors the groups-attach resolution order.
        const group = (await getAgentGroup(id)) ?? (await getAgentGroupByFolder(id));
        if (!group) throw new Error(`no sandbox '${id}' — create it: ncl sandboxes new --name ${id}`);
        return resolveAttachForGroup(group);
      },
    },
    ...remoteOperations,
  },
});
