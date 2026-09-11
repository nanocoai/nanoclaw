import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getAgentMailbox, readMailboxContext, registerAgentMailbox, resetAgentMailboxForTesting } from './index.js';
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
  test('uses the explicitly registered OSS implementation', () => {
    registerAgentMailbox(() => new SqliteAgentMailbox());
    expect(getAgentMailbox()).toBeInstanceOf(SqliteAgentMailbox);
  });

  test('does not hide a missing composition behind a fallback', () => {
    expect(() => getAgentMailbox()).toThrow('No agent mailbox registered');
  });

  test('lets a skill install the active implementation without a selector', () => {
    const mailbox = fakeMailbox();
    registerAgentMailbox(() => mailbox);
    expect(getAgentMailbox()).toBe(mailbox);
  });

  test('rejects two implementations for the same capability', () => {
    registerAgentMailbox(fakeMailbox);
    expect(() => registerAgentMailbox(fakeMailbox)).toThrow('already registered');
  });

  test('rejects registration after the fallback was resolved', () => {
    registerAgentMailbox(fakeMailbox);
    getAgentMailbox();
    expect(() => registerAgentMailbox(fakeMailbox)).toThrow('already registered');
  });

  test('keeps every runtime entrypoint on the real composition barrel', async () => {
    const read = (relative: string) => Bun.file(new URL(relative, import.meta.url)).text();
    expect(await read('../modules/index.ts')).toContain("import '../mailbox/compose.js';");
    expect(await read('../index.ts')).toContain("import './modules/index.js';");
    expect(await read('../mcp-tools/index.ts')).toContain("import '../modules/index.js';");
    expect(await read('../cli/ncl.ts')).toContain("import '../modules/index.js';");
    expect(await read('../../bunfig.toml')).toContain('preload = ["./src/modules/index.ts"]');
  });

  test('keeps SQLite connections and SQL inside the SQLite driver', async () => {
    expect(await Bun.file(new URL('../db/connection.ts', import.meta.url)).exists()).toBe(false);
    expect(await Bun.file(new URL('./sqlite/connection.ts', import.meta.url)).exists()).toBe(true);

    for (const name of fs.readdirSync(new URL('../db/', import.meta.url))) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const source = await Bun.file(new URL(`../db/${name}`, import.meta.url)).text();
      expect(source).not.toMatch(/bun:sqlite|\.prepare\s*\(\s*['"`]/);
    }
  });
});

describe('agent mailbox context', () => {
  test('uses an explicit legacy sentinel when a pre-seam host provides no context', async () => {
    expect(await readMailboxContext(path.join(os.tmpdir(), `missing-mailbox-context-${randomUUID()}`))).toBeNull();
  });

  test('accepts valid context and rejects empty identity fields', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mailbox-context-'));
    const file = path.join(dir, 'context.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ agentGroupId: 'agent', sessionId: 'session', mailbox: null }));
      expect(await readMailboxContext(file)).toEqual({ agentGroupId: 'agent', sessionId: 'session', mailbox: null });

      for (const invalid of [
        { agentGroupId: '', sessionId: 'session', mailbox: null },
        { agentGroupId: 'agent', sessionId: '', mailbox: null },
      ]) {
        fs.writeFileSync(file, JSON.stringify(invalid));
        await expect(readMailboxContext(file)).rejects.toThrow('Invalid NanoClaw session context');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('treats an unreadable context like a pre-seam host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mailbox-context-'));
    const file = path.join(dir, 'context.json');
    try {
      fs.writeFileSync(file, '{}', { mode: 0o000 });
      expect(await readMailboxContext(file)).toBeNull();
    } finally {
      fs.chmodSync(file, 0o600);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
