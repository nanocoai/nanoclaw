import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAgentMailbox, registerAgentMailbox, resetAgentMailboxForTesting } from './index.js';
import { SqliteAgentMailbox } from './sqlite/index.js';
import type { AgentMailbox } from './types.js';

const composedFactory = resetAgentMailboxForTesting();
const fakeMailbox = (): AgentMailbox => ({}) as AgentMailbox;

beforeEach(() => {
  resetAgentMailboxForTesting();
});

afterEach(() => {
  resetAgentMailboxForTesting();
  if (composedFactory) registerAgentMailbox(composedFactory);
});

describe('agent mailbox registry', () => {
  it('uses the explicitly registered OSS implementation', () => {
    registerAgentMailbox(() => new SqliteAgentMailbox());
    expect(getAgentMailbox()).toBeInstanceOf(SqliteAgentMailbox);
  });

  it('keeps the host entrypoint on the real composition barrel', () => {
    expect(fs.readFileSync(new URL('../modules/index.ts', import.meta.url), 'utf8')).toContain(
      "import '../mailbox/compose.js';",
    );
    expect(fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain("import './modules/index.js';");
  });

  it('keeps session SQLite code inside the SQLite driver', () => {
    expect(fs.existsSync(new URL('../db/session-db.ts', import.meta.url))).toBe(false);
    expect(fs.existsSync(new URL('./sqlite/session-db.ts', import.meta.url))).toBe(true);

    for (const relative of [
      '../session-manager.ts',
      '../host-sweep.ts',
      '../modules/scheduling/task-content.ts',
      '../modules/scheduling/recurrence.ts',
      '../modules/cross-session-context/prune.ts',
    ]) {
      const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
      expect(source).not.toMatch(/better-sqlite3|\.prepare\s*\(\s*['"`]/);
    }
  });

  it('does not hide a missing composition behind a fallback', () => {
    expect(() => getAgentMailbox()).toThrow('No agent mailbox registered');
  });

  it('lets a skill install the active implementation without a selector', () => {
    const mailbox = fakeMailbox();
    registerAgentMailbox(() => mailbox);
    expect(getAgentMailbox()).toBe(mailbox);
  });

  it('rejects two implementations for the same capability', () => {
    registerAgentMailbox(fakeMailbox);
    expect(() => registerAgentMailbox(fakeMailbox)).toThrow('already registered');
  });

  it('rejects registration after the fallback was resolved', () => {
    registerAgentMailbox(fakeMailbox);
    getAgentMailbox();
    expect(() => registerAgentMailbox(fakeMailbox)).toThrow('already registered');
  });
});
