/**
 * AGENTS.md composition for codex agent groups — codex-owned payload code.
 *
 * AGENTS.md is Codex's project doc (its CLAUDE.md equivalent). Composed fresh
 * on every spawn by the codex provider contribution (see ./codex.ts) from:
 *   - the shared base (`container/AGENTS.md`)
 *   - a pointer to the runner-scaffolded memory system (content is supplied by
 *     the provider's native SessionStart hook — nothing is read here)
 *   - a pointer to codex-native skills under `.agents/skills`
 *   - each enabled NanoClaw module's `*.instructions.md` fragment
 *   - MCP server `instructions` from container.json
 *
 * Codex hard-caps project-doc loading (`project_doc_max_bytes`, mirrored in
 * the container provider's config.toml writer) — compose fails loudly rather
 * than letting Codex truncate silently.
 */
import fs from 'fs';
import path from 'path';

import type { McpServerConfig } from '../container-config.js';
import { getContainerConfig } from '../db/container-configs.js';
import { readGroupPersona } from '../group-persona.js';
import { log } from '../log.js';
import type { AgentGroup } from '../types.js';

export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const CODEX_PROJECT_DOC_WARN_BYTES = 28 * 1024;

const HEADER = '<!-- Composed at spawn. Do not edit. Edit memory/system/definition.md for memory behavior. -->';
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const MEMORY_POINTER = [
  'The live memory index and definition are supplied by NanoClaw at session startup, clear, and after compaction.',
  'Editable memory-system definition: `/workspace/agent/memory/system/definition.md`.',
  'Top memory index: `/workspace/agent/memory/index.md`.',
  'Read the definition and index, then use linked memory files and conversation archives when relevant.',
  'Stored user preferences are binding: read any linked memory file relevant to the user or the request, and apply it without being asked.',
  'Do not use `AGENTS.local.md` or `AGENTS.override.md` for memory.',
].join('\n\n');

const NATIVE_RUNTIME_SKILLS_POINTER = [
  'Selected NanoClaw runtime skills are available as Codex-native skills at `/workspace/agent/.agents/skills`.',
  'Each skill directory contains a `SKILL.md` with its trigger description plus any supporting files, and points to the read-only shared skill source under `/app/skills`.',
  'Use skill discovery to load these skills only when their descriptions match the task. Full skill instructions live in the skill directories, not in `AGENTS.md`.',
  'Skills YOU author or install yourself go in `~/.codex/skills/<name>/SKILL.md` — persistent across sessions and discovered by Codex automatically. Never write skills elsewhere: paths outside `~/.codex` and `~/.agents` are ephemeral or not discovered.',
].join('\n\n');

interface AgentsMdSection {
  name: string;
  content: string;
}

export function composeGroupAgentsMd(group: AgentGroup, groupDir: string): void {
  if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });

  const configRow = getContainerConfig(group.id);
  const mcpServers: Record<string, McpServerConfig> = configRow
    ? (JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>)
    : {};

  const sections: AgentsMdSection[] = [{ name: 'header', content: HEADER }];
  const pushSection = (name: string, ...content: string[]): void => {
    const body = content
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
    if (body) sections.push({ name, content: `# ${name}\n\n${body}` });
  };

  // Template persona first — the top of the system prompt. 'Persona' is not a
  // droppable prefix (see fitAgentsMdToCap.isDroppable), so it is never evicted.
  const persona = readGroupPersona(groupDir);
  if (persona) pushSection('Persona', persona);

  const sharedBase = path.join(process.cwd(), 'container', 'AGENTS.md');
  if (fs.existsSync(sharedBase)) {
    pushSection('NanoClaw Runtime Contract', fs.readFileSync(sharedBase, 'utf-8'));
  }

  pushSection('Memory System', MEMORY_POINTER);
  pushSection('Native Runtime Skills', NATIVE_RUNTIME_SKILLS_POINTER);

  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir).sort()) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (moduleName === 'cli' && cliDisabled) continue;
      pushSection(`NanoClaw Module: ${moduleName}`, fs.readFileSync(path.join(mcpToolsHostDir, entry), 'utf-8'));
    }
  }

  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) {
      pushSection(`MCP Server: ${name}`, mcp.instructions);
    }
  }

  const content = fitAgentsMdToCap(group, sections);
  writeAtomic(path.join(groupDir, 'AGENTS.md'), content);
}

function renderAgentsMd(sections: AgentsMdSection[]): string {
  return (
    sections
      .map((section) => section.content.trim())
      .filter(Boolean)
      .join('\n\n') + '\n'
  );
}

/**
 * Fit the doc under Codex's 32KB project-doc cap by DEGRADING, never
 * throwing: a per-spawn throw rides wakeContainer's transient-retry contract
 * — host-sweep respawns every 60s forever and the group goes silently dark.
 * Instead, drop the largest optional instruction sections (per-module and
 * per-MCP-server) until the doc fits, log what was dropped at error level,
 * and tell the agent in the doc itself. The core contract (header, runtime
 * contract, memory, skills pointer) is never dropped.
 */
function fitAgentsMdToCap(group: AgentGroup, sections: AgentsMdSection[]): string {
  const sectionBytes = (): { section: string; bytes: number }[] =>
    sections.map((section) => ({ section: section.name, bytes: Buffer.byteLength(section.content, 'utf-8') }));

  const isDroppable = (s: AgentsMdSection): boolean =>
    s.name.startsWith('MCP Server: ') || s.name.startsWith('NanoClaw Module: ');

  const dropped: string[] = [];
  const render = (): string => {
    const parts = [...sections];
    if (dropped.length > 0) {
      parts.push({
        name: 'omitted',
        content:
          `# Omitted for size\n\nThese instruction sections were omitted to fit Codex's project-doc cap: ` +
          `${dropped.join(', ')}. Their tools still work; consult each tool's own description.`,
      });
    }
    return renderAgentsMd(parts);
  };

  let content = render();
  while (Buffer.byteLength(content, 'utf-8') > CODEX_PROJECT_DOC_MAX_BYTES) {
    const candidates = sections
      .filter(isDroppable)
      .sort((a, b) => Buffer.byteLength(b.content, 'utf-8') - Buffer.byteLength(a.content, 'utf-8'));
    if (candidates.length === 0) break; // only core left — write oversized rather than brick the group
    sections.splice(sections.indexOf(candidates[0]), 1);
    dropped.push(candidates[0].name);
    content = render();
  }

  const bytes = Buffer.byteLength(content, 'utf-8');
  if (dropped.length > 0) {
    log.error('AGENTS.md exceeded Codex project-doc cap — dropped largest instruction sections', {
      group: group.name,
      bytes,
      maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      dropped,
      sections: sectionBytes(),
    });
  } else if (bytes >= CODEX_PROJECT_DOC_WARN_BYTES) {
    log.warn('AGENTS.md is near Codex project-doc cap', {
      group: group.name,
      bytes,
      warnBytes: CODEX_PROJECT_DOC_WARN_BYTES,
      maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      sections: sectionBytes(),
    });
  }
  return content;
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
