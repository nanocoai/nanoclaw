/**
 * Provider-neutral per-group persona ("instructions prepend").
 *
 * A template stamps its standing instructions here (src/templates/create-agent.ts).
 * Each provider's project-doc composer inlines this content at the TOP of the
 * doc it generates every spawn — `CLAUDE.md` (Claude, src/claude-md-compose.ts)
 * or `AGENTS.md` (Codex, src/providers/codex-agents-md.ts on the providers
 * branch) — so a template persona lands at system-prompt tier on every provider
 * rather than in a recall-tier memory file.
 *
 * This module is the single owner of the filename + read semantics so the two
 * composers (one on main, one on the providers donor branch) never hardcode the
 * path independently. Absent file ⇒ null ⇒ no-op for non-template groups.
 */
import fs from 'fs';
import path from 'path';

/** Per-group host file holding the persona prepend. Never regenerated — persistent. */
export const PERSONA_PREPEND_FILE = 'instructions.prepend.md';

/**
 * Read a group's persona prepend from its host dir, or null if absent/empty.
 * `groupDir` is the per-group host directory (`GROUPS_DIR/<folder>`).
 */
export function readGroupPersona(groupDir: string): string | null {
  const file = path.join(groupDir, PERSONA_PREPEND_FILE);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf-8').trim();
  return content.length > 0 ? content : null;
}
