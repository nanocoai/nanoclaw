// The OneCLI gateway answers a request it injected nothing into with the
// upstream status (401, 403, or 400) plus a code: `access_restricted` (not
// attached), `credential_not_found` or `app_not_connected` (nothing stored).
// Docs that explain auth errors must key on the code, never on the status.

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const DOCS = [
  '.claude/skills/debug/SKILL.md',
  '.claude/skills/add-dial-tool/SKILL.md',
  '.claude/skills/add-dial-tool/container-skills/dial-cli/SKILL.md',
];

describe.each(DOCS)('%s', (file) => {
  const doc = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const paragraphs = doc.split(/\n\s*\n/);

  it('never ties access_restricted to one status', () => {
    expect(doc).toContain('access_restricted');
    expect(doc).not.toMatch(/40[13]\s+access_restricted/);
    expect(doc).toContain('credential_not_found');
    expect(doc).toContain('app_not_connected');
  });

  it('reads a 401 as a stale or wrong key only when it carries none of those codes', () => {
    const sentences = paragraphs.flatMap((p) => p.split(/(?<=[.!?])\s+/));
    const staleAdvice = sentences.filter((s) => /\b401\b/.test(s) && /\b(stale|wrong|expired)\b/.test(s));
    expect(staleAdvice.length).toBeGreaterThan(0);
    for (const s of staleAdvice) expect(s).toMatch(/401`?\s+with\s+none\s+of\s+these\s+codes/);
  });
});
