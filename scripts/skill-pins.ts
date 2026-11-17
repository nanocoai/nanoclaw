// Mirrors the npm versions skills pin (SKILL.md fences, container/cli-tools.json),
// which sit outside the root lockfile, into .github/skill-pins/package.json so
// Dependabot and audit tools see them. Pins npm tools can't track go to
// not-covered.json. A package has one version across skills: the shadow file
// (and the host package.json, for nc:dep) can hold only one.
//
//   pnpm run skill-pins:generate  rewrite both files from the skills
//   pnpm run skill-pins:check     fail when they drift (CI), naming the fix
//   pnpm run skill-pins:sync      write a Dependabot bump of the shadow file
//                                 back into the skills

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EXACT_SEMVER, FENCE, parseDirectives, resolveChatCoreVersion, validate } from './skill-directives.js';

export const PINS_DIR = '.github/skill-pins';
export const MANIFEST = `${PINS_DIR}/package.json`;
export const NOT_COVERED = `${PINS_DIR}/not-covered.json`;
const SKILLS_DIR = '.claude/skills';
const CLI_TOOLS = 'container/cli-tools.json';

const GENERATE = 'pnpm run skill-pins:generate';
const SYNC = 'pnpm run skill-pins:sync';

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// A package install or one-off run in a shell line of any SKILL.md fence.
const NPM_INSTALL =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)|yarn\s+global\s+add|yarn\s+dlx|pnpm\s+dlx|npm\s+exec|bun\s+x|npx|pnpx|bunx)(?=\s)/g;
// Installs proper (not one-off runs, which often reach a local binary).
const NPM_ADD = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)|yarn\s+global\s+add)$/;
const PIP_INSTALL = /\b(?:pip3?|pipx|uv\s+pip|uv\s+tool)\s+install(?=\s)/g;
const DOCKER_ARG = /^\s*ARG\s+([A-Z0-9_]*VERSION)=(\S+)/;
const DOCKER_FROM = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i;
const DOCKERFILE = /^(?:Dockerfile(?:\..+)?|.+\.dockerfile)$/i;
const JSON_VERSION = /("version"\s*:\s*")([^"]*)(")/g;
const MANIFEST_ENTRY_KEYS = new Set(['name', 'version', 'onlyBuilt']);
const FOREIGN_MANIFESTS: Record<string, string> = {
  'go.mod': 'gomod',
  'requirements.txt': 'pip',
  'pyproject.toml': 'pip',
  'Cargo.toml': 'cargo',
  Gemfile: 'bundler',
};

export interface NpmPin {
  name: string;
  version: string;
  file: string;
  line: number; // 1-based line holding the version text that sync rewrites
  via: string; // nc:<directive>, 'code block', 'json block' or 'cli-tools.json'
  detail: string; // directive attrs worth showing, e.g. `manager:bun when:x=y`
  edit: 'spec' | 'json'; // a `name@version` token, or a `"version": "…"` field
}

export interface OtherPin {
  pin: string;
  kind: string;
  source: string;
  why: string;
}

export interface Scan {
  npm: NpmPin[];
  other: OtherPin[];
  problems: string[];
}

interface Fence {
  info: string;
  line: number;
  body: Array<{ text: string; line: number }>;
}

const emptyScan = (): Scan => ({ npm: [], other: [], problems: [] });

function merge(into: Scan, from: Scan): void {
  into.npm.push(...from.npm);
  into.other.push(...from.other);
  into.problems.push(...from.problems);
}

// Same pairing as parseDirectives (an opener needs an info string), keeping
// raw line numbers so a pin can be traced to, and rewritten at, its line.
function fences(markdown: string): Fence[] {
  const lines = markdown.split('\n');
  const out: Fence[] = [];
  let i = 0;
  while (i < lines.length) {
    const info = lines[i].match(FENCE)?.[1]?.trim();
    if (info === undefined) {
      i++;
      continue;
    }
    const fence: Fence = { info, line: i + 1, body: [] };
    let j = i + 1;
    while (j < lines.length && !FENCE.test(lines[j])) {
      fence.body.push({ text: lines[j], line: j + 1 });
      j++;
    }
    out.push(fence);
    i = j + 1;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function splitSpec(spec: string): { name: string; version: string } | undefined {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return undefined;
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** Which characters of a shell line sit inside quotes. */
function quoted(line: string): boolean[] {
  const mask: boolean[] = [];
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    mask[i] = quote !== '' || c === '"' || c === "'";
    if (quote) {
      if (c === '\\' && quote === '"') mask[++i] = true;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '\\') mask[++i] = false;
  }
  return mask;
}

/** The line up to a shell comment: an unquoted `#` at the start or after a space. */
function stripComment(line: string): string {
  const mask = quoted(line);
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '#' && !mask[i] && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** Index of `token` as a whole shell word in the line's code part, if it occurs exactly once. */
function wordIndex(line: string, token: string): number | undefined {
  const code = stripComment(line);
  const hits = [...code.matchAll(new RegExp(`(?<=^|[\\s'"=])${escapeRe(token)}(?=$|[\\s'"])`, 'g'))];
  return hits.length === 1 ? hits[0].index : undefined;
}

/** Shell words from `start` to the next unquoted `;`, `&`, `|` or `)`, unquoted. */
function shellWords(text: string, start: number): string[] {
  const out: string[] = [];
  let word: string | undefined;
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      else word += c === '\\' && quote === '"' && i + 1 < text.length ? text[++i] : c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (/[;&|)]/.test(c)) {
      break;
    } else if (/\s/.test(c)) {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + (c === '\\' && i + 1 < text.length ? text[++i] : c);
    }
  }
  if (word !== undefined) out.push(word);
  return out;
}

/** `name@version` words after an unquoted install verb, per shell segment. */
export function installSpecs(line: string): string[] {
  return npmWords(line).pinned;
}

/** Package words after unquoted install verbs: exact pins, and bare names an install adds unpinned. */
function npmWords(line: string): { pinned: string[]; unpinned: string[] } {
  const text = stripComment(line);
  const mask = quoted(text);
  const pinned: string[] = [];
  const unpinned: string[] = [];
  for (const m of text.matchAll(NPM_INSTALL)) {
    if (mask[m.index]) continue; // e.g. echo "never npm install x@1.0.0"
    const adds = NPM_ADD.test(m[0].replace(/\s+/g, ' '));
    for (const word of shellWords(text, m.index + m[0].length)) {
      const token = word.replace(/^--package=/, '');
      const spec = splitSpec(token);
      if (spec && NPM_NAME.test(spec.name) && EXACT_SEMVER.test(spec.version)) pinned.push(token);
      else if (adds && NPM_NAME.test(spec ? spec.name : token)) unpinned.push(token); // bare, a tag or a range
    }
  }
  return { pinned, unpinned };
}

function pipSpecs(line: string): string[] {
  const text = stripComment(line);
  const mask = quoted(text);
  const specs: string[] = [];
  for (const m of text.matchAll(PIP_INSTALL)) {
    if (mask[m.index]) continue;
    for (const token of shellWords(text, m.index + m[0].length)) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?==\S+$/.test(token)) specs.push(token);
    }
  }
  return specs;
}

/** Install pins in a fence, joining `\`-continued lines; each at the line holding it. */
function shellPins(body: Fence['body']): Array<{ spec: string; line: number }> {
  const out: Array<{ spec: string; line: number }> = [];
  let group: Fence['body'] = [];
  const flush = () => {
    const command = group.map((b) => stripComment(b.text).replace(/\\$/, '')).join(' ');
    for (const spec of installSpecs(command)) {
      const at = group.find((b) => wordIndex(b.text, spec) !== undefined) ?? group[0];
      out.push({ spec, line: at.line });
    }
    group = [];
  };
  for (const b of body) {
    group.push(b);
    if (!/\\$/.test(stripComment(b.text))) flush();
  }
  if (group.length) flush();
  return out;
}

/** The one line in `body` that holds a `"version"` field, or undefined. */
function versionLine(body: Fence['body']): number | undefined {
  const hits = body.filter(({ text }) => /"version"\s*:/.test(text));
  return hits.length === 1 ? hits[0].line : undefined;
}

function manifestEntry(text: string): { name: string; version: string } | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const entry = obj as Record<string, unknown>;
  if (typeof entry.name !== 'string' || typeof entry.version !== 'string') return undefined;
  return { name: entry.name, version: entry.version };
}

/** `FROM` base images in Dockerfile lines, skipping earlier stages and variables. */
function baseImages(file: string, lines: string[]): OtherPin[] {
  const stages = new Set<string>();
  const out: OtherPin[] = [];
  for (const line of lines) {
    const m = line.match(DOCKER_FROM);
    if (!m) continue;
    const image = m[1];
    const earlierStage = stages.has(image.toLowerCase());
    if (m[2]) stages.add(m[2].toLowerCase());
    if (earlierStage || image.includes('$') || image === 'scratch') continue;
    out.push({
      pin: image,
      kind: 'container image (Dockerfile FROM)',
      source: file,
      why: "a base image; Dependabot's docker ecosystem could read a Dockerfile, not configured",
    });
  }
  return out;
}

export function scanSkill(file: string, markdown: string): Scan {
  const scan = emptyScan();
  const all = fences(markdown);
  const addNpm = (pin: Omit<NpmPin, 'name' | 'version'>, name: string, version: string) => {
    if (!NPM_NAME.test(name) || !EXACT_SEMVER.test(version)) {
      scan.problems.push(`${file}:${pin.line}: "${name}@${version}" is not an npm name pinned to an exact version`);
      return;
    }
    scan.npm.push({ name, version, ...pin });
  };

  const directives = new Map(parseDirectives(markdown).map((d) => [d.line, d]));
  // A prose ```json block in a skill that names cli-tools.json is an entry an
  // agent is told to add there.
  const mentionsCliTools = markdown.includes(CLI_TOOLS);
  for (const fence of all) {
    const d = directives.get(fence.line);
    const attr = (key: string) => (typeof d?.attrs[key] === 'string' ? `${key}:${d.attrs[key]}` : '');
    const guard = attr('when');
    if (d?.kind === 'dep') {
      const detail = [attr('manager'), attr('cwd'), guard].filter(Boolean).join(' ');
      for (const { text, line } of fence.body) {
        const spec = text.trim();
        if (!spec) continue;
        const parts = splitSpec(spec) ?? { name: spec, version: '' };
        addNpm({ file, line, via: 'nc:dep', detail, edit: 'spec' }, parts.name, parts.version);
      }
      continue;
    }
    if (d?.kind === 'json-merge' && d.attrs.into === CLI_TOOLS) {
      const entry = manifestEntry(d.body.join('\n'));
      const line = versionLine(fence.body);
      if (!entry || line === undefined) {
        scan.problems.push(`${file}:${d.line}: nc:json-merge into ${CLI_TOOLS} needs one {"name","version"} object`);
        continue;
      }
      addNpm({ file, line, via: 'nc:json-merge', detail: guard, edit: 'json' }, entry.name, entry.version);
      continue;
    }
    if (!d && fence.info === 'json' && mentionsCliTools) {
      const text = fence.body.map((b) => b.text).join('\n');
      const entry = manifestEntry(text);
      const keys = entry ? Object.keys(JSON.parse(text) as object) : [];
      const line = versionLine(fence.body);
      if (entry && line !== undefined && keys.every((k) => MANIFEST_ENTRY_KEYS.has(k))) {
        addNpm({ file, line, via: 'json block', detail: '', edit: 'json' }, entry.name, entry.version);
      }
    }
    const via = d ? `nc:${d.kind}` : 'code block';
    for (const { spec, line } of shellPins(fence.body)) {
      const { name, version } = splitSpec(spec)!;
      addNpm({ file, line, via, detail: guard, edit: 'spec' }, name, version);
    }
    if (/^dockerfile$/i.test(fence.info)) {
      scan.other.push(
        ...baseImages(
          file,
          fence.body.map((b) => b.text),
        ),
      );
    }
    for (const { text } of fence.body) {
      for (const name of npmWords(text).unpinned) {
        scan.other.push({
          pin: name,
          kind: 'unpinned npm install',
          source: file,
          why: 'installs whatever version is newest; pin an exact version so it can be tracked',
        });
      }
      const arg = text.match(DOCKER_ARG);
      if (arg && !arg[2].includes('$')) {
        scan.other.push({
          pin: `${arg[1]}=${arg[2]}`,
          kind: 'binary (Dockerfile ARG)',
          source: file,
          why: 'a download pinned by version; no Dependabot ecosystem reads it',
        });
      }
      for (const spec of pipSpecs(text)) {
        scan.other.push({
          pin: spec,
          kind: 'pip',
          source: file,
          why: 'a pip pin in a SKILL.md; Dependabot reads pip manifests, not markdown',
        });
      }
    }
  }
  return scan;
}

/** Entries of container/cli-tools.json, located at their "version" lines. */
export function scanCliTools(file: string, json: string): Scan {
  const scan = emptyScan();
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch {
    scan.problems.push(`${file}: not valid JSON`);
    return scan;
  }
  if (!Array.isArray(entries)) {
    scan.problems.push(`${file}: expected an array of {"name","version"} entries`);
    return scan;
  }
  // Line spans of the top-level objects, in order, to pair with `entries`.
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let line = 1;
  let start = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '\n') line++;
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      if (c === '{' && depth === 1) start = line;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (c === '}' && depth === 1) spans.push({ start, end: line });
    }
  }
  const lines = json.split('\n');
  if (spans.some((span, k) => k > 0 && span.start <= spans[k - 1].end)) {
    scan.problems.push(`${file}: put each entry on its own lines; sync edits a pin by line`);
    return scan;
  }
  entries.forEach((raw, idx) => {
    const entry = manifestEntry(JSON.stringify(raw));
    const span = spans[idx];
    const body = span ? lines.slice(span.start - 1, span.end).map((text, k) => ({ text, line: span.start + k })) : [];
    const at = versionLine(body);
    if (!entry || at === undefined || !NPM_NAME.test(entry.name) || !EXACT_SEMVER.test(entry.version)) {
      scan.problems.push(`${file}: entry ${idx + 1} is not {"name","version"} with an exact version on its own line`);
      return;
    }
    scan.npm.push({ ...entry, file, line: at, via: 'cli-tools.json', detail: '', edit: 'json' });
  });
  return scan;
}

function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    if (name === 'node_modules' || name === '.git') continue;
    const rel = `${dir}/${name}`;
    const stat = lstatSync(join(root, rel));
    if (stat.isDirectory()) out.push(...walk(root, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

/** Version pins in a skill's own files that no npm tool reads. */
export function scanSkillFiles(root: string, skillDir: string): Scan {
  const scan = emptyScan();
  for (const file of walk(root, skillDir)) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    const eco = FOREIGN_MANIFESTS[base] ?? (/^requirements.*\.txt$/.test(base) ? 'pip' : undefined);
    if (eco) {
      scan.other.push({
        pin: base,
        kind: `${eco} manifest`,
        source: file,
        why: `Dependabot can read this file itself (package-ecosystem ${eco}); not configured`,
      });
      continue;
    }
    if (DOCKERFILE.test(base)) {
      scan.other.push(...baseImages(file, readFileSync(join(root, file), 'utf8').split('\n')));
      continue;
    }
    if (base === 'package.json') {
      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>;
      } catch {
        scan.problems.push(`${file}: not valid JSON`);
        continue;
      }
      const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
      if (sections.some((k) => Object.keys((manifest[k] as object | undefined) ?? {}).length)) {
        scan.other.push({
          pin: 'package.json',
          kind: 'npm manifest',
          source: file,
          why: "Dependabot's npm ecosystem could read this directory itself; not configured",
        });
      }
      continue;
    }
    if (base !== 'versions.json') continue;
    const text = readFileSync(join(root, file), 'utf8');
    let values: unknown;
    try {
      values = JSON.parse(text);
    } catch {
      scan.problems.push(`${file}: not valid JSON`);
      continue;
    }
    if (values === null || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue;
      const kind = /@sha256:[0-9a-f]{64}$/.test(value)
        ? 'container image'
        : /^[0-9a-f]{40}$/.test(value)
          ? 'git commit'
          : EXACT_SEMVER.test(value)
            ? 'version'
            : undefined;
      if (!kind) continue;
      scan.other.push({
        pin: `${key}=${value}`,
        kind,
        source: file,
        why: "read by the skill's own scripts; Dependabot does not read versions.json",
      });
    }
  }
  return scan;
}

export function collect(root: string): Scan {
  const scan = emptyScan();
  const skillsDir = join(root, SKILLS_DIR);
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir).sort() : []) {
    const dir = `${SKILLS_DIR}/${name}`;
    if (!statSync(join(root, dir)).isDirectory()) continue;
    const skillMd = `${dir}/SKILL.md`;
    if (existsSync(join(root, skillMd))) merge(scan, scanSkill(skillMd, readFileSync(join(root, skillMd), 'utf8')));
    merge(scan, scanSkillFiles(root, dir));
  }
  if (existsSync(join(root, CLI_TOOLS))) {
    merge(scan, scanCliTools(CLI_TOOLS, readFileSync(join(root, CLI_TOOLS), 'utf8')));
  }
  return scan;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const where = (p: NpmPin) => `${p.file}:${p.line}`;
// No line numbers in the committed files, so prose edits never make them
// stale; check and sync print the live file:line.
const label = (p: NpmPin) => [p.file, p.via === 'cli-tools.json' ? '' : p.via, p.detail].filter(Boolean).join(' ');

/** Pins grouped by package; a package pinned at two versions is a problem. */
export function groupPins(scan: Scan): { pins: Map<string, NpmPin[]>; problems: string[] } {
  const pins = new Map<string, NpmPin[]>();
  for (const pin of scan.npm) pins.set(pin.name, [...(pins.get(pin.name) ?? []), pin]);
  const problems = [...scan.problems];
  for (const [name, list] of pins) {
    const versions = [...new Set(list.map((p) => p.version))];
    if (versions.length > 1) {
      const at = list.map((p) => `${p.version} at ${where(p)}`).join(', ');
      problems.push(`${name} is pinned at ${versions.length} versions (${at}); pin one version everywhere`);
    }
  }
  return { pins, problems };
}

export interface Generated {
  manifest: string;
  notCovered: string;
  problems: string[];
}

export function generate(scan: Scan): Generated {
  const { pins, problems } = groupPins(scan);
  const dependencies: Record<string, string> = {};
  const skillPins: Record<string, { version: string; sources: string[] }> = {};
  for (const name of [...pins.keys()].sort(byText)) {
    const list = [...pins.get(name)!].sort((a, b) => byText(a.file, b.file) || a.line - b.line);
    dependencies[name] = list[0].version;
    skillPins[name] = { version: list[0].version, sources: [...new Set(list.map(label))] };
  }
  const manifest = {
    name: 'nanoclaw-skill-pins',
    version: '0.0.0',
    private: true,
    // Without it, Dependabot falls back to the root pnpm-lock.yaml and treats
    // this folder as part of the pnpm project; with it, a lockfile-less npm one.
    packageManager: 'npm@10.9.9',
    description: `Generated by \`${GENERATE}\`: the npm versions pinned in .claude/skills/*/SKILL.md and ${CLI_TOOLS}, so Dependabot and audit tools see them. Nothing installs this. Change a pin in its skill; after a Dependabot bump here, run \`${SYNC}\`.`,
    dependencies,
    skillPins,
  };
  const other = [...scan.other].sort((a, b) => byText(a.source, b.source)); // stable: file order kept
  const notCovered = {
    description: `Generated by \`${GENERATE}\`: pins and installs in skills that no npm tool can track. Check these by hand.`,
    pins: other,
  };
  return {
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    notCovered: `${JSON.stringify(notCovered, null, 2)}\n`,
    problems,
  };
}

function readText(root: string, file: string): string | undefined {
  return existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined;
}

interface ShadowManifest {
  dependencies?: Record<string, string>;
  skillPins?: Record<string, { version?: string }>;
}

function readShadow(root: string): ShadowManifest | undefined {
  const text = readText(root, MANIFEST);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as ShadowManifest;
  } catch {
    return undefined;
  }
}

export function writeGenerated(root: string, gen: Generated): void {
  mkdirSync(join(root, PINS_DIR), { recursive: true });
  writeFileSync(join(root, MANIFEST), gen.manifest);
  writeFileSync(join(root, NOT_COVERED), gen.notCovered);
}

/**
 * Per package, compares the skills, the shadow file, and the version the shadow
 * was generated at. Only the shadow moved: a Dependabot bump for `sync`. Both
 * moved: a conflict for a person. Otherwise the shadow file is stale.
 */
function classify(shadow: ShadowManifest | undefined, pins: Map<string, NpmPin[]>) {
  const bumped: Array<{ name: string; from: string; to: string; pins: NpmPin[] }> = [];
  const conflicts: string[] = [];
  const stale: string[] = [];
  const deps = shadow?.dependencies ?? {};
  for (const name of [...new Set([...Object.keys(deps), ...pins.keys()])].sort(byText)) {
    const live = pins.get(name);
    const skill = live?.[0].version;
    const shadowVersion = deps[name];
    const generatedAt = shadow?.skillPins?.[name]?.version;
    if (skill === shadowVersion) continue;
    if (live && shadowVersion !== undefined && generatedAt === skill) {
      bumped.push({ name, from: skill!, to: shadowVersion, pins: live });
    } else if (live && shadowVersion !== undefined && generatedAt !== undefined && shadowVersion !== generatedAt) {
      conflicts.push(`${name}: a skill now pins ${skill} but the shadow file was bumped to ${shadowVersion}`);
    } else if (!live) {
      stale.push(`${name}: in the shadow file, but no skill pins it`);
    } else if (shadowVersion === undefined) {
      stale.push(`${name}@${skill}: pinned at ${live.map(where).join(', ')}, missing from the shadow file`);
    } else {
      stale.push(
        `${name}: the skills pin ${skill} (${live.map(where).join(', ')}), the shadow file has ${shadowVersion}`,
      );
    }
  }
  return { bumped, conflicts, stale };
}

const problemReport = (problems: string[]) =>
  [
    'Skill pins have problems:',
    ...problems.map((p) => `  ${p}`),
    `Fix them in the skills, then run \`${GENERATE}\`.`,
  ].join('\n');

const conflictReport = (conflicts: string[]) =>
  [
    'Skill pins and the shadow file both changed:',
    ...conflicts.map((c) => `  ${c}`),
    `Make the skill and ${MANIFEST} agree on the version you want, then run \`${SYNC}\`.`,
  ].join('\n');

export function check(root: string): { ok: boolean; message: string } {
  const scan = collect(root);
  const gen = generate(scan);
  if (gen.problems.length) return { ok: false, message: problemReport(gen.problems) };
  const manifestOk = readText(root, MANIFEST) === gen.manifest;
  const notCoveredOk = readText(root, NOT_COVERED) === gen.notCovered;
  if (manifestOk && notCoveredOk) return { ok: true, message: `${PINS_DIR} matches the skills.` };
  const { bumped, conflicts, stale } = classify(readShadow(root), groupPins(scan).pins);
  if (conflicts.length) return { ok: false, message: conflictReport(conflicts) };
  if (!manifestOk && !stale.length && !bumped.length) stale.push('pin sources changed, or the file was edited');
  if (!notCoveredOk) stale.push(`${NOT_COVERED} is out of date`);
  const loose = bumped.filter((b) => !EXACT_SEMVER.test(b.to));
  if (loose.length) {
    return {
      ok: false,
      message: [
        `${MANIFEST} asks for versions that are not exact; skill pins must be:`,
        ...loose.map((b) => `  ${b.name}: "${b.to}"`),
        'Pin an exact version there, or close the update.',
      ].join('\n'),
    };
  }
  if (bumped.length) {
    return {
      ok: false,
      message: [
        `${MANIFEST} was bumped without the skills it mirrors (a Dependabot update?):`,
        ...bumped.map((b) => `  ${b.name} ${b.from} -> ${b.to}, pinned at ${b.pins.map(where).join(', ')}`),
        ...(stale.length ? ['Also out of date (sync regenerates these too):', ...stale.map((s) => `  ${s}`)] : []),
        `Run \`${SYNC}\` to write the new versions into the skills, then commit.`,
      ].join('\n'),
    };
  }
  return {
    ok: false,
    message: [
      `${PINS_DIR} is out of date with the skills:`,
      ...stale.map((s) => `  ${s}`),
      `Run \`${GENERATE}\` and commit ${PINS_DIR}.`,
    ].join('\n'),
  };
}

const LOCKFILES = new Set(['bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

/**
 * Places in the pins' skill dirs that still carry a replaced version: the
 * `name@version` text or pnpm patch name (`@scope__name@version.patch`), a
 * versions.json value, or the bare version in a file that names the package
 * (a preflight script, prose, a bundled test). Warnings for a person to read.
 */
function leftoverMentions(root: string, name: string, version: string, pins: NpmPin[]): string[] {
  const dirs = new Set(
    pins.map((p) => (p.file.startsWith(`${SKILLS_DIR}/`) ? p.file.split('/').slice(0, 3).join('/') : 'container')),
  );
  const needles = [...new Set([`${name}@${version}`, `${name.replace('/', '__')}@${version}`])];
  const names = new RegExp(`(?<![\\w@/.-])${escapeRe(name)}(?![\\w/.-])`);
  const bare = new RegExp(`(?<![\\w.+-])v?${escapeRe(version)}(?![\\w.+-])`);
  const out: string[] = [];
  for (const dir of [...dirs].sort(byText)) {
    if (!existsSync(join(root, dir))) continue;
    for (const file of walk(root, dir)) {
      if (LOCKFILES.has(file.slice(file.lastIndexOf('/') + 1))) continue;
      if (needles.some((n) => file.includes(n))) out.push(file);
      const text = readFileSync(join(root, file), 'utf8');
      if (text.includes('\0')) continue;
      const isVersions = file.endsWith('/versions.json');
      const namesPackage = names.test(text) || needles.some((n) => text.includes(n));
      text.split('\n').forEach((l, i) => {
        if (
          needles.some((n) => l.includes(n)) ||
          (isVersions && l.includes(`"${version}"`)) ||
          (namesPackage && bare.test(l))
        ) {
          out.push(`${file}:${i + 1}`);
        }
      });
    }
  }
  return out;
}

/** Problems if `after` is not `before` with exactly the bumped versions. */
export function verifySync(before: Map<string, NpmPin[]>, after: Scan, bumped: Map<string, string>): string[] {
  const { pins, problems } = groupPins(after);
  const out = [...problems];
  for (const [name, list] of before) {
    const want = bumped.get(name) ?? list[0].version;
    const now = pins.get(name) ?? [];
    if (now.length !== list.length) out.push(`${name}: ${list.length} pin(s) before, ${now.length} after`);
    for (const p of now) if (p.version !== want) out.push(`${where(p)}: ${name} is ${p.version}, expected ${want}`);
  }
  for (const name of pins.keys()) if (!before.has(name)) out.push(`${name}: new pin`);
  return out;
}

/** Replaces a file through a temp file and rename, so a failed write leaves it whole. */
function replaceFile(path: string, text: string): void {
  const tmp = `${path}.skill-pins-tmp`;
  try {
    writeFileSync(tmp, text, { mode: statSync(path).mode & 0o777 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** New skill-lint problems (e.g. a @chat-adapter/* off the root `chat`) an edit would add. */
function newLintProblems(root: string, file: string, before: string, after: string): string[] {
  if (!file.endsWith('/SKILL.md')) return [];
  const ctx = { chatVersion: resolveChatCoreVersion(root) };
  const old = new Set(validate(parseDirectives(before), ctx).map((p) => p.message));
  return validate(parseDirectives(after), ctx)
    .filter((p) => !old.has(p.message))
    .map((p) => `${file}:${p.line}: ${p.message}`);
}

export function sync(root: string): { ok: boolean; message: string } {
  const scan = collect(root);
  const { pins, problems } = groupPins(scan);
  if (problems.length) return { ok: false, message: problemReport(problems) };
  const shadow = readShadow(root);
  if (!shadow) return { ok: false, message: `${MANIFEST} is missing or not JSON; run \`${GENERATE}\`.` };

  const { bumped, conflicts } = classify(shadow, pins);
  if (conflicts.length) return { ok: false, message: conflictReport(conflicts) };
  const refused = bumped.filter((b) => !EXACT_SEMVER.test(b.to));
  if (refused.length) {
    const list = refused.map((b) => `  ${b.name}: "${b.to}"`);
    return { ok: false, message: ['Skill pins must be exact versions; not syncing:', ...list].join('\n') };
  }

  // Rewrite each pin in place, checking the old text; then re-scan and roll
  // back unless exactly the bumped versions changed.
  const edits = new Map<string, string[]>();
  for (const b of bumped) {
    for (const pin of b.pins) {
      const lines = edits.get(pin.file) ?? readFileSync(join(root, pin.file), 'utf8').split('\n');
      const old = lines[pin.line - 1];
      let next: string;
      if (pin.edit === 'spec') {
        const token = `${b.name}@${b.from}`;
        const at = wordIndex(old, token);
        if (at === undefined) {
          return { ok: false, message: `${where(pin)}: expected "${token}" once; edit it by hand.` };
        }
        next = old.slice(0, at) + `${b.name}@${b.to}` + old.slice(at + token.length);
      } else {
        const hits = [...old.matchAll(JSON_VERSION)];
        if (hits.length !== 1 || hits[0][2] !== b.from) {
          return { ok: false, message: `${where(pin)}: expected one "version": "${b.from}"; edit it by hand.` };
        }
        next = old.replace(JSON_VERSION, `$1${b.to}$3`);
      }
      lines[pin.line - 1] = next;
      edits.set(pin.file, lines);
    }
  }
  const originals = new Map([...edits.keys()].map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  const lint = [...edits].flatMap(([file, lines]) =>
    newLintProblems(root, file, originals.get(file)!, lines.join('\n')),
  );
  if (lint.length) {
    return {
      ok: false,
      message: [
        'Not syncing: the new versions break the skill lint.',
        ...lint.map((l) => `  ${l}`),
        'For @chat-adapter/*, move the root `chat` package to the same version first, or close the update.',
      ].join('\n'),
    };
  }

  const written: string[] = [];
  const restore = (): string => {
    const stuck = written.filter((file) => {
      try {
        replaceFile(join(root, file), originals.get(file)!);
        return false;
      } catch {
        return true;
      }
    });
    return stuck.length ? `These still hold the new versions: ${stuck.join(', ')}.` : 'Nothing changed.';
  };
  try {
    for (const [file, lines] of edits) {
      replaceFile(join(root, file), lines.join('\n'));
      written.push(file);
    }
  } catch (err) {
    return { ok: false, message: `Could not write the skills (${(err as Error).message}). ${restore()}` };
  }
  const after = collect(root);
  const wrong = verifySync(pins, after, new Map(bumped.map((b) => [b.name, b.to])));
  if (wrong.length) {
    const list = wrong.map((w) => `  ${w}`);
    return { ok: false, message: ['Sync would change other pins. Edit by hand:', ...list, restore()].join('\n') };
  }
  writeGenerated(root, generate(after));

  if (!bumped.length) return { ok: true, message: `Nothing to sync; regenerated ${PINS_DIR}.` };
  const lines = [`Wrote ${bumped.length} shadow version(s) into the skills and regenerated ${PINS_DIR}:`];
  for (const b of bumped) lines.push(`  ${b.name} ${b.from} -> ${b.to} at ${b.pins.map(where).join(', ')}`);
  const mentions = bumped.flatMap((b) =>
    leftoverMentions(root, b.name, b.from, b.pins).map((m) => `  ${m} (${b.from})`),
  );
  if (mentions.length) lines.push('Update these by hand; sync only rewrites the pins:', ...mentions);
  lines.push('Review the diff and run the tests, then commit.');
  return { ok: true, message: lines.join('\n') };
}

/** Rewrites both files from the skills; refuses to drop pending Dependabot bumps unless `force`. */
export function runGenerate(root: string, force = false): { ok: boolean; message: string } {
  const scan = collect(root);
  const gen = generate(scan);
  if (gen.problems.length) return { ok: false, message: problemReport(gen.problems) };
  const { bumped } = classify(readShadow(root), groupPins(scan).pins);
  if (bumped.length && !force) {
    return {
      ok: false,
      message: [
        `${MANIFEST} has bumps the skills don't have yet (a Dependabot update?):`,
        ...bumped.map((b) => `  ${b.name} ${b.from} -> ${b.to}`),
        `Run \`${SYNC}\` to keep them, or \`${GENERATE} --force\` to drop them.`,
      ].join('\n'),
    };
  }
  writeGenerated(root, gen);
  return { ok: true, message: `Wrote ${MANIFEST} and ${NOT_COVERED}.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  const modes: Record<string, (root: string) => { ok: boolean; message: string }> = {
    '--generate': (root) => runGenerate(root, force),
    '--check': check,
    '--sync': sync,
  };
  const run = modes[process.argv.slice(2).find((a) => a !== '--force') ?? '--generate'];
  if (!run) {
    console.error('usage: tsx scripts/skill-pins.ts [--generate [--force] | --check | --sync]');
    process.exitCode = 2;
  } else {
    const result = run(process.cwd());
    (result.ok ? console.log : console.error)(result.message);
    process.exitCode = result.ok ? 0 : 1;
  }
}
