import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { CONTAINER_PLUGINS_DIR, type McpServerConfig } from '../container-config.js';
import { DATA_DIR, GROUPS_DIR, TEMPLATES_DIR, TIMEZONE } from '../config.js';
import { buildAgentGroupImage } from '../container-runner.js';
import { createAgentGroup } from '../db/agent-groups.js';
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../db/container-configs.js';
import { assertValidGroupFolder, resolveGroupFolderPath } from '../group-folder.js';
import { stageGroupPersona } from '../group-persona.js';
import { log } from '../log.js';
import { normalizeName } from '../modules/agent-to-agent/db/agent-destinations.js';
import { createScheduledTask } from '../modules/scheduling/create.js';
import { isValidTimezone } from '../timezone.js';
import type { AgentGroup } from '../types.js';
import { type AgentCreateSpec, validateAgentCreateSpec } from './create-spec.js';
import { adoptGovernanceAgentId } from './governance-agent-id.js';
import { pluginDataCwdSubpaths } from './mcp.js';
import { parseTemplate } from './parse.js';
import { prepareTemplateForCreateSpec } from './prepare-template.js';
import { copyPluginDir } from './plugin-dir.js';
import { loadTemplateSnapshot } from './snapshot.js';
import { resolveTemplateSource } from './source.js';
import { prepareTemplateTasks } from './tasks.js';

export interface CreateAgentFromSourceOptions {
  name?: string;
  source?: string;
  timezone?: string;
}

interface StampPluginOptions {
  name?: string;
  id?: string;
  folder?: string;
  provisionedUserId?: string | null;
  timezone?: string;
  ref: string;
}

export interface CreateAgentResult {
  group: AgentGroup;
  report: string[];
}

/** Group-private skills overlay — the same location core's plugin stamper owns. */
export function groupSkillsOverlayDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
}

/** Mark exact effective servers as owned by the prepared plugin. */
export function markPluginServers(
  servers: Record<string, McpServerConfig>,
  pluginName: string,
): Record<string, McpServerConfig> {
  const pluginRoot = `${CONTAINER_PLUGINS_DIR}/${pluginName}`;
  return Object.fromEntries(
    Object.entries(servers).map(([serverName, server]) => [
      serverName,
      server.type === 'http'
        ? { ...server, plugin: pluginName }
        : { cwd: '${PLUGIN_ROOT}', ...server, plugin: pluginName, pluginRoot },
    ]),
  );
}

/** Source-aware non-spec creation used only by `--template --source`. */
export async function createAgentFromSource(
  ref: string,
  opts?: CreateAgentFromSourceOptions,
): Promise<CreateAgentResult> {
  const resolved = await resolveTemplateSource(ref, opts?.source ?? TEMPLATES_DIR);
  try {
    return await stampPluginDir(resolved.dir, {
      ref,
      name: opts?.name,
      timezone: opts?.timezone,
    });
  } finally {
    resolved.cleanup();
  }
}

/**
 * AgentCreateSpec v2 entry point. Governance supplies an immutable plugin
 * digest and exact effective config; NanoClaw validates and stamps that
 * prepared plugin through its current Agent Plugins 1.0.0 filesystem model.
 */
export async function createAgentFromSpec(spec: AgentCreateSpec): Promise<AgentGroup> {
  adoptGovernanceAgentId(spec);
  validateAgentCreateSpec(spec);
  const resolved = await resolveTemplateSource(spec.template.ref, spec.template.source ?? TEMPLATES_DIR);
  try {
    const snapshot = loadTemplateSnapshot(resolved.dir);
    if (snapshot.digest !== spec.template.expectedDigest) {
      throw new Error(
        `Template digest changed for ${spec.template.ref}: expected ${spec.template.expectedDigest}, got ${snapshot.digest}`,
      );
    }

    const prepared = prepareTemplateForCreateSpec(resolved.dir, spec);
    try {
      const preparedSnapshot = loadTemplateSnapshot(prepared.dir);
      const { group } = await stampPluginDir(prepared.dir, {
        ref: spec.template.ref,
        id: spec.id,
        name: spec.name,
        folder: spec.folder,
        provisionedUserId: spec.provisionedUserId ?? null,
      });
      await updateContainerConfigScalars(group.id, {
        cli_scope: spec.config.cliScope,
        assistant_name: spec.config.assistantName ?? null,
      });
      await updateContainerConfigJson(group.id, 'packages_apt', preparedSnapshot.packages.apt);
      await updateContainerConfigJson(group.id, 'packages_npm', preparedSnapshot.packages.npm);

      if (preparedSnapshot.packages.apt.length > 0 || preparedSnapshot.packages.npm.length > 0) {
        await buildAgentGroupImage(group.id);
      }
      return group;
    } finally {
      prepared.cleanup();
    }
  } finally {
    resolved.cleanup();
  }
}

/**
 * Stamp an already-resolved plugin directory. This mirrors NanoClaw's current
 * plugin stamper, while exposing the caller-controlled identity/folder needed
 * by the external provisioning contract.
 */
async function stampPluginDir(dir: string, opts: StampPluginOptions): Promise<CreateAgentResult> {
  const tpl = parseTemplate(dir);
  const timezone = opts.timezone && isValidTimezone(opts.timezone) ? opts.timezone : undefined;
  const tasks = prepareTemplateTasks(tpl.tasks, timezone ?? TIMEZONE);

  const id = opts.id ?? `ag-${randomUUID()}`;
  const name = opts.name ?? tpl.agentName ?? path.basename(dir);
  let folder = opts.folder ?? normalizeName(name);
  assertValidGroupFolder(folder);
  if (fs.existsSync(resolveGroupFolderPath(folder))) {
    if (opts.folder) throw new Error(`Agent group folder already exists: ${folder}`);
    folder = `${folder}-${randomUUID().slice(0, 8)}`;
  }

  const group: AgentGroup = {
    id,
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
    provisioned_user_id: opts.provisionedUserId ?? null,
  };
  await createAgentGroup(group);
  await ensureContainerConfig(id);
  if (timezone) await updateContainerConfigScalars(id, { timezone });

  const groupDir = path.resolve(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });
  if (tpl.instructions !== undefined) stageGroupPersona(groupDir, tpl.instructions);

  for (const { name: file, content } of tpl.contextExtras) {
    const destination = path.join(groupDir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }

  copyPluginDir(dir, path.join(groupDir, 'plugins', tpl.name));
  fs.mkdirSync(path.join(groupDir, 'plugin-data', tpl.name), { recursive: true });
  for (const sub of pluginDataCwdSubpaths(tpl.mcpServers)) {
    fs.mkdirSync(path.join(groupDir, 'plugin-data', tpl.name, sub), { recursive: true });
  }
  await updateContainerConfigJson(id, 'mcp_servers', markPluginServers(tpl.mcpServers, tpl.name));

  const skillsDir = groupSkillsOverlayDir(id);
  for (const { name: skill, srcDir } of tpl.skills) {
    copyPluginDir(srcDir, path.join(skillsDir, skill));
  }
  for (const task of tasks.values()) await createScheduledTask(id, task, { status: 'paused' });
  for (const notice of tpl.report) log.warn('Template reader notice', { ref: opts.ref, notice });

  return { group, report: tpl.report };
}
