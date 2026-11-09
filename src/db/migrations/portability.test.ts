import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { migrations } from './index.js';

const FROZEN_SQLITE_ONLY = new Set([
  'initial-v2-schema',
  'chat-sdk-state',
  'pending-approvals',
  'agent-destinations',
  'agent-message-policies',
  'pending-approvals-title-options',
  'approvals-approver-user-id',
  'dropped-messages',
  'drop-pending-credentials',
  'engage-modes',
  'pending-sender-approvals',
  'channel-registration',
  'approval-render-metadata',
  'container-configs',
  'cli-scope',
  'messaging-group-instance',
  'wiring-threads-override',
  'container-config-timezone',
  'approval-question-render-metadata',
]);

const BANNED_PORTABLE_SQL = [
  /\bPRAGMA\b/i,
  /\bsqlite_master\b/i,
  /\bINSERT\s+OR\b/i,
  /\browid\b/i,
  /\bdatetime\s*\(/i,
  /\bstrftime\s*\(/i,
  /\bIS\s+\?/i,
];

describe('central migration portability policy', () => {
  it('freezes SQLite-only status to the pre-boundary migration set', () => {
    const actual = migrations.filter((migration) => migration.sqliteOnly).map((migration) => migration.name);
    expect(new Set(actual)).toEqual(FROZEN_SQLITE_ONLY);
  });

  it('requires every post-boundary migration to be async and portable', () => {
    for (const migration of migrations.filter((candidate) => !candidate.sqliteOnly)) {
      expect(migration.up.constructor.name, migration.name).toBe('AsyncFunction');
      const source = String(migration.up);
      for (const banned of BANNED_PORTABLE_SQL) expect(source, `${migration.name}: ${banned}`).not.toMatch(banned);
    }
  });

  it('preserves the skill-edit migration anchors byte-for-byte', () => {
    const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain("import { migration019 } from './019-wiring-threads.js';");
    expect(source).toContain('\n  migration019,\n');
  });
});
