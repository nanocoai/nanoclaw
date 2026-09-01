/**
 * `ncl skills` — read + move skills in and out of an agent group's skills
 * directory (`data/v2-sessions/<group>/.claude-shared/skills/`, mounted RW at
 * /home/node/.claude/skills in the container).
 *
 * Two kinds live side by side there:
 *  - `shared`   — symlinks into the RO /app/skills mount (built-in container
 *                 skills, selected by container_configs.skills). Opaque to
 *                 this resource: never exported, never overwritten.
 *  - `personal` — real directories (template-installed or agent-authored).
 *                 These are what "share with team" moves.
 *
 * `export` returns a personal skill as a bounded file-map; `add` writes one
 * back. Both sides are guarded (slug names, relative segment-checked paths,
 * text-only, size caps) — callers are untrusted by default even though
 * today's only client is the governance service's Skills tab. New sessions
 * discover added skills automatically (CLAUDE.md is recomposed per spawn);
 * running containers see them next session.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { registerResource } from '../crud.js';

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_FILES = 48;
const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

export interface SkillEntry {
  name: string;
  kind: 'shared' | 'personal';
  /** First line of the SKILL.md frontmatter description (personal skills). */
  description: string;
}

function groupSkillsDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
}

function requireGroup(args: Record<string, unknown>): string {
  const group = (args.group ?? args.id) as string | undefined;
  if (!group) throw new Error('--group <agent-group-id> is required');
  return group;
}

function requireName(args: Record<string, unknown>): string {
  const name = args.name as string | undefined;
  if (!name) throw new Error('--name <skill> is required');
  if (!NAME_RE.test(name)) throw new Error(`invalid skill name: ${name}`);
  return name;
}

/** One-line description out of SKILL.md YAML frontmatter, else ''. */
function readSkillDescription(skillDir: string): string {
  try {
    const text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8').slice(0, 8192);
    const m = text.match(/^description:\s*(.+)$/m);
    return m ? m[1]!.trim().slice(0, 300) : '';
  } catch {
    return '';
  }
}

function listSkills(agentGroupId: string): SkillEntry[] {
  const dir = groupSkillsDir(agentGroupId);
  if (!fs.existsSync(dir)) return [];
  const entries: SkillEntry[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      entries.push({ name, kind: 'shared', description: '' });
    } else if (st.isDirectory()) {
      entries.push({ name, kind: 'personal', description: readSkillDescription(full) });
    }
  }
  return entries;
}

/** Reject anything but plain nested filenames — the file-map is attacker
 *  input at this boundary (zero-trust: enforce here, not in the UI). */
function validateRelPath(rel: string): void {
  if (rel.length > 512) throw new Error(`file path too long: ${rel.slice(0, 80)}…`);
  const segments = rel.split('/');
  if (segments.length > MAX_DEPTH) throw new Error(`file path too deep: ${rel}`);
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..') {
      throw new Error(`invalid path segment in: ${rel}`);
    }
  }
}

function exportSkill(
  agentGroupId: string,
  name: string,
): { name: string; description: string; files: Record<string, string> } {
  const dir = path.join(groupSkillsDir(agentGroupId), name);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    throw new Error(`skill not found: ${name}`, { cause: err });
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`skill ${name} is a shared built-in — only personal skills export`);
  }

  const files: Record<string, string> = {};
  let total = 0;
  let count = 0;
  const walk = (sub: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue; // never follow links out of the tree
      if (entry.isDirectory()) {
        walk(rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++count > MAX_FILES) throw new Error(`skill ${name} has too many files (max ${MAX_FILES})`);
      const buf = fs.readFileSync(path.join(dir, rel));
      if (buf.length > MAX_FILE_BYTES) throw new Error(`${rel} exceeds ${MAX_FILE_BYTES} bytes`);
      if (buf.includes(0)) continue; // binary — skip rather than corrupt
      total += buf.length;
      if (total > MAX_TOTAL_BYTES) throw new Error(`skill ${name} exceeds ${MAX_TOTAL_BYTES} bytes total`);
      files[rel] = buf.toString('utf8');
    }
  };
  walk('', 0);
  if (!files['SKILL.md']) throw new Error(`skill ${name} has no SKILL.md — not exportable`);
  return { name, description: readSkillDescription(dir), files };
}

function addSkill(agentGroupId: string, name: string, files: Record<string, string>): { added: string; files: number } {
  const entries = Object.entries(files);
  if (entries.length === 0) throw new Error('empty file map');
  if (entries.length > MAX_FILES) throw new Error(`too many files (max ${MAX_FILES})`);
  if (!files['SKILL.md']) throw new Error('file map must include SKILL.md');
  let total = 0;
  for (const [rel, content] of entries) {
    validateRelPath(rel);
    if (typeof content !== 'string') throw new Error(`non-text content for ${rel}`);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`${rel} exceeds ${MAX_FILE_BYTES} bytes`);
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error(`skill exceeds ${MAX_TOTAL_BYTES} bytes total`);
  }

  const skillsDir = groupSkillsDir(agentGroupId);
  fs.mkdirSync(skillsDir, { recursive: true });
  const dest = path.join(skillsDir, name);
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(dest);
  } catch {
    /* new skill */
  }
  if (existing?.isSymbolicLink()) {
    throw new Error(`skill ${name} collides with a shared built-in — pick another name`);
  }
  if (existing) fs.rmSync(dest, { recursive: true });

  for (const [rel, content] of entries) {
    const full = path.join(dest, rel);
    // Belt over the segment checks: the resolved path must stay inside dest.
    if (!path.resolve(full).startsWith(path.resolve(dest) + path.sep) && path.resolve(full) !== path.resolve(dest)) {
      throw new Error(`path escapes skill dir: ${rel}`);
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return { added: name, files: entries.length };
}

registerResource({
  name: 'skill',
  plural: 'skills',
  // Filesystem-backed (the group's .claude-shared/skills dir) — no DB table.
  table: '',
  description:
    "Skills in an agent group's skills directory. shared = built-in symlinks (opaque); " +
    'personal = real folders (template-installed or agent-authored) — exportable as a bounded ' +
    "file-map and re-addable to other groups. Drives the Slack-home Skills tab's team library.",
  idColumn: 'name',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: "The group's skills with kind (shared|personal) + description. --group <agent-group-id>.",
      handler: async (args) => ({ skills: listSkills(requireGroup(args as Record<string, unknown>)) }),
    },
    export: {
      access: 'open',
      description:
        'A personal skill as {name, description, files:{relPath:content}} (text only, size-capped). ' +
        '--group <agent-group-id> --name <skill>.',
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        return exportSkill(requireGroup(a), requireName(a));
      },
    },
    add: {
      access: 'open',
      description:
        'Write a skill file-map into the group (new or replacing a personal skill; never a shared name). ' +
        '--group <agent-group-id> --name <skill> --files <json map relPath→content>.',
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        const group = requireGroup(a);
        const name = requireName(a);
        let files: Record<string, string>;
        if (typeof a.files === 'string') {
          try {
            files = JSON.parse(a.files) as Record<string, string>;
          } catch (err) {
            throw new Error('--files is not valid JSON', { cause: err });
          }
        } else if (typeof a.files === 'object' && a.files !== null) {
          files = a.files as Record<string, string>;
        } else {
          throw new Error('--files <json map> is required');
        }
        return addSkill(group, name, files);
      },
    },
  },
});
