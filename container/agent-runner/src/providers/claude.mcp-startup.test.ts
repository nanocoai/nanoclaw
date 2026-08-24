import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

type McpStatus = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
};

type StatusResponse = Promise<McpStatus[]>;

interface QueryCapture {
  prompt: AsyncIterable<unknown>;
  statusCalls: number;
}

const captures: QueryCapture[] = [];
let statusResponses: StatusResponse[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const capture: QueryCapture = { prompt, statusCalls: 0 };
    captures.push(capture);
    return {
      async *[Symbol.asyncIterator]() {},
      async mcpServerStatus(): Promise<McpStatus[]> {
        const response = statusResponses[capture.statusCalls];
        capture.statusCalls += 1;
        return response ?? Promise.resolve([]);
      },
    };
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let previousHome: string | undefined;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  captures.length = 0;
  statusResponses = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-startup-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function prepare(provider: InstanceType<typeof ClaudeProvider>): InstanceType<typeof ClaudeProvider> {
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider;
}

describe('Claude MCP startup ordering', () => {
  test('holds the first prompt until configured MCP startup leaves pending', async () => {
    const firstStatus = deferred<McpStatus[]>();
    const secondStatus = deferred<McpStatus[]>();
    statusResponses = [
      firstStatus.promise,
      secondStatus.promise,
      Promise.resolve([{ name: 'memory', status: 'connected' }]),
    ];

    const provider = prepare(
      new ClaudeProvider({
        mcpServers: {
          nanoclaw: { command: 'bun', args: [], env: {} },
          memory: { command: 'memory-server', args: [], env: {} },
        },
        startupMcpServerNames: ['memory'],
      }),
    );
    provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });

    const iterator = captures[0].prompt[Symbol.asyncIterator]();
    let firstPromptSettled = false;
    const firstPrompt = iterator.next().then((result) => {
      firstPromptSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(firstPromptSettled).toBe(false);
    expect(captures[0].statusCalls).toBe(1);

    firstStatus.resolve([]);
    await Bun.sleep(75);

    expect(captures[0].statusCalls).toBe(2);
    expect(firstPromptSettled).toBe(false);

    secondStatus.resolve([{ name: 'memory', status: 'pending' }]);
    await Bun.sleep(75);

    expect(captures[0].statusCalls).toBe(3);
    expect(await firstPrompt).toMatchObject({
      done: false,
      value: { message: { content: 'first prompt' } },
    });
  });

  test('does not add a startup barrier without configured MCP servers', async () => {
    const provider = prepare(
      new ClaudeProvider({
        mcpServers: {
          nanoclaw: { command: 'bun', args: [], env: {} },
        },
        startupMcpServerNames: [],
      }),
    );
    provider.query({ prompt: 'normal prompt', cwd: '/workspace/agent' });

    const iterator = captures[0].prompt[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { message: { content: 'normal prompt' } },
    });
    expect(captures[0].statusCalls).toBe(0);
  });

  test('releases the first prompt when startup status fails', async () => {
    const failedStatus = deferred<McpStatus[]>();
    statusResponses = [failedStatus.promise];
    const provider = prepare(
      new ClaudeProvider({
        mcpServers: {
          nanoclaw: { command: 'bun', args: [], env: {} },
          memory: { command: 'memory-server', args: [], env: {} },
        },
        startupMcpServerNames: ['memory'],
      }),
    );
    provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });

    const iterator = captures[0].prompt[Symbol.asyncIterator]();
    const firstPrompt = iterator.next();
    failedStatus.reject(new Error('status unavailable'));
    expect(await firstPrompt).toMatchObject({ value: { message: { content: 'first prompt' } } });
    expect(captures[0].statusCalls).toBe(1);
  });

  test('applies the barrier only to the first query', async () => {
    statusResponses = [Promise.resolve([{ name: 'memory', status: 'connected' }])];
    const provider = prepare(
      new ClaudeProvider({
        mcpServers: {
          nanoclaw: { command: 'bun', args: [], env: {} },
          memory: { command: 'memory-server', args: [], env: {} },
        },
        startupMcpServerNames: ['memory'],
      }),
    );

    provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const firstIterator = captures[0].prompt[Symbol.asyncIterator]();
    expect(await firstIterator.next()).toMatchObject({ value: { message: { content: 'first prompt' } } });
    expect(captures[0].statusCalls).toBe(1);

    provider.query({ prompt: 'later prompt', cwd: '/workspace/agent' });
    const laterIterator = captures[1].prompt[Symbol.asyncIterator]();
    expect(await laterIterator.next()).toMatchObject({ value: { message: { content: 'later prompt' } } });
    expect(captures[1].statusCalls).toBe(0);
  });
});
