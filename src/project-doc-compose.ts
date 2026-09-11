/**
 * Project-document composition for agent groups.
 *
 * One flat file per group: standing instructions, the provider's base document,
 * its pointer blocks, and one section per enabled capability. Every source is
 * read here, on the host, and written out as text.
 *
 * LOAD-BEARING: nothing may become a pointer again. This previously emitted `@`
 * imports at symlinks under `/app`; a Claude Code update then gated imports
 * resolving outside the project directory behind an approval a headless
 * container cannot give, and eight of nine sections silently stopped arriving.
 * `project-doc-compose.test.ts` ("emits no @ import lines") goes red if it
 * returns.
 *
 * Runs on every container start, so editing a source still reaches every agent
 * on its next spawn.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseSkillSelection, sanitizeStoredMcpServers } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { readGroupPersona } from './group-persona.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

/** One `# <name>` block of the composed document. */
interface ProjectDocSection {
  /** Rendered as the heading, and what the size ladder names when it drops one. */
  name: string;
  /** Section body, without the heading. */
  body: string;
  /** Evicted first under `maxBytes`. */
  droppable: boolean;
}

/**
 * Typed provider variables rendered into the canonical instruction template.
 * The template prose is core-owned (`container/CLAUDE.md` is the canon);
 * providers supply only the facts below — paths, filenames, and flags — never
 * their own instruction text, so every provider's agent reads the same ideas.
 */
export interface ProviderInstructionFacts {
  /**
   * Provider-native override files agents must not use for memory storage
   * (e.g. files the provider's own runtime auto-loads). Rendered as one
   * canonical sentence inside the Memory section.
   */
  nativeOverrideFiles?: readonly string[];
  /**
   * Provider-native skill discovery, rendered as the canonical runtime-skills
   * section. Absent when the provider's runtime discovers the shared skills
   * without document guidance.
   */
  nativeSkills?: {
    /** Where the selected runtime skills appear inside the container. */
    discoveryPath: string;
    /** The read-only shared skill source the entries point back to. */
    sharedSource: string;
    /** Where agent-authored skills go, e.g. `~/.codex/skills`. */
    selfAuthoredHome: string;
    /** The only roots where skills persist and are discovered. */
    persistentRoots: readonly string[];
    /** Whether rule-bearing skills arrive inlined as sections of this document. */
    ruleBearingInlined?: boolean;
  };
}

/** Everything that differs between providers. The composition itself does not. */
export interface ProjectDocSpec {
  /** File written into the group directory, e.g. `CLAUDE.md`. */
  fileName: string;
  /** Provider variables for the canonical instruction template. */
  instructions?: ProviderInstructionFacts;
  /** @deprecated Pre-contract payload input; new contracts use the core-owned canon. */
  baseDocPath?: string;
  /** @deprecated Pre-contract payload input; new contracts use typed instruction facts. */
  extraSections?: { name: string; body: string }[];
  /** Hard byte cap. Undefined means no cap and no degradation ladder. */
  maxBytes?: number;
}

/** The canonical instruction template, relative to the project root. */
export const BASE_INSTRUCTIONS_PATH = path.join('container', 'CLAUDE.md');

/** Placeholder inside the canon's Memory section for the provider override-files note. */
export const MEMORY_NOTE_PLACEHOLDER = '{{provider-memory-note}}';

/**
 * Render the canonical base instructions with the provider's memory note
 * substituted (or the placeholder stripped without a trace). The no-facts
 * render is byte-identical to the template minus the placeholder paragraph.
 */
export function renderBaseInstructions(template: string, facts?: ProviderInstructionFacts): string {
  const files = facts?.nativeOverrideFiles ?? [];
  const note =
    files.length > 0 ? `Do not use ${files.map((file) => `\`${file}\``).join(' or ')} for memory.` : undefined;
  return template.replace(`\n\n${MEMORY_NOTE_PLACEHOLDER}`, note ? `\n\n${note}` : '');
}

/**
 * Render the canonical runtime-skills section from the provider's declared
 * discovery facts. One prose for every provider; only the paths differ.
 */
export function renderNativeSkillsSection(
  facts?: ProviderInstructionFacts,
): { name: string; body: string } | undefined {
  const skills = facts?.nativeSkills;
  if (!skills) return undefined;
  const roots = skills.persistentRoots.map((root) => `\`${root}\``).join(' and ');
  return {
    name: 'Native Runtime Skills',
    body: [
      `Selected NanoClaw runtime skills are available as provider-native skills at \`${skills.discoveryPath}\`.`,
      `Each skill directory contains a \`SKILL.md\` with its trigger description plus any supporting files, and points to the read-only shared skill source under \`${skills.sharedSource}\`.`,
      'Use skill discovery to load these skills only when their descriptions match the task.' +
        (skills.ruleBearingInlined
          ? ' A skill whose rules must hold before the task is recognised ships an `instructions.md` instead, and those arrive inlined as `NanoClaw Skill:` sections of this document.'
          : ''),
      `Skills YOU author or install yourself go in \`${skills.selfAuthoredHome}/<name>/SKILL.md\` — persistent across sessions and discovered automatically. Never write skills elsewhere: paths outside ${roots} are ephemeral or not discovered.`,
    ].join('\n\n'),
  };
}

/**
 * Claude Code "loads a CLAUDE.md file of up to 4 MiB in full and skips a larger
 * file" (code.claude.com/docs/en/memory, read 2026-08-25). Over the cliff the
 * agent receives NO instructions at all, silently, which is the exact failure
 * this composer was rewritten to end. The only unbounded inputs are the
 * agent-writable persona and template-supplied MCP instructions, so the cap is
 * unreachable in normal use; it is here so the pathological case is loud.
 */
const CLAUDE_PROJECT_DOC_MAX_BYTES = 4 * 1024 * 1024;

/** The spec for any provider that has not declared its own agent surfaces. */
export const DEFAULT_PROJECT_DOC: ProjectDocSpec = {
  fileName: 'CLAUDE.md',
  maxBytes: CLAUDE_PROJECT_DOC_MAX_BYTES,
};

// LOAD-BEARING: `.claude/skills/migrate-memory` classifies a staged legacy
// project document as generated boilerplate by matching this prefix, so it must
// stay the literal first characters of the file for every provider. Without it
// a migration imports the whole runtime contract into a group's memory tree.
// `project-doc-compose.test.ts` ("starts with the composed-at-spawn marker")
// goes red if it moves.
const COMPOSED_HEADER =
  '<!-- Composed at spawn - do not edit. Standing instructions: instructions.prepend.md. Memory: memory/. -->';

const BASE_DOC_SECTION = 'NanoClaw Runtime Contract';

// Instruction docs that only teach `ncl`, and so are dead weight when the agent
// has none: host dispatch rejects every cli_request at cli_scope=disabled, and
// scheduling teaches `ncl tasks`.
const NCL_DEPENDENT_MODULES = new Set(['cli', 'scheduling']);

// Resolved at call time (process.cwd() = project root) so tests can swap cwd.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');
const SKILLS_HOST_SUBPATH = path.join('container', 'skills');

/**
 * Regenerate `groups/<folder>/<spec.fileName>` from every instruction source
 * the group has switched on. Deterministic: same inputs, same file.
 *
 * Reads nothing the agent can author except `instructions.prepend.md`, which
 * `readGroupPersona` opens with O_NOFOLLOW.
 */
export async function composeGroupProjectDoc(group: AgentGroup, groupDir: string, spec: ProjectDocSpec): Promise<void> {
  if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });

  const configRow = await getContainerConfig(group.id);
  // Re-validated rather than cast: these `instructions` strings are the only
  // stored, agent-influenced text copied verbatim into the system prompt.
  const mcpServers = sanitizeStoredMcpServers(configRow ? JSON.parse(configRow.mcp_servers) : {}, group.name);
  const selectedSkills = parseSkillSelection(configRow?.skills, group.name);

  const sections: ProjectDocSection[] = [];
  const push = (name: string, body: string, droppable = false): void => {
    const trimmed = body.trim();
    if (trimmed) sections.push({ name, body: trimmed, droppable });
  };

  // The group's standing instructions lead the document, and are never
  // droppable: a group whose persona is evicted stops being that group.
  const persona = readGroupPersona(groupDir);
  if (persona) push('Persona', persona);

  const legacySpec = spec.baseDocPath !== undefined;
  const baseDoc = path.resolve(process.cwd(), spec.baseDocPath ?? BASE_INSTRUCTIONS_PATH);
  if (fs.existsSync(baseDoc)) {
    const template = fs.readFileSync(baseDoc, 'utf-8');
    push(BASE_DOC_SECTION, legacySpec ? template : renderBaseInstructions(template, spec.instructions));
  } else {
    // Tolerated (a partial checkout has no template yet) but never silent:
    // losing the runtime contract with no signal is the exact shape of the bug
    // this composer replaced, and it is also what a wrong-cwd host looks like.
    log.warn('Project document composed without its base document', {
      file: spec.fileName,
      group: group.name,
      baseDoc,
    });
  }

  for (const section of spec.extraSections ?? []) push(section.name, section.body);

  const nativeSkills = renderNativeSkillsSection(spec.instructions);
  if (nativeSkills) push(nativeSkills.name, nativeSkills.body);

  // Module instructions — every MCP/CLI module shipping a sibling
  // `<name>.instructions.md`, describing how to use that module's tools.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir).sort()) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (cliDisabled && NCL_DEPENDENT_MODULES.has(moduleName)) continue;
      push(`NanoClaw Module: ${moduleName}`, fs.readFileSync(path.join(mcpToolsHostDir, entry), 'utf-8'), true);
    }
  }

  // Resident skill prose. A skill's `SKILL.md` is loaded on demand by skill
  // discovery; its `instructions.md` has to be in context before the agent
  // knows it needs it, because a prohibition cannot be lazily loaded. Same
  // selection as the links the runner plants — one parse, see above.
  const skillsHostDir = path.join(process.cwd(), SKILLS_HOST_SUBPATH);
  if (fs.existsSync(skillsHostDir)) {
    for (const skillName of fs.readdirSync(skillsHostDir).sort()) {
      if (selectedSkills !== 'all' && !selectedSkills.includes(skillName)) continue;
      const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
      if (!fs.existsSync(hostFragment)) continue;
      push(`NanoClaw Skill: ${skillName}`, fs.readFileSync(hostFragment, 'utf-8'), true);
    }
  }

  // Inline instructions from container.json for user-added external MCP servers.
  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) push(`MCP Server: ${name}`, mcp.instructions, true);
  }

  const content =
    spec.maxBytes === undefined ? render(sections) : fitToCap(sections, spec.maxBytes, spec.fileName, group.name);
  writeAtomic(path.join(groupDir, spec.fileName), content);
}

function block(section: ProjectDocSection): string {
  return `# ${section.name}\n\n${section.body}`;
}

function render(sections: ProjectDocSection[]): string {
  return [COMPOSED_HEADER, ...sections.map(block)].join('\n\n') + '\n';
}

/**
 * Fit the document under a provider's project-doc cap by DEGRADING, never
 * throwing: a per-spawn throw rides `wakeContainer`'s transient-retry contract,
 * so host-sweep respawns every 60s forever and the group goes silently dark.
 * Instead drop the largest droppable sections until it fits, log what went at
 * error level, and say so in the document itself. Persona, base document and
 * the provider's own blocks are never droppable.
 */
function fitToCap(sections: ProjectDocSection[], maxBytes: number, fileName: string, groupName: string): string {
  const dropped: string[] = [];
  const renderWithNotice = (): string => {
    const parts = [...sections];
    if (dropped.length > 0) {
      parts.push({
        name: 'Omitted for size',
        body:
          'These instruction sections were omitted to fit the project-document size cap: ' +
          `${dropped.join(', ')}. Their tools still work; consult each tool's own description.`,
        droppable: false,
      });
    }
    return render(parts);
  };

  let content = renderWithNotice();
  while (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    const [largest] = sections
      .filter((s) => s.droppable)
      .sort((a, b) => Buffer.byteLength(block(b), 'utf-8') - Buffer.byteLength(block(a), 'utf-8'));
    if (!largest) break; // Only core left — write oversized rather than brick the group.
    sections.splice(sections.indexOf(largest), 1);
    dropped.push(largest.name);
    content = renderWithNotice();
  }

  const bytes = Buffer.byteLength(content, 'utf-8');
  const sectionBytes = (): { section: string; bytes: number }[] =>
    sections.map((s) => ({ section: s.name, bytes: Buffer.byteLength(block(s), 'utf-8') }));
  if (dropped.length > 0) {
    log.error('Project document exceeded its size cap — dropped the largest instruction sections', {
      file: fileName,
      group: groupName,
      bytes,
      maxBytes,
      dropped,
      sections: sectionBytes(),
    });
    return content;
  }
  // One warning while there is still headroom, so pressure is visible before
  // sections start disappearing.
  const warnBytes = Math.floor(maxBytes - maxBytes / 8);
  if (bytes >= warnBytes) {
    log.warn('Project document is near its size cap', {
      file: fileName,
      group: groupName,
      bytes,
      warnBytes,
      maxBytes,
      sections: sectionBytes(),
    });
  }
  return content;
}

/**
 * LOAD-BEARING, both halves. The group directory is mounted read-write at
 * `/workspace/agent`, so the agent can create entries beside the document the
 * host is about to write. A predictable temp name (the old `.tmp-<pid>`, and
 * the host pid is stable for the life of the process) is therefore a path the
 * agent can pre-plant: a symlink there redirects this write to any file the
 * host user can reach, and a directory there fails the spawn on every retry.
 *
 * The random name means there is nothing to pre-plant; `wx` (O_CREAT|O_EXCL)
 * refuses an existing path, symlink included, so a lucky guess fails closed;
 * and the cleanup cannot throw, because a leftover temp file must never be
 * able to dark a group. Mirrors `migrate-claude-memory-settings.ts`, which
 * runs once at startup and so can use pid+time where this needs randomness.
 */
function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The rename consumed the temp file, or creation failed before it existed.
    }
  }
}
