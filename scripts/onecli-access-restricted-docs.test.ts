// The OneCLI gateway answers a request it injected nothing into with the
// upstream status (401, 403, or 400) plus a code: `access_restricted`
// (something is stored for the request's host, but nothing this agent can
// use), `credential_not_found` or `app_not_connected` (nothing stored matched
// the request).
// Docs that explain auth errors must key on the code, never on the status.

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const DOCS = [
  '.claude/skills/debug/SKILL.md',
  '.claude/skills/add-dial-tool/SKILL.md',
  '.claude/skills/add-dial-tool/container-skills/dial-cli/SKILL.md',
  '.claude/skills/add-onecli/payload/container/skills/onecli-gateway/SKILL.md',
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

// On 1.45 the gateway checks only the host for `access_restricted`, so on a
// shared host another app's account is enough (Calendar with only Drive
// connected). The agent must not call the service connected, and must ask
// the admin to connect it when missing, not only to attach it.
const AGENT_DOCS = [
  '.claude/skills/add-onecli/payload/container/skills/onecli-gateway/SKILL.md',
  '.claude/skills/add-onecli/payload/container/skills/onecli-gateway/instructions.md',
];

describe.each(AGENT_DOCS)('%s', (file) => {
  const doc = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const restricted = doc
    .split(/\n\s*\n/)
    .filter((p) => p.includes('access_restricted'))
    .join('\n');

  it('does not read access_restricted as proof the credential is stored or connected', () => {
    expect(restricted).not.toBe('');
    expect(restricted).not.toMatch(/\b(?:is|are) stored\b|credentials? exists?\b/i);
    // In each clause, "is connected" must follow a "not" or "check", or be
    // "only <app> is connected".
    for (const clause of restricted.split(/[.!?:;,]\s+/)) {
      for (const m of clause.matchAll(/\b(?:is|are) connected\b/gi)) {
        const before = clause.slice(0, m.index);
        expect(/\b(?:not|check)\b/i.test(before) || /\bonly\s+\S+\s+$/i.test(before), clause).toBe(true);
      }
    }
  });

  it('covers another app on the same host and has the admin connect a missing one', () => {
    expect(restricted).toContain('www.googleapis.com');
    expect(restricted).toMatch(/\bconnect it if\b/);
  });
});
