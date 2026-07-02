import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { assertValidGroupFolder, resolveGroupFolderPath } from '../group-folder.js';
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import { normalizeName } from '../modules/agent-to-agent/db/agent-destinations.js';
import type { AgentGroup } from '../types.js';
import { resolveLocalTemplate } from './local-dir.js';
import { parseTemplate } from './parse.js';

export interface CreateAgentOptions {
  name?: string;
}

/**
 * Stamp a self-contained agent group from a LOCAL template ref under
 * TEMPLATES_DIR. The template carries MCP servers, instructions, optional
 * context extras, and optional skills — nothing else (no policy, no packages,
 * no provider).
 *
 * The template persona is written to the provider-neutral `instructions.prepend.md`
 * (see src/group-persona.ts). Each provider's project-doc composer inlines it at
 * the TOP of the doc it generates every spawn, so the persona is system-prompt
 * tier regardless of which provider the group ends up running. Because the file
 * is provider-agnostic, placement needs no provider knowledge at stamp time (the
 * provider is DB-resolved later, at first spawn).
 *
 * Returns the created group; the caller wires it to a channel as usual.
 */
export function createAgentFromTemplate(ref: string, opts?: CreateAgentOptions): AgentGroup {
  const dir = resolveLocalTemplate(ref);
  const tpl = parseTemplate(dir);

  const id = randomUUID();
  const name = opts?.name ?? path.basename(dir);
  let folder = normalizeName(name);
  assertValidGroupFolder(folder);
  if (fs.existsSync(resolveGroupFolderPath(folder))) folder = `${folder}-${randomUUID().slice(0, 8)}`;

  const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: new Date().toISOString() };
  createAgentGroup(group);
  ensureContainerConfig(id);

  // group-init.ts owns the mkdir at first spawn, but it isn't called here — so we
  // create the dir ourselves to land instructions.prepend.md + context/.
  const groupDir = path.resolve(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Persona → provider-neutral prepend, inlined at the top of the group's
  // CLAUDE.md/AGENTS.md every spawn (system-prompt tier on any provider).
  fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), tpl.instructions + '\n');

  // Context extras keep their template-relative layout, placed next to the doc
  // the persona is inlined into — so a reference written in instructions.md
  // (e.g. `additional_context/faq.md`) resolves unchanged in the agent's
  // workspace. Nothing is injected into the persona; referencing each file from
  // instructions.md is the template author's job (docs/templates.md).
  for (const { name: file, content } of tpl.contextExtras) {
    const dest = path.join(groupDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  updateContainerConfigJson(id, 'mcp_servers', tpl.mcpServers);

  // Per-group skills overlay — keyed by group id, never shared. cpSync creates
  // intermediate dirs, so .claude-shared/skills need not exist yet.
  const skillsDir = path.join(DATA_DIR, 'v2-sessions', id, '.claude-shared', 'skills');
  for (const { name: skill, srcDir } of tpl.skills) {
    fs.cpSync(srcDir, path.join(skillsDir, skill), { recursive: true });
  }

  return group;
}
