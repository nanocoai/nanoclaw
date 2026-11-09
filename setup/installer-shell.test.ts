import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Downloaded installers must run under the system shell by absolute path.
// `sh` or `bash` resolved through PATH can be a foreign shell: exe.dev images
// put /exe.dev/bin/sh first on PATH, and its builtin lsof always exits 0, which
// makes the OneCLI installer's port probe report every port as busy.
// They must also be fetched from an explicit https:// URL: curl sends a
// scheme-less URL over plain HTTP.
const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => (f.endsWith('.sh') || f.endsWith('.ts')) && !f.endsWith('.test.ts'))
  .map((f) => path.join(here, f))
  .concat(path.resolve(here, '../.claude/skills/add-onecli/scripts/setup.ts'));

const CURL_PIPE = /curl\b([^|\n]*)\|\s*(.+)$/;
const SYSTEM_SHELL = /^(?:sudo(?:\s+-\S+)*\s+)?\/bin\/(?:sh|bash)(?=\s|$|["'`])/;

type CurlPipe = { where: string; args: string; shell: string };

// The URL is the last curl argument; other arguments (headers) may mention https.
function httpsOnly(curlArgs: string): boolean {
  const url = (curlArgs.trim().split(/\s+/).pop() ?? '').replace(/^["']|["']$/g, '');
  return url.startsWith('https://') && !/\bhttp:\/\//.test(curlArgs);
}

function scan(text: string, label: string): CurlPipe[] {
  const found: CurlPipe[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let code = lines[i].trim();
    while (code.endsWith('\\') && i + 1 < lines.length) code = `${code.slice(0, -1)} ${lines[++i].trim()}`;
    if (code.startsWith('#') || code.startsWith('//') || code.startsWith('*') || /^echo\b/.test(code)) continue;
    const pipe = CURL_PIPE.exec(code);
    if (pipe) found.push({ where: `${label}:${start + 1}: ${code}`, args: pipe[1], shell: pipe[2] });
  }
  return found;
}

const curlPipes = () =>
  files.flatMap((file) => scan(readFileSync(file, 'utf-8'), path.relative(path.resolve(here, '..'), file)));

describe('setup installers', () => {
  it('pipe downloaded scripts into /bin/sh or /bin/bash, never a PATH-resolved shell', () => {
    const offenders = curlPipes()
      .filter((p) => !SYSTEM_SHELL.test(p.shell))
      .map((p) => p.where);
    expect(offenders).toEqual([]);
  });

  it('fetch piped scripts from an explicit https:// URL', () => {
    const insecure = [
      'curl -fsSL onecli.sh/install | /bin/sh',
      'curl -fsSL http://onecli.sh/install | /bin/sh',
      'curl -fsSL -H "Referer: https://onecli.sh/" onecli.sh/install | /bin/sh',
      'curl -fsSL http://onecli.sh/install \\\n  | /bin/sh',
    ];
    for (const cmd of insecure) expect(scan(cmd, 'sample').filter((p) => !httpsOnly(p.args))).toHaveLength(1);

    const offenders = curlPipes()
      .filter((p) => !httpsOnly(p.args))
      .map((p) => p.where);
    expect(offenders).toEqual([]);
  });

  it('keeps the OneCLI installer on HTTPS-only curl into /bin/sh', () => {
    const src = readFileSync(path.resolve(here, '../.claude/skills/add-onecli/scripts/setup.ts'), 'utf-8');
    expect(src).toContain("curl --proto '=https' --proto-redir '=https' -fsSL https://onecli.sh/install | /bin/sh");
  });
});
