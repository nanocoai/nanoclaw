import { randomUUID } from 'crypto';

import {
  mcpServerPluginOwner,
  parseMcpServerConfig,
  validateMcpServerName,
  type AdditionalMountConfig,
  type McpServerConfig,
} from '../../container-config.js';
import { buildAgentGroupImage, killContainer } from '../../container-runner.js';
import { requestWake } from '../../request-wake.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import {
  getContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../../db/container-configs.js';
import { getSessionDriver } from '../../drivers/index.js';
import { assertValidGroupFolder, groupFolderExistsOnDisk } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import {
  formatRestampResult,
  groupsCarryingPlugin,
  restampAgentFromTemplate,
  type RestampResult,
} from '../../templates/restamp.js';
import { isValidTimezone } from '../../timezone.js';
import type { AgentGroup, ContainerConfigRow } from '../../types.js';
import { registerResource } from '../crud.js';
import { localizeIsoTimestamps } from '../format.js';

/**
 * Parse a --timezone flag: undefined = not passed, null = explicit clear
 * (empty string → follow the install default), otherwise a validated IANA id.
 * Invalid ids throw here, in the handler — for agent callers that is after
 * approval (rare, self-healing: a retry raises a fresh card).
 */
function parseTimezoneFlag(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const tz = String(value);
  if (tz === '') return null;
  if (!isValidTimezone(tz)) {
    throw new Error(
      `invalid --timezone: "${tz}" is not an IANA timezone id (e.g. "Europe/Lisbon"); pass "" to follow the install default`,
    );
  }
  return tz;
}

/** Deserialize JSON columns for display. */
function presentConfig(row: ContainerConfigRow): Record<string, unknown> {
  return {
    agent_group_id: row.agent_group_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    image_tag: row.image_tag,
    assistant_name: row.assistant_name,
    max_messages_per_prompt: row.max_messages_per_prompt,
    skills: JSON.parse(row.skills),
    mcp_servers: JSON.parse(row.mcp_servers),
    packages_apt: JSON.parse(row.packages_apt),
    packages_npm: JSON.parse(row.packages_npm),
    additional_mounts: JSON.parse(row.additional_mounts),
    cli_scope: row.cli_scope,
    timezone: row.timezone,
    updated_at: row.updated_at,
  };
}

registerResource({
  name: 'group',
  plural: 'groups',
  table: 'agent_groups',
  description:
    'Agent group — a logical agent identity. Each group has its own workspace folder (CLAUDE.md, skills, container config), conversation history, and container image. Multiple messaging groups can be wired to one agent group.',
  idColumn: 'id',
  scopeField: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Display name shown in logs, help output, and channel adapters. Does not need to be unique.',
      required: true,
      updatable: true,
    },
    {
      name: 'folder',
      type: 'string',
      description:
        'Directory name under groups/ on the host. Must be unique. Contains CLAUDE.md, skills/, and container.json. Cannot be changed after creation.',
      required: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // `create` and `delete` are custom (below): create needs a `--template`
  // branch, and the generic create inserts a bare agent_groups row but never
  // the container_config a working group needs; the generic single-table
  // DELETE violates FK constraints (#2525).
  operations: { list: 'open', get: 'open', update: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Create (or return the existing) agent group with its container config. Idempotent on --folder (bare creates only; --folder cannot be combined with --template). ' +
        'With --template <ref>, stamp from a local agent plugin under templates/ (skills + MCP servers ' +
        '+ optional persona, context, and paused recurring tasks). When a group already carries the plugin, ' +
        'this instead shows the in-place update plan for it — every plugin-owned surface that would change, ' +
        'flagging local customizations that would be lost; memory, plugin-data/, user-added MCP servers, wiring, ' +
        'and sessions are never touched. Pass --yes to apply the update (then run `ncl groups restart`), ' +
        '--id <group-id> to pick among several stamped groups, or --new to stamp another agent regardless. ' +
        'Without --template, use --folder <slug> (required) and --name <display name>; with --template the ' +
        "folder derives from the agent name (--name overrides the template's own). " +
        'Optional --timezone <IANA id> sets the group timezone (template task schedules fire in it); like --name, it applies only when a group is created — both are ignored on the in-place update of an existing group.',
      handler: async (args) => {
        const timezone = parseTimezoneFlag(args.timezone) ?? undefined;
        if (args.template) {
          // Two identity models: a bare group IS its folder; a templated group
          // IS its plugin. --folder belongs to the first and would be silently
          // ignored here, so reject the mix instead of surprising the caller.
          if (args.folder) {
            throw new Error(
              "--folder applies only to bare creates; a templated group's folder is derived from its name at first stamp and never changes on update",
            );
          }
          const ref = String(args.template);
          // Same plugin already stamped → in-place update (dry run without
          // --yes), never a duplicate agent. --new opts out; agent callers
          // have --id auto-filled, so they always target their own group.
          if (args.new !== true) {
            const carriers = args.id ? [] : await groupsCarryingPlugin(ref);
            if (carriers.length > 1) {
              throw new Error(
                `${carriers.length} groups already carry this plugin: ` +
                  carriers.map((g) => `"${g.name}" (${g.id})`).join(', ') +
                  '. Pass --id <group-id> to update one, or --new to stamp another agent.',
              );
            }
            const targetId = args.id ? String(args.id) : carriers[0]?.id;
            if (targetId) {
              const result = await restampAgentFromTemplate(ref, targetId, { apply: args.yes === true });
              return result.applied
                ? result
                : { ...result, note: `${result.note} Pass --new to stamp a separate agent instead.` };
            }
          }
          const { group, report } = await createAgentFromTemplate(ref, {
            name: args.name ? String(args.name) : undefined,
            timezone,
          });
          return report.length > 0 ? { ...group, templateReport: report } : group;
        }
        const folder = args.folder as string;
        if (!folder) throw new Error('--folder is required');
        // The template path validates through createAgentFromTemplate; the bare
        // path used to validate nowhere, minting folders the runtime label
        // grammar refuses at every spawn.
        assertValidGroupFolder(folder);
        const name = (args.name as string) ?? folder;
        const existing = await getAgentGroupByFolder(folder);
        if (existing) {
          await initGroupFilesystem(existing); // ensure a reused group is fully configured too (idempotent; also repairs a missing workspace folder)
          return existing;
        }
        // Fresh-create branch only: a folder on disk with no claiming DB row
        // is deleted-group residue (delete never removes groups/<folder>/) or
        // an operator-placed dir — minting a new id over it would silently
        // re-scope the old group's data under a new identity.
        if (groupFolderExistsOnDisk(folder)) {
          throw new Error(
            `group folder 'groups/${folder}' already exists on disk but no agent group claims it — ` +
              `deleting a group never removes its folder, and creating a new group over it would silently ` +
              `adopt the old group's data under a new identity. Move or remove the folder, or pick a different --folder.`,
          );
        }
        const id = `ag-${randomUUID()}`;
        const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: new Date().toISOString() };
        await createAgentGroup(group);
        // Provision the workspace folder and the `container_configs` row that
        // `getContainerConfig` and the spawn path require. Without this, a
        // group created via `ncl groups create` would throw "Container config
        // not found" on first spawn and stay broken until the host restart
        // backfill ran (#2415). The template branch above provisions its own
        // config + folder in `createAgentFromTemplate`; this covers the bare
        // path. Mirrors what `setup/register.ts` does after creating an agent
        // group via the setup flow. The config row is stamped with the
        // instance default provider (`ensureContainerConfig` inside) — per-group
        // `groups config update --provider` still wins.
        await initGroupFilesystem(group);
        if (timezone) await updateContainerConfigScalars(id, { timezone });
        return getAgentGroupByFolder(folder);
      },
      // The restamp path returns a plan that wants the aligned-lines view;
      // everything else keeps the generic JSON rendering.
      formatHuman: (data) =>
        data !== null && typeof data === 'object' && 'changes' in data && 'plugin' in data
          ? formatRestampResult(data as RestampResult)
          : JSON.stringify(localizeIsoTimestamps(data), null, 2),
    },
    delete: {
      access: 'approval',
      description:
        'Delete an agent group and its dependent rows (sessions, destinations, approvals, role grants, ' +
        'memberships, channel wirings). FK-ordered cascade in a single transaction. ' +
        'Use --id <group-id>. Out of scope: killing running containers, on-disk cleanup of groups/<folder>/ and data/v2-sessions/<group-id>/. ' +
        'The leftover groups/<folder>/ blocks re-creating a group under the same folder name until it is moved or removed.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const db = getDb();

        // Verify the group exists before doing anything — preserves the
        // genericDelete behaviour of throwing "not found" for unknown IDs.
        const exists = await db.get('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1', id);
        if (!exists) throw new Error(`group not found: ${id}`);

        const hasAgentDestinations = await hasTable(db, 'agent_destinations');
        const hasPendingApprovals = await hasTable(db, 'pending_approvals');

        // FK-ordered cascade. The async driver transaction rolls
        // back the whole thing if any statement throws (e.g. an FK constraint
        // we missed), so the central DB stays consistent. The `removed` counts
        // are sourced from each DELETE's `changes` so they describe exactly
        // what the transaction did, not a separate pre-flight snapshot.
        const removed = await db.transaction(async () => {
          const counts = {
            sessions: 0,
            pending_questions: 0,
            pending_approvals: 0,
            agent_destinations_owned: 0,
            agent_destinations_pointing: 0,
            pending_sender_approvals: 0,
            pending_channel_approvals: 0,
            messaging_group_agents: 0,
            agent_group_members: 0,
            user_roles: 0,
            container_configs: 0,
          };

          if (hasAgentDestinations) {
            counts.agent_destinations_owned = (
              await db.run('DELETE FROM agent_destinations WHERE agent_group_id = ?', id)
            ).changes;
            counts.agent_destinations_pointing = (
              await db.run('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?', 'agent', id)
            ).changes;
          }
          counts.pending_questions = (
            await db.run(
              'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
              id,
            )
          ).changes;
          if (hasPendingApprovals) {
            counts.pending_approvals = (
              await db.run(
                'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
                id,
                id,
              )
            ).changes;
          }
          counts.sessions = (await db.run('DELETE FROM sessions WHERE agent_group_id = ?', id)).changes;
          counts.pending_sender_approvals = (
            await db.run('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?', id)
          ).changes;
          counts.pending_channel_approvals = (
            await db.run('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?', id)
          ).changes;
          counts.messaging_group_agents = (
            await db.run('DELETE FROM messaging_group_agents WHERE agent_group_id = ?', id)
          ).changes;
          counts.agent_group_members = (
            await db.run('DELETE FROM agent_group_members WHERE agent_group_id = ?', id)
          ).changes;
          counts.user_roles = (await db.run('DELETE FROM user_roles WHERE agent_group_id = ?', id)).changes;
          // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
          // the explicit delete here mirrors the other tables and surfaces the count.
          counts.container_configs = (
            await db.run('DELETE FROM container_configs WHERE agent_group_id = ?', id)
          ).changes;
          await db.run('DELETE FROM agent_groups WHERE id = ?', id);
          return counts;
        });

        return { deleted: id, removed };
      },
    },
    restart: {
      access: 'approval',
      description:
        'Restart containers for a group. Use --id <group-id> [--rebuild] [--message <text>]. ' +
        'From inside a container, --id is auto-filled and only the calling session is restarted. ' +
        '--rebuild rebuilds the container image first (required for package changes). ' +
        '--message sets an on-wake instruction for the fresh container to act on when it starts — ' +
        'use this when you need to continue after the restart (e.g. verify a new tool works, notify the user). ' +
        'Without --message, the container stops and only starts again on the next user message.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        if (args.rebuild) {
          // Refuse the WHOLE command in the payload (this command exits 0 even
          // on a nonexistent group id) and restart nothing: the operator asked
          // for rebuild-then-restart, and restarting after silently skipping
          // the rebuild would report success for a rebuild that never happened.
          if (!getSessionDriver().capabilities().imageBuild) {
            return {
              restarted: 0,
              rebuilt: false,
              error:
                "the session runtime does not declare the 'imageBuild' capability; " +
                '--rebuild cannot run here — image changes must be built and imported out of band',
            };
          }
          await buildAgentGroupImage(id);
        }
        const message = args.message as string | undefined;

        // From an agent: scope to the calling session only
        if (ctx.caller === 'agent') {
          if (message) {
            await writeSessionMessage(id, ctx.sessionId, {
              id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: id,
              channelType: 'agent',
              threadId: null,
              content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
              onWake: true,
            });
          }
          killContainer(
            ctx.sessionId,
            'restarted via ncl',
            message
              ? () => {
                  void (async () => {
                    const s = await getSession(ctx.sessionId);
                    if (s) await requestWake(s, 'cli');
                  })();
                }
              : undefined,
          );
          return { restarted: 1, rebuilt: !!args.rebuild };
        }

        // From the host: restart all running containers in the group
        const count = await restartAgentGroupContainers(id, 'restarted via ncl', message);
        return { restarted: count, rebuilt: !!args.rebuild };
      },
    },
    'config get': {
      access: 'open',
      description: 'Show the container config for a group. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        return presentConfig(row);
      },
    },
    'config update': {
      access: 'approval',
      description:
        'Update container config scalar fields. Changes are saved but do NOT take effect until you run `ncl groups restart`. ' +
        'Use --id <group-id> and any of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope, ' +
        '--timezone (IANA id like "Europe/Lisbon"; "" clears back to the install default; scheduled-task times follow it immediately, message display after restart).',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            | 'provider'
            | 'model'
            | 'effort'
            | 'image_tag'
            | 'assistant_name'
            | 'max_messages_per_prompt'
            | 'cli_scope'
            | 'timezone'
          >
        > = {};
        if (args.provider !== undefined) updates.provider = args.provider as string;
        const timezone = parseTimezoneFlag(args.timezone);
        if (timezone !== undefined) updates.timezone = timezone;
        if (args.model !== undefined) updates.model = args.model as string;
        if (args.effort !== undefined) updates.effort = args.effort as string;
        if (args.image_tag !== undefined) updates.image_tag = args.image_tag as string;
        if (args.assistant_name !== undefined) updates.assistant_name = args.assistant_name as string;
        if (args.max_messages_per_prompt !== undefined)
          updates.max_messages_per_prompt = Number(args.max_messages_per_prompt);
        if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
          const scope = (args['cli-scope'] ?? args.cli_scope) as string;
          if (!['disabled', 'group', 'global'].includes(scope)) {
            throw new Error('--cli-scope must be one of: disabled, group, global');
          }
          updates.cli_scope = scope;
        }

        if (Object.keys(updates).length === 0) {
          throw new Error(
            'Nothing to update — provide at least one of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope, --timezone',
          );
        }

        await updateContainerConfigScalars(id, updates);

        const updated = (await getContainerConfig(id))!;
        return presentConfig(updated);
      },
    },
    'config add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --name <server-name> with either --command <cmd> [--args <json-array>] [--env <json-object>] ' +
        'or --url <url> [--headers <json-object>] (HTTPS, or plain HTTP for localhost / host.docker.internal).',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        validateMcpServerName(name);

        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        const owner = mcpServerPluginOwner(servers[name]);
        if (owner) {
          throw new Error(
            `MCP server "${name}" is owned by plugin "${owner}" — ` +
              'update the plugin and restamp it (`ncl groups create --template <ref> --yes`) instead of editing it directly',
          );
        }
        servers[name] = parseMcpServerConfig({
          command: args.command,
          url: args.url,
          args: args.args === undefined ? undefined : JSON.parse(String(args.args)),
          env: args.env === undefined ? undefined : JSON.parse(String(args.env)),
          headers: args.headers === undefined ? undefined : JSON.parse(String(args.headers)),
        });
        await updateContainerConfigJson(id, 'mcp_servers', servers);

        return { added: name, servers };
      },
    },
    'config remove-mcp-server': {
      access: 'approval',
      description:
        'Remove an MCP server from a group. Requires `ncl groups restart` to take effect. Use --id <group-id> --name <server-name>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
        const owner = mcpServerPluginOwner(servers[name]);
        if (owner) {
          throw new Error(
            `MCP server "${name}" is owned by plugin "${owner}" — ` +
              'it would reappear on the next restamp; remove it from the plugin instead',
          );
        }
        delete servers[name];
        await updateContainerConfigJson(id, 'mcp_servers', servers);

        return { removed: name };
      },
    },
    'config add-package': {
      access: 'approval',
      description:
        'Add a package to a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          if (!existing.includes(apt)) {
            existing.push(apt);
            await updateContainerConfigJson(id, 'packages_apt', existing);
          }
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          if (!existing.includes(npm)) {
            existing.push(npm);
            await updateContainerConfigJson(id, 'packages_npm', existing);
          }
        }

        return {
          added: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for packages to take effect. Use install_packages from the agent or rebuild manually.',
        };
      },
    },
    'config remove-package': {
      access: 'approval',
      description:
        'Remove a package from a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          const filtered = existing.filter((p) => p !== apt);
          await updateContainerConfigJson(id, 'packages_apt', filtered);
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          const filtered = existing.filter((p) => p !== npm);
          await updateContainerConfigJson(id, 'packages_npm', filtered);
        }

        return {
          removed: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for package changes to take effect.',
        };
      },
    },
    'config add-mount': {
      access: 'approval',
      hostOnly: true,
      description:
        "Mount a host directory into a group's containers. OPERATOR-ONLY — never runnable from " +
        'inside a container (mounting host paths is a filesystem-access boundary). Requires ' +
        '`ncl groups restart` to take effect. Use --id <group-id> --host <host-path> --container <container-path> [--ro].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const hostPath = (args.host ?? args['host-path']) as string | undefined;
        const containerPath = (args.container ?? args['container-path']) as string | undefined;
        if (!hostPath || !containerPath) throw new Error('Provide --host <host-path> and --container <container-path>');

        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const mount: AdditionalMountConfig = {
          hostPath,
          containerPath,
          ...(args.ro || args.readonly ? { readonly: true } : {}),
        };
        const existing = JSON.parse(row.additional_mounts) as AdditionalMountConfig[];
        if (!existing.some((m) => m.hostPath === hostPath && m.containerPath === containerPath)) {
          existing.push(mount);
          await updateContainerConfigJson(id, 'additional_mounts', existing);
        }
        return { added: mount, note: `Run \`ncl groups restart --id ${id}\` for the mount to take effect.` };
      },
    },
    'config remove-mount': {
      access: 'approval',
      hostOnly: true,
      description:
        'Remove a host mount from a group. OPERATOR-ONLY. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --host <host-path> --container <container-path>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const hostPath = (args.host ?? args['host-path']) as string | undefined;
        const containerPath = (args.container ?? args['container-path']) as string | undefined;
        if (!hostPath || !containerPath) throw new Error('Provide --host <host-path> and --container <container-path>');

        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const existing = JSON.parse(row.additional_mounts) as AdditionalMountConfig[];
        const filtered = existing.filter((m) => !(m.hostPath === hostPath && m.containerPath === containerPath));
        await updateContainerConfigJson(id, 'additional_mounts', filtered);
        return { removed: { hostPath, containerPath }, note: `Run \`ncl groups restart --id ${id}\` to apply.` };
      },
    },
  },
});
