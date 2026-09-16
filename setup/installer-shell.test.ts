import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Downloaded installers must run under the system shell by absolute path.
// `sh` or `bash` resolved through PATH can be a foreign shell: exe.dev images
// put /exe.dev/bin/sh first on PATH, and its builtin lsof always exits 0, which
// makes the OneCLI installer's port probe report every port as busy.
const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => (f.endsWith('.sh') || f.endsWith('.ts')) && !f.endsWith('.test.ts'))
  .map((f) => path.join(here, f))
  .concat(path.resolve(here, '../.claude/skills/init-onecli/SKILL.md'));

const CURL_PIPE = /curl\b[^|\n]*\|\s*(.+)$/;
const SYSTEM_SHELL = /^(?:sudo(?:\s+-\S+)*\s+)?\/bin\/(?:sh|bash)(?=\s|$|["'`])/;

describe('setup installers', () => {
  it('pipe downloaded scripts into /bin/sh or /bin/bash, never a PATH-resolved shell', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('#') || code.startsWith('//') || code.startsWith('*') || /^echo\b/.test(code)) return;
        const pipe = CURL_PIPE.exec(code);
        if (pipe && !SYSTEM_SHELL.test(pipe[1]))
          offenders.push(`${path.relative(path.resolve(here, '..'), file)}:${i + 1}: ${code}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the OneCLI installer on /bin/sh', () => {
    const src = readFileSync(path.join(here, 'onecli.ts'), 'utf-8');
    expect(src).toMatch(/curl -fsSL onecli\.sh\/install \| \/bin\/sh/);
  });
});
