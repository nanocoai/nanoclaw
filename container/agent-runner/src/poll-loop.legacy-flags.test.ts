import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

// A provider with no runtime contract (a payload built against a core that
// predates the seam) still declares its behavior through the legacy instance
// flags. The poll-loop must honor those, not silently default them to false.

class LegacyProvider implements AgentProvider {
  supportsNativeSlashCommands?: boolean;
  prompts: string[] = [];

  constructor(flags: { supportsNativeSlashCommands?: boolean } = {}) {
    this.supportsNativeSlashCommands = flags.supportsNativeSlashCommands;
  }

  registerMemorySessionHook(): void {}

  isSessionInvalid(): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    this.prompts.push(input.prompt);
    let end: (() => void) | undefined;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'init', continuation: 'legacy-session' };
        yield { type: 'result', text: '<message to="discord-test">seen</message>' };
        await ended;
      },
    };
    return { push() {}, end: () => end?.(), events, abort: () => end?.() };
  }
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES ('m-cmd', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(JSON.stringify({ sender: 'Alice', text: '/mycmd hello' }));
});

afterEach(() => {
  closeSessionDb();
});

async function runUntilReply(provider: LegacyProvider): Promise<void> {
  const controller = new AbortController();
  const loop = runPollLoop({ provider, providerName: 'legacy', cwd: '/tmp', signal: controller.signal }).catch(
    () => {},
  );
  const start = Date.now();
  while (getUndeliveredMessages().length === 0 && Date.now() - start < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  controller.abort();
  await loop;
}

describe('contractless provider legacy flags', () => {
  it('passes slash commands raw when the instance declares supportsNativeSlashCommands', async () => {
    const provider = new LegacyProvider({ supportsNativeSlashCommands: true });
    await runUntilReply(provider);
    expect(provider.prompts).toEqual(['/mycmd hello']);
  });

  it('wraps slash commands like chat when the instance declares nothing', async () => {
    const provider = new LegacyProvider();
    await runUntilReply(provider);
    expect(provider.prompts).toHaveLength(1);
    expect(provider.prompts[0]).not.toBe('/mycmd hello');
    expect(provider.prompts[0]).toContain('/mycmd hello');
    expect(provider.prompts[0]).toContain('<');
  });
});
