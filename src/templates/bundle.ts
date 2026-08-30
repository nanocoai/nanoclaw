/**
 * A template as a value: every file under a template directory, in one JSON
 * document, so it can cross `ncl` and rest in the central database.
 *
 * This is the half of the store with NO database import. The ncl CLIENT uses
 * it to pack a directory it can see (a staged release on the node, a seed
 * script's temp dir) into a payload the HOST cannot see the origin of; the
 * host uses it to unpack a stored bundle into an ephemeral directory so the
 * existing parser and stamper keep reading directories, unchanged.
 *
 * Text is carried as text so a bundle stays readable in the database; a file
 * that is not valid UTF-8 rides base64. Modes are kept for executable helpers
 * (`skills/*\/scripts/*.mjs`), which is the only mode bit a template has ever
 * needed.
 */
import fs from 'fs';
import path from 'path';

export interface BundleFile {
  text?: string;
  base64?: string;
  /** Unix mode bits; absent means the platform default. */
  mode?: number;
}

export interface TemplateBundle {
  files: Record<string, BundleFile>;
}

/** Enough for any template this repo ships (the largest is ~60 KB); a bound
 *  because an unbounded payload over ncl is a memory question for the host. */
export const MAX_TEMPLATE_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_TEMPLATE_BUNDLE_FILES = 500;

/** A relative POSIX path with no escape: no absolute, no `..`, no empty segment,
 *  nothing outside the printable range a filename needs. */
const RELPATH_RE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[\x21-\x7e][\x20-\x7e]*$/u;

export function assertBundlePath(relpath: string): void {
  if (!RELPATH_RE.test(relpath) || relpath.split('/').some((seg) => seg === '' || seg === '.')) {
    throw new Error(`template bundle path is not a safe relative path: ${JSON.stringify(relpath)}`);
  }
}

/** Pack a directory. Symlinks are refused rather than followed: a template is
 *  data, and a link is the one way data points at something outside it. */
export function bundleFromDir(dir: string): TemplateBundle {
  const root = path.resolve(dir);
  if (!fs.statSync(root).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const files: Record<string, BundleFile> = {};
  let bytes = 0;
  const walk = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`template bundle refuses symlink: ${childRel}`);
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      assertBundlePath(childRel);
      const buffer = fs.readFileSync(childAbs);
      bytes += buffer.byteLength;
      if (bytes > MAX_TEMPLATE_BUNDLE_BYTES) throw new Error(`template bundle exceeds ${MAX_TEMPLATE_BUNDLE_BYTES} bytes`);
      if (Object.keys(files).length >= MAX_TEMPLATE_BUNDLE_FILES) throw new Error(`template bundle exceeds ${MAX_TEMPLATE_BUNDLE_FILES} files`);
      const mode = fs.statSync(childAbs).mode & 0o777;
      const file: BundleFile = isUtf8(buffer) ? { text: buffer.toString('utf8') } : { base64: buffer.toString('base64') };
      if (mode & 0o111) file.mode = mode;
      files[childRel] = file;
    }
  };
  walk(root, '');
  if (Object.keys(files).length === 0) throw new Error(`template directory is empty: ${dir}`);
  return { files };
}

/** Parse and validate a bundle document from the wire. */
export function parseBundle(text: string): TemplateBundle {
  if (text.length > MAX_TEMPLATE_BUNDLE_BYTES * 2) throw new Error(`template bundle exceeds ${MAX_TEMPLATE_BUNDLE_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('template bundle is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('template bundle must be an object');
  const files = (raw as { files?: unknown }).files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('template bundle needs a files object');
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0) throw new Error('template bundle has no files');
  if (entries.length > MAX_TEMPLATE_BUNDLE_FILES) throw new Error(`template bundle exceeds ${MAX_TEMPLATE_BUNDLE_FILES} files`);
  const out: Record<string, BundleFile> = {};
  let bytes = 0;
  for (const [relpath, value] of entries) {
    assertBundlePath(relpath);
    if (!value || typeof value !== 'object') throw new Error(`template bundle file is not an object: ${relpath}`);
    const file = value as BundleFile;
    const hasText = typeof file.text === 'string';
    const hasB64 = typeof file.base64 === 'string';
    if (hasText === hasB64) throw new Error(`template bundle file needs exactly one of text or base64: ${relpath}`);
    if (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) {
      throw new Error(`template bundle file has an invalid mode: ${relpath}`);
    }
    bytes += hasText ? Buffer.byteLength(file.text!, 'utf8') : Buffer.from(file.base64!, 'base64').byteLength;
    if (bytes > MAX_TEMPLATE_BUNDLE_BYTES) throw new Error(`template bundle exceeds ${MAX_TEMPLATE_BUNDLE_BYTES} bytes`);
    out[relpath] = hasText ? { text: file.text } : { base64: file.base64 };
    if (file.mode !== undefined) out[relpath].mode = file.mode;
  }
  return { files: out };
}

/** Unpack into `into`, which must not already exist. */
export function materializeBundle(bundle: TemplateBundle, into: string): void {
  const root = path.resolve(into);
  if (fs.existsSync(root)) throw new Error(`refusing to materialize over an existing path: ${into}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [relpath, file] of Object.entries(bundle.files)) {
    assertBundlePath(relpath);
    const abs = path.join(root, relpath);
    if (!abs.startsWith(root + path.sep)) throw new Error(`template bundle path escapes the target: ${relpath}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const data = file.text !== undefined ? Buffer.from(file.text, 'utf8') : Buffer.from(file.base64 ?? '', 'base64');
    fs.writeFileSync(abs, data, { mode: file.mode ?? 0o600 });
  }
}

function isUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
