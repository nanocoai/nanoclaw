/**
 * Apple Pages integration for NanoClaw (host-side).
 *
 * All operations run on the macOS host via `osascript`. Agent containers
 * cannot invoke osascript directly, so operations are requested as
 * `pages_request` system actions on outbound.db; the host module reads
 * the verb + args, runs the AppleScript here, and writes a response
 * back to inbound.db. See ./index.ts for the bridge.
 *
 * Security model:
 * - All file operations are sandboxed to `groups/<folder>/pages/`.
 * - Filenames are validated; paths cannot escape the group's pages folder.
 * - AppleScript strings are escaped before interpolation.
 * - Scripts are piped via stdin, not the command line.
 *
 * Ported from v1's src/pages.ts (~519 LOC). The AppleScript logic is
 * load-bearing for several known Pages quirks (paragraph property
 * assignment via `set X of paraRef to Y` rather than the `properties`
 * record form, paragraph style applied first because it resets font/
 * color overrides, etc.) — DO NOT inline-condense the per-property
 * blocks without testing every verb against current Pages versions.
 */

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from '../../group-folder.js';
import { log } from '../../log.js';

// Allowed: letters, digits, space, underscore, hyphen, parens, dot. 1-128 chars.
const FILENAME_PATTERN = /^[A-Za-z0-9 _()\-.]{1,128}$/;

/** Resolve a pages filename inside the group's pages/ folder. */
function resolvePagesPath(groupFolder: string, filename: string): string {
  if (!filename || !FILENAME_PATTERN.test(filename)) {
    throw new Error(`Invalid filename "${filename}". Use letters, digits, space, _ - ( ) . only (max 128 chars).`);
  }
  if (filename.startsWith('.')) {
    throw new Error('Filename may not start with a dot.');
  }
  const groupPath = resolveGroupFolderPath(groupFolder);
  const pagesDir = path.join(groupPath, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const resolved = path.resolve(pagesDir, filename);
  const rel = path.relative(pagesDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes pages directory: ${filename}`);
  }
  return resolved;
}

function ensureExtension(filename: string, ext: string): string {
  return filename.toLowerCase().endsWith(ext) ? filename : filename + ext;
}

/** Escape a JS string for embedding inside an AppleScript double-quoted literal. */
function escapeAs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Run an AppleScript via osascript, piping the script through stdin.
 * Note: child_process.execFile's async form does NOT support an `input`
 * option — only execFileSync does. We use `spawn` and write to stdin
 * manually so the script actually reaches osascript.
 */
function runOsa(script: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      proc.kill('SIGKILL');
      reject(new Error(`osascript: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (c) => {
      stdout += c.toString();
      if (stdout.length > 20 * 1024 * 1024) proc.kill('SIGKILL');
    });
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`osascript: spawn error — ${err.message}`));
    });
    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
      log.error('osascript failed', {
        osascriptStderr: stderr,
        osascriptStdout: stdout,
        exitCode: code,
        script: script.slice(0, 400),
      });
      reject(new Error(`osascript: ${detail}`));
    });

    proc.stdin.end(script);
  });
}

/** Check Pages is installed on this machine (best-effort). */
export function pagesInstalled(): boolean {
  try {
    execFileSync('osascript', ['-e', 'id of application "Pages"'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface ParagraphSpec {
  text: string;
  style?: 'title' | 'heading' | 'subheading' | 'heading-2' | 'heading-3' | 'body' | 'caption';
  font?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  /** Hex color without leading #, e.g. "ff0000". */
  colorHex?: string;
}

export interface InsertOptions {
  position?: 'start' | 'end' | 'replace-all';
  formatting?: Omit<ParagraphSpec, 'text'>;
}

function hexToRgb16(hex: string): [number, number, number] {
  const m = /^([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Invalid colorHex "${hex}"; must be 6 hex digits.`);
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return [r * 257, g * 257, b * 257];
}

const STYLE_MAP: Record<NonNullable<ParagraphSpec['style']>, string> = {
  title: 'Title',
  heading: 'Heading',
  subheading: 'Subheading',
  'heading-2': 'Heading 2',
  'heading-3': 'Heading 3',
  body: 'Body',
  caption: 'Caption',
};

const ALIGN_MAP: Record<NonNullable<ParagraphSpec['alignment']>, string> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'justify',
};

/**
 * Emit per-property `set X of paraRef to Y` lines. The `properties` record
 * form fails on Pages rich text with -10002 "Invalid key form" across
 * multiple Pages versions; individual `set` lines work reliably.
 *
 * Style is applied FIRST because setting a style resets font/size/color/
 * bold — overrides must come after.
 */
function buildFormattingLines(paraRef: string, p: Omit<ParagraphSpec, 'text'>): string[] {
  const lines: string[] = [];
  const safeSet = (prop: string, value: string): void => {
    lines.push(`    try\n      set ${prop} of ${paraRef} to ${value}\n    end try`);
  };
  if (p.style) safeSet('paragraph style', `"${escapeAs(STYLE_MAP[p.style])}"`);
  if (p.font) safeSet('font', `"${escapeAs(p.font)}"`);
  if (typeof p.fontSize === 'number') safeSet('size', String(p.fontSize));
  if (p.colorHex) {
    const [r, g, b] = hexToRgb16(p.colorHex);
    safeSet('color', `{${r}, ${g}, ${b}}`);
  }
  if (p.bold) safeSet('bold', 'true');
  if (p.italic) safeSet('italic', 'true');
  if (p.underline) safeSet('underlined', 'true');
  if (p.alignment) safeSet('alignment', ALIGN_MAP[p.alignment]);
  return lines;
}

function buildDocumentScript(absPath: string, paragraphs: ParagraphSpec[]): string {
  const body = paragraphs.map((p) => p.text.replace(/\r/g, '')).join('\n');
  const formatLines: string[] = [];
  paragraphs.forEach((p, i) => {
    const paraRef = `paragraph ${i + 1} of body text of newDoc`;
    formatLines.push(...buildFormattingLines(paraRef, p));
  });

  return `
tell application "Pages"
  activate
  set newDoc to make new document
  set body text of newDoc to "${escapeAs(body)}"
${formatLines.join('\n')}
  save newDoc in POSIX file "${escapeAs(absPath)}"
end tell
  `.trim();
}

// ───────────────────────────────────────────────────────────────────────────
// Operations
// ───────────────────────────────────────────────────────────────────────────

export async function createDocument(
  groupFolder: string,
  filename: string,
  paragraphs: ParagraphSpec[],
): Promise<{ path: string }> {
  const fname = ensureExtension(filename, '.pages');
  const absPath = resolvePagesPath(groupFolder, fname);
  if (fs.existsSync(absPath)) throw new Error(`Document already exists: ${fname}`);
  await runOsa(buildDocumentScript(absPath, paragraphs));
  log.info('Pages document created', { groupFolder, filename: fname });
  return { path: absPath };
}

export async function openDocument(groupFolder: string, filename: string): Promise<{ path: string }> {
  const fname = ensureExtension(filename, '.pages');
  const absPath = resolvePagesPath(groupFolder, fname);
  if (!fs.existsSync(absPath)) throw new Error(`Document not found: ${fname}`);
  await runOsa(`tell application "Pages"\n  activate\n  open POSIX file "${escapeAs(absPath)}"\nend tell`.trim());
  return { path: absPath };
}

export async function saveDocument(groupFolder: string, filename: string): Promise<void> {
  const fname = ensureExtension(filename, '.pages');
  const absPath = resolvePagesPath(groupFolder, fname);
  await runOsa(
    `tell application "Pages"\n  set d to first document whose file is POSIX file "${escapeAs(
      absPath,
    )}"\n  save d\nend tell`.trim(),
  );
}

export async function closeDocument(groupFolder: string, filename: string, save = true): Promise<void> {
  const fname = ensureExtension(filename, '.pages');
  const absPath = resolvePagesPath(groupFolder, fname);
  const savingClause = save ? 'with saving' : 'without saving';
  await runOsa(
    `tell application "Pages"
  try
    set d to first document whose file is POSIX file "${escapeAs(absPath)}"
    close d ${savingClause}
  end try
end tell`.trim(),
  );
}

export async function getDocumentText(groupFolder: string, filename: string): Promise<string> {
  const fname = ensureExtension(filename, '.pages');
  const absPath = resolvePagesPath(groupFolder, fname);
  if (!fs.existsSync(absPath)) throw new Error(`Document not found: ${fname}`);
  const script = `
tell application "Pages"
  set existingDoc to missing value
  try
    set existingDoc to first document whose file is POSIX file "${escapeAs(absPath)}"
  end try
  if existingDoc is missing value then
    set existingDoc to open POSIX file "${escapeAs(absPath)}"
  end if
  return body text of existingDoc
end tell
  `.trim();
  return (await runOsa(script)).replace(/\n$/, '');
}

export async function insertText(
  groupFolder: string,
  filename: string,
  text: string,
  opts: InsertOptions = {},
): Promise<void> {
  const fname = ensureExtension(filename, '.pages');
  const absPath = resolvePagesPath(groupFolder, fname);
  const position = opts.position ?? 'end';

  let mutation: string;
  if (position === 'replace-all') {
    mutation = `set body text of d to "${escapeAs(text)}"`;
  } else if (position === 'start') {
    mutation = `set body text of d to "${escapeAs(text)}" & (body text of d)`;
  } else {
    mutation = `set body text of d to (body text of d) & "${escapeAs(text)}"`;
  }

  const script = `
tell application "Pages"
  set d to missing value
  try
    set d to first document whose file is POSIX file "${escapeAs(absPath)}"
  end try
  if d is missing value then
    set d to open POSIX file "${escapeAs(absPath)}"
  end if
  ${mutation}
  save d
end tell
  `.trim();
  await runOsa(script);
}

export async function replaceText(
  groupFolder: string,
  filename: string,
  find: string,
  replaceWith: string,
): Promise<void> {
  if (!find) throw new Error('Find string cannot be empty.');
  const fname = ensureExtension(filename, '.pages');
  const absPath = resolvePagesPath(groupFolder, fname);
  const script = `
tell application "Pages"
  set d to missing value
  try
    set d to first document whose file is POSIX file "${escapeAs(absPath)}"
  end try
  if d is missing value then
    set d to open POSIX file "${escapeAs(absPath)}"
  end if
  set t to body text of d
  set AppleScript's text item delimiters to "${escapeAs(find)}"
  set parts to text items of t
  set AppleScript's text item delimiters to "${escapeAs(replaceWith)}"
  set body text of d to parts as text
  set AppleScript's text item delimiters to ""
  save d
end tell
  `.trim();
  await runOsa(script);
}

export async function formatParagraph(
  groupFolder: string,
  filename: string,
  paragraphNumber: number,
  formatting: Omit<ParagraphSpec, 'text'>,
): Promise<void> {
  if (!Number.isInteger(paragraphNumber) || paragraphNumber < 1) {
    throw new Error('paragraphNumber must be a positive integer.');
  }
  const fname = ensureExtension(filename, '.pages');
  const absPath = resolvePagesPath(groupFolder, fname);
  const paraRef = `paragraph ${paragraphNumber} of body text of d`;
  const parts = buildFormattingLines(paraRef, formatting);
  if (!parts.length) return;

  const script = `
tell application "Pages"
  set d to missing value
  try
    set d to first document whose file is POSIX file "${escapeAs(absPath)}"
  end try
  if d is missing value then
    set d to open POSIX file "${escapeAs(absPath)}"
  end if
  ${parts.join('\n  ')}
  save d
end tell
  `.trim();
  await runOsa(script);
}

export async function exportToPdf(
  groupFolder: string,
  filename: string,
  outFilename?: string,
): Promise<{ pdfPath: string }> {
  const fname = ensureExtension(filename, '.pages');
  const absPath = resolvePagesPath(groupFolder, fname);
  if (!fs.existsSync(absPath)) throw new Error(`Document not found: ${fname}`);
  const outName = outFilename ? ensureExtension(outFilename, '.pdf') : fname.replace(/\.pages$/i, '.pdf');
  const outPath = resolvePagesPath(groupFolder, outName);

  const script = `
tell application "Pages"
  set d to missing value
  try
    set d to first document whose file is POSIX file "${escapeAs(absPath)}"
  end try
  if d is missing value then
    set d to open POSIX file "${escapeAs(absPath)}"
  end if
  export d to POSIX file "${escapeAs(outPath)}" as PDF
end tell
  `.trim();
  await runOsa(script, 60000);
  log.info('Pages exported to PDF', { groupFolder, pdfPath: outPath });
  return { pdfPath: outPath };
}

export function listDocuments(groupFolder: string): Array<{ filename: string; size: number; mtime: string }> {
  const groupPath = resolveGroupFolderPath(groupFolder);
  const pagesDir = path.join(groupPath, 'pages');
  if (!fs.existsSync(pagesDir)) return [];
  return fs
    .readdirSync(pagesDir)
    .filter((f) => /\.(pages|pdf)$/i.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(pagesDir, f));
      return { filename: f, size: stat.size, mtime: stat.mtime.toISOString() };
    });
}

export function deleteDocument(groupFolder: string, filename: string): void {
  if (!/\.(pages|pdf)$/i.test(filename)) {
    throw new Error('Can only delete .pages or .pdf files.');
  }
  const absPath = resolvePagesPath(groupFolder, filename);
  if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
}
