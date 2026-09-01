/**
 * `ncl files` — read + edit an agent group's workspace (`groups/<folder>/`,
 * the directory mounted RW at /workspace/agent in the container).
 *
 * Per the governance review decision, the WHOLE workspace is user-visible and
 * user-editable — no per-file allowlist — with two carve-outs the mount
 * already implies:
 *  - composer-managed artifacts (root CLAUDE.md, container.json) are
 *    read-only here exactly as their nested RO mounts make them in-container;
 *  - dot entries are hidden (composer plumbing: .claude-fragments,
 *    .claude-shared.md, …).
 *
 * Guards, not scoping: names are charset-checked, resolved paths must stay
 * inside the workspace, content is text-only and size-capped, and `write`
 * only updates files that already exist (the surface edits memory; it does
 * not create trees). Callers are untrusted at this boundary.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerResource } from '../crud.js';

const SEGMENT_RE = /^[A-Za-z0-9 ._-]+$/;
const MAX_DEPTH = 8;
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
/** Root-level files the composer owns — read-only on this surface. */
const READONLY_ROOT = new Set(['CLAUDE.md', 'container.json']);

export interface WorkspaceEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  readonly: boolean;
}

async function workspaceDir(agentGroupId: string): Promise<string> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) throw new Error(`agent group not found: ${agentGroupId}`);
  return path.join(GROUPS_DIR, group.folder);
}

function requireGroup(args: Record<string, unknown>): string {
  const group = (args.group ?? args.id) as string | undefined;
  if (!group) throw new Error('--group <agent-group-id> is required');
  return group;
}

/** Validate a workspace-relative path and resolve it under the root; '' is
 *  the root itself. Dot segments (hidden plumbing) are rejected outright. */
function resolveRel(root: string, rel: string): string {
  if (rel === '') return root;
  if (rel.length > 512) throw new Error('path too long');
  const segments = rel.split('/');
  if (segments.length > MAX_DEPTH) throw new Error('path too deep');
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..' || seg.startsWith('.')) {
      throw new Error(`invalid path segment: ${seg}`);
    }
  }
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`path escapes workspace: ${rel}`);
  return full;
}

function isReadonly(rel: string): boolean {
  return READONLY_ROOT.has(rel);
}

async function listEntries(agentGroupId: string, rel: string): Promise<WorkspaceEntry[]> {
  const root = await workspaceDir(agentGroupId);
  const dir = resolveRel(root, rel);
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) throw new Error(`not a directory: ${rel || '/'}`);
  const out: WorkspaceEntry[] = [];
  let hidden = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue; // composer plumbing, by design
    if (!SEGMENT_RE.test(entry.name)) {
      hidden++;
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push({ name: entry.name, type: 'dir', size: 0, readonly: false });
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(path.join(dir, entry.name)).size;
      } catch {
        continue;
      }
      out.push({ name: entry.name, type: 'file', size, readonly: isReadonly(childRel) });
    }
  }
  // Never a silent cap: callers can tell the listing is partial.
  if (hidden > 0)
    out.push({ name: `(${hidden} entries hidden — unsupported names)`, type: 'file', size: 0, readonly: true });
  return out;
}

async function readFileRel(
  agentGroupId: string,
  rel: string,
): Promise<{ path: string; content: string; size: number; truncated: boolean; readonly: boolean }> {
  if (!rel) throw new Error('--path <file> is required');
  const root = await workspaceDir(agentGroupId);
  const full = resolveRel(root, rel);
  if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) throw new Error(`not a file: ${rel}`);
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) throw new Error(`${rel} is binary — not viewable here`);
  const truncated = buf.length > MAX_READ_BYTES;
  return {
    path: rel,
    content: buf.subarray(0, MAX_READ_BYTES).toString('utf8'),
    size: buf.length,
    truncated,
    readonly: isReadonly(rel),
  };
}

async function writeFileRel(
  agentGroupId: string,
  rel: string,
  content: string,
): Promise<{ written: string; bytes: number }> {
  if (!rel) throw new Error('--path <file> is required');
  if (typeof content !== 'string') throw new Error('--content is required');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes`);
  const root = await workspaceDir(agentGroupId);
  const full = resolveRel(root, rel);
  if (isReadonly(rel)) throw new Error(`${rel} is composer-managed — read-only`);
  if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) {
    throw new Error(`not an existing file: ${rel} (this surface edits files; it doesn't create them)`);
  }
  fs.writeFileSync(full, content, 'utf8');
  return { written: rel, bytes };
}

registerResource({
  name: 'file',
  plural: 'files',
  // Filesystem-backed (the group's workspace dir) — no DB table.
  table: '',
  description:
    "An agent group's workspace (groups/<folder>/, the RW /workspace/agent mount). " +
    'Whole-workspace list/read/write with containment guards; composer artifacts are read-only. ' +
    'Drives the Slack-home Memory tab.',
  idColumn: 'path',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'Entries of a workspace directory. --group <agent-group-id> [--path <rel-dir>].',
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        return { entries: await listEntries(requireGroup(a), (a.path as string | undefined) ?? '') };
      },
    },
    read: {
      access: 'open',
      description:
        'A workspace text file (size-capped, flagged when truncated). --group <agent-group-id> --path <rel-file>.',
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        return await readFileRel(requireGroup(a), (a.path as string | undefined) ?? '');
      },
    },
    write: {
      access: 'open',
      description:
        'Overwrite an existing workspace text file (never composer artifacts, never new files). ' +
        '--group <agent-group-id> --path <rel-file> --content <text>.',
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        return await writeFileRel(requireGroup(a), (a.path as string | undefined) ?? '', a.content as string);
      },
    },
  },
});
