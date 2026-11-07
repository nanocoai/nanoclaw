import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CopilotClient, SessionConfig, SessionEvent } from '@github/copilot-sdk';

import { COPILOT_GATEWAY_PLACEHOLDER, CopilotProvider, copilotClientOptions } from './copilot.js';

type ProviderOptionsArg = ConstructorParameters<typeof CopilotProvider>[0];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function projectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-provider-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Project instructions\n');
  fs.mkdirSync(path.join(root, 'memory', 'system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'index.md'), 'Remember this\n');
  fs.writeFileSync(path.join(root, 'memory', 'system', 'definition.md'), 'Use memory carefully\n');
  return root;
}

function fakeSession(sessionId: string) {
  const sent: string[] = [];
  let listener: ((event: SessionEvent) => void) | undefined;
  const session = {
    sessionId,
    on: (callback: (event: SessionEvent) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    send: async ({ prompt }: { prompt: string }) => {
      sent.push(prompt);
      return String(sent.length);
    },
    abort: async () => {},
    disconnect: async () => {},
  };
  const emitEvent = (event: SessionEvent): void => listener?.(event);
  return { session, sent, emitEvent };
}

function fakeClient(session: unknown, overrides: Record<string, unknown> = {}) {
  return {
    start: async () => {},
    getAuthStatus: async () => ({ isAuthenticated: true }),
    createSession: async () => session,
    resumeSession: async () => session,
    stop: async () => [],
    ...overrides,
  };
}

function makeProvider(client: unknown, options: ProviderOptionsArg = {}): CopilotProvider {
  const provider = new CopilotProvider(options, () => client as CopilotClient);
  provider.registerMemorySessionHook({ command: 'unused', legacyCommands: [], sources: ['startup'] });
  return provider;
}

describe('Copilot client options', () => {
  it('authenticates with the gateway placeholder and never with ambient GitHub tokens', () => {
    const options = copilotClientOptions({
      COPILOT_API_URL: 'https://api.business.githubcopilot.com',
      GH_TOKEN: 'ambient',
      GITHUB_TOKEN: 'ambient',
      COPILOT_GITHUB_TOKEN: 'ambient',
    });
    expect(options).toMatchObject({
      mode: 'empty',
      gitHubToken: COPILOT_GATEWAY_PLACEHOLDER,
      useLoggedInUser: false,
      env: {
        COPILOT_API_URL: 'https://api.business.githubcopilot.com',
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        COPILOT_GITHUB_TOKEN: undefined,
      },
    });
  });
});

describe('Copilot mailbox event adapter', () => {
  it('injects startup memory once for new sessions and not on resumed sessions', async () => {
    for (const continuation of [undefined, 'existing']) {
      const cwd = projectRoot();
      const { session, sent, emitEvent } = fakeSession(continuation ?? 'fresh');
      const provider = makeProvider(fakeClient(session));
      const query = provider.query({ prompt: 'first', cwd, continuation });
      const iterator = query.events[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      query.push('second');
      emitEvent({ type: 'session.idle', data: {} } as SessionEvent);
      await iterator.next();
      await iterator.next();
      await iterator.next();
      if (continuation) {
        expect(sent).toEqual(['first', 'second']);
      } else {
        expect(sent[0]).toContain('## Memory');
        expect(sent[0]).toContain('Remember this');
        expect(sent[0]).toContain('\n\nfirst');
        expect(sent[1]).toBe('second');
      }
      query.abort();
      await iterator.next();
    }
  });

  it('passes composed instructions, tools and both MCP transports to the SDK', async () => {
    const cwd = projectRoot();
    let actualConfig: SessionConfig | undefined;
    const { session } = fakeSession('fresh');
    const client = fakeClient(session, {
      createSession: async (config: SessionConfig) => {
        actualConfig = config;
        return session;
      },
    });
    const provider = makeProvider(client, {
      env: { COPILOT_MODEL: 'gpt-5' },
      mcpServers: {
        nanoclaw: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'] },
        extra: { type: 'http', url: 'https://example.test/mcp' },
      },
    });
    const query = provider.query({ prompt: 'hi', cwd, systemContext: { instructions: 'Deliver via XML blocks' } });
    const iterator = query.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'init', continuation: 'fresh' });
    expect(actualConfig?.model).toBe('gpt-5');
    expect(actualConfig?.workingDirectory).toBe(cwd);
    expect(actualConfig?.streaming).toBe(true);
    expect(actualConfig?.systemMessage).toEqual({
      mode: 'append',
      content: 'Project instructions\n\n\nDeliver via XML blocks',
    });
    expect(actualConfig?.skillDirectories).toEqual(['/home/node/.claude/skills']);
    expect(actualConfig?.availableTools).toEqual(['builtin:*', 'mcp:*']);
    expect(actualConfig?.mcpServers.nanoclaw).toMatchObject({
      type: 'stdio',
      command: 'bun',
      args: ['run', '/app/src/mcp-tools/index.ts'],
    });
    expect(actualConfig?.mcpServers.extra).toMatchObject({ type: 'http', url: 'https://example.test/mcp' });
    query.abort();
    expect((await iterator.next()).done).toBe(true);
  });

  it('fails before creating a session when the sandbox has no authenticated identity', async () => {
    let stopped = false;
    const client = fakeClient(undefined, {
      getAuthStatus: async () => ({ isAuthenticated: false }),
      stop: async () => {
        stopped = true;
        return [];
      },
    });
    const provider = makeProvider(client);
    const query = provider.query({ prompt: 'hi', cwd: projectRoot() });
    await expect(query.events[Symbol.asyncIterator]().next()).rejects.toThrow(
      /authentication failed through the credential gateway/,
    );
    expect(stopped).toBe(true);
  });

  it('drains the active turn before closing a query', async () => {
    const { session, emitEvent } = fakeSession('new');
    const provider = makeProvider(fakeClient(session));
    const query = provider.query({ prompt: 'hello', cwd: projectRoot() });
    const iterator = query.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'init', continuation: 'new' });
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    query.end();
    emitEvent({ type: 'assistant.message', data: { content: 'done' } } as SessionEvent);
    emitEvent({ type: 'session.idle', data: {} } as SessionEvent);
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    expect((await iterator.next()).value).toEqual({ type: 'text', text: 'done' });
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    expect((await iterator.next()).value).toEqual({ type: 'result', text: 'done' });
    expect((await iterator.next()).done).toBe(true);
  });

  it('resumes a session, sends follow-ups in order and completes errors without an idle event', async () => {
    let stopped = false;
    const { session, sent, emitEvent } = fakeSession('existing');
    const client = fakeClient(session, {
      resumeSession: async (id: string) => {
        expect(id).toBe('existing');
        return session;
      },
      stop: async () => {
        stopped = true;
        return [];
      },
    });
    const provider = makeProvider(client);
    const query = provider.query({ prompt: 'first', cwd: projectRoot(), continuation: 'existing' });
    const iterator = query.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'init', continuation: 'existing' });
    query.push('second');
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    expect(sent).toEqual(['first']);
    emitEvent({ type: 'assistant.message_delta', data: { deltaContent: 'answer' } } as SessionEvent);
    emitEvent({ type: 'assistant.message', data: { content: 'answer' } } as SessionEvent);
    emitEvent({ type: 'session.idle', data: {} } as SessionEvent);
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    expect((await iterator.next()).value).toEqual({ type: 'text', text: 'answer' });
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    expect((await iterator.next()).value).toEqual({ type: 'result', text: 'answer' });
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    expect(sent).toEqual(['first', 'second']);
    emitEvent({ type: 'session.error', data: { message: 'quota', errorType: 'quota' } } as SessionEvent);
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    expect((await iterator.next()).value).toEqual({ type: 'result', text: null, isError: true, error: 'quota' });
    query.end();
    expect((await iterator.next()).done).toBe(true);
    expect(stopped).toBe(true);
  });
});
