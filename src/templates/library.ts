/**
 * The public template library (nanocoai/nanoclaw-templates): its index, and
 * fetching one template into the local templates/ dir. Shared by the setup
 * wizard, `ncl templates list` and the create_agent delivery action.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { TEMPLATES_DIR } from '../config.js';
import { log } from '../log.js';
import { isValidTemplateRef, resolveLocalTemplate } from './local-dir.js';
import { parsePluginManifest, PLUGIN_MANIFEST_FILE } from './manifest.js';
import { parseTemplate } from './parse.js';
import { copyPluginDir } from './plugin-dir.js';

const execFileAsync = promisify(execFile);

const LIBRARY_REPO = 'nanocoai/nanoclaw-templates';
const LIBRARY_BRANCH = 'main';
// Generated and kept in sync with the templates by that repo's CI.
const INDEX_URL = `https://raw.githubusercontent.com/${LIBRARY_REPO}/${LIBRARY_BRANCH}/index.json`;

export interface TemplateEntry {
  ref: string;
  name: string;
}

export interface LibraryTemplate extends TemplateEntry {
  description: string;
}

export interface ClonedRegistry {
  dir: string;
  /** The library commit the clone holds. */
  commit: string;
  cleanup: () => void;
}

// A directory is a template iff it is an Agent Plugins directory — the
// manifest is the discovery marker. The pre-plugin layout is detected only to
// point the operator at a re-fetch.
const LEGACY_MARKER = 'context/instructions.md';

/**
 * The clone command. Library content is data: symlinks check out as plain
 * files, and Git LFS never runs (a commit's .lfsconfig could point it anywhere).
 */
export function cloneArgs(dir: string): string[] {
  return [
    '-c',
    'core.symlinks=false',
    '-c',
    'core.hooksPath=/dev/null',
    'clone',
    '--depth',
    '1',
    '--branch',
    LIBRARY_BRANCH,
    '--',
    `https://github.com/${LIBRARY_REPO}`,
    dir,
  ];
}

/** Shallow-clone the library into a temp dir. Async because the host runs it mid-delivery. */
export async function cloneRegistry(): Promise<ClonedRegistry> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tpl-'));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
  try {
    await execFileAsync('git', cloneArgs(dir), { timeout: 20_000, env });
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'], { env });
    return { dir, commit: stdout.trim(), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    // git's stderr can name proxies, mirrors and temp paths: host log only,
    // never in the error an agent sees.
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    log.warn('Template library clone failed', { detail: stderr.split('\n').pop() });
    throw new Error('Could not clone the template library', { cause: err });
  }
}

export function listTemplatesFromDir(dir: string): TemplateEntry[] {
  if (!fs.existsSync(dir)) return [];
  const rootName = path.basename(path.resolve(dir));
  // Dot folders are never templates (.git, a fetch's staging copy), and nothing
  // inside one counts toward the legacy-layout check either.
  const rels = (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((rel) => !rel.split('/').some((segment) => segment.startsWith('.')));

  const refs = new Set<string>();
  for (const rel of rels) {
    if (rel === PLUGIN_MANIFEST_FILE) refs.add('.');
    else if (rel.endsWith(`/${PLUGIN_MANIFEST_FILE}`)) refs.add(rel.slice(0, -(PLUGIN_MANIFEST_FILE.length + 1)));
  }

  // A context/instructions.md outside any plugin is the pre-plugin template
  // layout. Fail with a pointer instead of silently listing nothing. (The
  // same file INSIDE a plugin — e.g. ai.nanoco.nanoclaw/context/ — is fine.)
  const legacy = rels
    .filter((rel) => rel === LEGACY_MARKER || rel.endsWith(`/${LEGACY_MARKER}`))
    .map((rel) => (rel === LEGACY_MARKER ? '.' : rel.slice(0, -(LEGACY_MARKER.length + 1))))
    .filter((ref) => !isWithinTemplate(ref, refs));
  if (legacy.length > 0) {
    throw new Error(
      `Templates predate the plugin format (no ${PLUGIN_MANIFEST_FILE}): ${legacy.join(', ')}. ` +
        'Re-fetch the template library (and update NanoClaw if fetching does not help).',
    );
  }

  return [...refs]
    .map((ref) => ({ ref, name: ref === '.' ? rootName : (ref.split('/').pop() ?? ref) }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/** True when `ref` equals or sits anywhere below a discovered template ref. */
function isWithinTemplate(ref: string, templateRefs: Set<string>): boolean {
  if (templateRefs.has('.')) return true;
  for (let current = ref; ; ) {
    if (templateRefs.has(current)) return true;
    const cut = current.lastIndexOf('/');
    if (cut === -1) return false;
    current = current.slice(0, cut);
  }
}

/**
 * A template's folder inside a cloned library. Its real path must stay inside
 * the clone, so a symlinked parent folder cannot pull in a host directory.
 */
function libraryTemplateDir(libraryDir: string, ref: string): string {
  if (ref === '.') throw new Error('Cannot copy the registry root as a template');
  const dir = resolveLocalTemplate(ref, libraryDir);
  if (!fs.realpathSync(dir).startsWith(fs.realpathSync(libraryDir) + path.sep)) {
    throw new Error(`Template "${ref}" leaves the template library`);
  }
  return dir;
}

/** A local template's manifest description; undefined when it has none or the manifest is unreadable. */
export function templateDescription(ref: string, base: string = TEMPLATES_DIR): string | undefined {
  try {
    const manifest = path.join(resolveLocalTemplate(ref, base), PLUGIN_MANIFEST_FILE);
    // Never read through a symlink: it could point anywhere on the host.
    if (!fs.lstatSync(manifest).isFile()) return undefined;
    const raw: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    return parsePluginManifest(raw).description;
  } catch {
    return undefined;
  }
}

/** True when a well-formed ref already has a local copy. */
export function hasLocalTemplate(ref: string, base: string = TEMPLATES_DIR): boolean {
  return isValidTemplateRef(ref) && fs.existsSync(path.join(base, ref, PLUGIN_MANIFEST_FILE));
}

/**
 * Make `ref` available under the templates dir, fetching it from the library
 * when there is no local copy. An existing local copy always wins and is never
 * overwritten. `clone` lets a caller reuse a clone it already has (setup) and
 * keeps tests off the network.
 */
export async function ensureTemplateLocal(
  ref: string,
  opts: { base?: string; clone?: () => Promise<ClonedRegistry> } = {},
): Promise<{ dir: string; fetched: boolean; commit?: string }> {
  if (!isValidTemplateRef(ref)) throw new Error(`Invalid template ref: "${ref}"`);
  const base = opts.base ?? TEMPLATES_DIR;
  const dest = path.join(base, ref);
  if (fs.existsSync(dest)) {
    // The same test the approval card uses (hasLocalTemplate), so the card never
    // promises a download that this then skips.
    if (!fs.existsSync(path.join(dest, PLUGIN_MANIFEST_FILE))) {
      throw new Error(
        `templates/${ref} exists but is not a template (no ${PLUGIN_MANIFEST_FILE}); remove it to fetch "${ref}"`,
      );
    }
    return { dir: dest, fetched: false };
  }

  const registry = await (opts.clone ?? cloneRegistry)();
  try {
    if (!fs.existsSync(path.join(registry.dir, ref, PLUGIN_MANIFEST_FILE))) {
      throw new Error(`"${ref}" is not in the template library`);
    }
    // Stage in a hidden sibling and rename only a copy that parses: a crash or
    // a bad template must never leave something that wins as the local copy.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(dest), `.${path.basename(dest)}.fetch-`));
    try {
      copyPluginDir(libraryTemplateDir(registry.dir, ref), staging);
      parseTemplate(staging);
      try {
        fs.renameSync(staging, dest);
      } catch (err) {
        // A concurrent fetch of the same ref won the rename: its copy is the same template.
        if (!fs.existsSync(dest)) throw err;
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return { dir: dest, fetched: true, commit: registry.commit };
  } finally {
    registry.cleanup();
  }
}

/** The library's index: every template's ref, name and description, sorted by ref. */
export async function fetchTemplateIndex(fetchImpl: typeof fetch = fetch): Promise<LibraryTemplate[]> {
  let res: Response;
  try {
    res = await fetchImpl(INDEX_URL, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error('Could not reach the template library', { cause: err });
  }
  if (!res.ok) throw new Error(`Could not fetch the template library index (HTTP ${res.status})`);
  return parseTemplateIndex(await res.json());
}

/** The index.json inside a cloned library. */
export function readTemplateIndex(dir: string): LibraryTemplate[] {
  const file = path.join(dir, 'index.json');
  if (!fs.existsSync(file)) throw new Error('The template library has no index.json');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error("The template library's index.json is not valid JSON", { cause: err });
  }
  return parseTemplateIndex(raw);
}

/** index.json groups entries by category: `{ schema: 1, categories: { sales: [entry, …] } }`. */
export function parseTemplateIndex(raw: unknown): LibraryTemplate[] {
  const index = raw as { schema?: unknown; categories?: unknown } | null;
  if (index?.schema !== 1 || typeof index.categories !== 'object' || index.categories === null) {
    throw new Error('The template library index has a format this NanoClaw does not read; update NanoClaw');
  }
  return Object.values(index.categories)
    .flat()
    .filter(isLibraryTemplate)
    .map(({ ref, name, description }) => ({
      ref,
      name,
      description: typeof description === 'string' ? description : '',
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

function isLibraryTemplate(entry: unknown): entry is TemplateEntry & { description?: unknown } {
  const e = entry as Partial<TemplateEntry> | null;
  return typeof e?.ref === 'string' && isValidTemplateRef(e.ref) && typeof e.name === 'string';
}
