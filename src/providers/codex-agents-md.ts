/**
 * AGENTS.md spec for codex agent groups — the MIXED-VERSION COMPATIBILITY path.
 *
 * On a core with the provider contracts, AGENTS.md instructions come from the
 * core-owned canonical template rendered with the instruction facts the codex
 * host contract declares (`src/provider-contracts/codex.ts`); this module is
 * never reached there. On a core that predates the contracts, the legacy host
 * adapter composes AGENTS.md through this spec, whose extra sections and base
 * document (`container/AGENTS.md`) preserve the exact document those cores
 * always produced. Both core generations still type `baseDocPath` and
 * `extraSections` on `ProjectDocSpec` (deprecated on the contract core), so
 * the spec is typed directly.
 *
 * `project_doc_max_bytes` is mirrored in the container provider's config.toml
 * writer. Over the cap the shared composer degrades — it drops the largest
 * capability sections, logs what went, and says so in the document — rather
 * than throwing, which would ride `wakeContainer`'s retry contract and dark
 * the group.
 */
import path from 'path';

import { composeGroupProjectDoc, type ProjectDocSpec } from '../project-doc-compose.js';
import type { AgentGroup } from '../types.js';

export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

export const CODEX_PROJECT_DOC_EXTRA_SECTIONS = [
  {
    name: 'Memory System',
    body: [
      'The live memory index and definition are supplied by NanoClaw at session startup, clear, and after compaction.',
      'Editable memory-system definition: `/workspace/agent/memory/system/definition.md`.',
      'Top memory index: `/workspace/agent/memory/index.md`.',
      'Read the definition and index, then use linked memory files and conversation archives when relevant.',
      'Stored user preferences are binding: read any linked memory file relevant to the user or the request, and apply it without being asked.',
      'Do not use `AGENTS.local.md` or `AGENTS.override.md` for memory.',
    ].join('\n\n'),
  },
  {
    name: 'Native Runtime Skills',
    body: [
      'Selected NanoClaw runtime skills are available as Codex-native skills at `/workspace/agent/.agents/skills`.',
      'Each skill directory contains a `SKILL.md` with its trigger description plus any supporting files, and points to the read-only shared skill source under `/app/skills`.',
      'Use skill discovery to load these skills only when their descriptions match the task. A skill whose rules must hold before the task is recognised ships an `instructions.md` instead, and those arrive inlined as `NanoClaw Skill:` sections of this document.',
      'Skills YOU author or install yourself go in `~/.codex/skills/<name>/SKILL.md` — persistent across sessions and discovered by Codex automatically. Never write skills elsewhere: paths outside `~/.codex` and `~/.agents` are ephemeral or not discovered.',
    ].join('\n\n'),
  },
];

const CODEX_PROJECT_DOC: ProjectDocSpec = {
  fileName: 'AGENTS.md',
  baseDocPath: path.join('container', 'AGENTS.md'),
  extraSections: CODEX_PROJECT_DOC_EXTRA_SECTIONS,
  maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
};

export function composeGroupAgentsMd(group: AgentGroup, groupDir: string): Promise<void> {
  // Pre-contract cores read baseDocPath/extraSections; contract cores ignore
  // them (and never call this path for surfaces).
  return composeGroupProjectDoc(group, groupDir, CODEX_PROJECT_DOC);
}
