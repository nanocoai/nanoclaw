/**
 * Skill-catalog discovery for non-Claude providers.
 *
 * Claude Code natively surfaces skills via its `Skill` tool — the agent
 * sees a list of (name, description) pairs at runtime and reads the full
 * SKILL.md body on demand when one matches a request. Other providers
 * (Codex, OpenCode, future Gemini/Ollama, etc.) don't have this discovery
 * mechanism, so any per-group prompt that says "use the make-website skill"
 * dangles — the tool doesn't exist, the body isn't loaded.
 *
 * `composeAvailableSkills` builds the same name+description list as a
 * markdown section that any provider can inject into its system prompt
 * (Codex appends to baseInstructions; OpenCode writes to a tmp file and
 * adds it to its `instructions` array). We deliberately don't inline each
 * SKILL.md's full body — that's tens of KB across the catalog and most
 * skills won't apply to any given turn. The discovery list directs the
 * agent to read the full SKILL.md when a description matches, mirroring
 * Claude Code's lazy-load model and keeping prompt overhead proportional
 * to skill count rather than skill size.
 *
 * The skills directory defaults to `/home/node/.claude/skills` — the
 * per-group symlinks the host writes from `claude-md-compose.ts`. This
 * scopes naturally to whichever skills the group's `container.json`
 * selected; disabled skills aren't symlinked, so they don't appear here.
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_SKILLS_DIR = '/home/node/.claude/skills';

export interface SkillCatalogEntry {
  name: string;
  description: string;
}

export function listAvailableSkills(skillsDir = DEFAULT_SKILLS_DIR): SkillCatalogEntry[] {
  if (!fs.existsSync(skillsDir)) return [];
  const entries: SkillCatalogEntry[] = [];
  for (const dirent of fs.readdirSync(skillsDir).sort()) {
    const skillMdPath = path.join(skillsDir, dirent, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    const raw = fs.readFileSync(skillMdPath, 'utf-8');
    const fm = parseFrontmatter(raw);
    const description = fm.description?.trim();
    if (!description) continue;
    entries.push({ name: fm.name ?? dirent, description });
  }
  return entries;
}

export function composeAvailableSkills(skillsDir = DEFAULT_SKILLS_DIR): string | undefined {
  const entries = listAvailableSkills(skillsDir);
  if (entries.length === 0) return undefined;

  const list = entries.map((e) => `- **${e.name}** — ${e.description}`).join('\n');
  return [
    '# Available skills',
    '',
    "When the user's request matches a skill below, your first action is to `Read /app/skills/<name>/SKILL.md` and follow the recipe inside before doing the work. The skill's instructions take precedence over your defaults for the task it covers.",
    '',
    list,
  ].join('\n');
}

/**
 * Minimal YAML frontmatter parser — extracts `key: value` pairs from an
 * opening `---`/`---` block. Good enough for the SKILL.md schema (flat
 * scalar fields). Doesn't handle nested objects or multiline strings; if
 * a skill grows those, expand here.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}
