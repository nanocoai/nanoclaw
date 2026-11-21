/**
 * Opt-in integration check against the real agy binary:
 *
 *   AGY_TEST_BINARY=/absolute/path/to/agy bun test src/providers/antigravity.native.test.ts
 *
 * agy runs with a temp HOME (never the real ~/.gemini), the placeholder key,
 * and its model endpoint pointed at an in-test fake Gemini SSE server
 * (GOOGLE_GEMINI_BASE_URL). HTTPS_PROXY points at an in-test proxy that
 * refuses every CONNECT, so nothing (telemetry included) leaves the machine.
 * The provider itself is the production class with the production writers;
 * only the spawn is wrapped to add the base URL and the binary path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import { ANTIGRAVITY_API_KEY_PLACEHOLDER, antigravityRuntimeOwnership } from './antigravity-config.js';
import { AntigravityProvider, defaultAntigravityRuntimeDeps } from './antigravity.js';
import type { McpServerConfig, ProviderEvent } from './types.js';

const binary = process.env.AGY_TEST_BINARY;
const TEST_TIMEOUT_MS = 120_000;

interface SeenRequest {
  url: string;
  apiKey: string | undefined;
  systemInstruction: string;
  contents: string;
}

let root: string;
let server: http.Server;
let proxy: http.Server;
let baseUrl: string;
const seen: SeenRequest[] = [];
const proxyConnects: string[] = [];
let modelCalls = 0;
const savedEnv: Record<string, string | undefined> = {};

/** The fake Gemini API: SSE `streamGenerateContent`, driven by markers in the latest user content. */
function handleModelRequest(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
  if (/:countTokens/.test(req.url ?? '')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ totalTokens: 10 }));
    return;
  }
  if (/:generateContent/.test(req.url ?? '')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Title' }] }, finishReason: 'STOP', index: 0 }],
      }),
    );
    return;
  }
  if (!/:streamGenerateContent/.test(req.url ?? '')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  const parsed = JSON.parse(body || '{}') as { contents?: unknown[]; systemInstruction?: unknown };
  const contents = parsed.contents ?? [];
  const latest = JSON.stringify(contents.slice(-1));
  // Markers are read from the newest text part only: after a failed turn agy
  // merges the unanswered user turn and the next one into a single content.
  const lastParts = (
    (contents[contents.length - 1] as { parts?: Array<{ text?: string }> } | undefined)?.parts ?? []
  ).filter((part) => typeof part.text === 'string');
  const newest = lastParts[lastParts.length - 1]?.text ?? '';
  seen.push({
    url: req.url ?? '',
    apiKey: req.headers['x-goog-api-key'] as string | undefined,
    systemInstruction: JSON.stringify(parsed.systemInstruction ?? ''),
    contents: JSON.stringify(contents),
  });
  modelCalls += 1;
  const sse = (chunks: unknown[]): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
    res.end();
  };
  const text = (value: string) => ({
    candidates: [{ content: { role: 'model', parts: [{ text: value }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });
  if (latest.includes('functionResponse')) return sse([text('TOOL-DONE')]);
  if (newest.includes('NATIVE_FAIL')) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
      }),
    );
    return;
  }
  if (newest.includes('NATIVE_MCP')) {
    return sse([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'call_mcp_tool',
                    args: { ServerName: 'probe', ToolName: 'echo', Arguments: { text: 'hi' } },
                  },
                },
              ],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      },
    ]);
  }
  if (newest.includes('NATIVE_SLOW')) {
    setTimeout(() => sse([text('TOO-LATE')]), 15_000);
    return;
  }
  sse([text(`PONG #${modelCalls}`)]);
}

const MCP_SERVER = `
import readline from 'node:readline'; import fs from 'node:fs';
const LOG = process.argv[2];
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(LOG, JSON.stringify({ method: m.method, cwd: process.cwd(), env: process.env.NC_TEST_ENV }) + '\\n');
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echoed' }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

function listen(target: http.Server): Promise<number> {
  return new Promise((resolve) => target.listen(0, '127.0.0.1', () => resolve((target.address() as AddressInfo).port)));
}

function newProvider(mcpServers: Record<string, McpServerConfig> = {}): AntigravityProvider {
  const provider = new AntigravityProvider(
    { mcpServers },
    {
      ...defaultAntigravityRuntimeDeps,
      spawnAgy: (args, options) =>
        spawn(binary!, args, {
          cwd: options.cwd,
          env: { ...options.env, GOOGLE_GEMINI_BASE_URL: baseUrl },
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
    },
  );
  const hookScript = path.join(root, 'memory-hook.sh');
  provider.registerMemorySessionHook({ command: `sh ${hookScript}`, legacyCommands: [], sources: ['startup'] });
  return provider;
}

async function collect(events: AsyncIterable<ProviderEvent>, sink: ProviderEvent[]): Promise<void> {
  for await (const event of events) sink.push(event);
}

async function waitFor(condition: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const meaningful = (events: ProviderEvent[]) => events.filter((event) => event.type !== 'activity');

describe.skipIf(!binary)('agy native integration', () => {
  beforeAll(async () => {
    expect(execFileSync(binary!, ['--version'], { encoding: 'utf8' })).toContain('1.5.8');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-native-'));
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'workspace'));
    fs.writeFileSync(path.join(root, 'memory-hook.sh'), "#!/bin/sh\ncat >/dev/null\necho 'NATIVE-MEMORY-MARKER'\n");
    fs.writeFileSync(path.join(root, 'mcp.mjs'), MCP_SERVER);

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => handleModelRequest(req, res, body));
    });
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
    proxy = http.createServer((_req, res) => res.writeHead(403).end());
    proxy.on('connect', (req, socket) => {
      proxyConnects.push(String(req.url));
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;

    for (const [key, value] of Object.entries({
      HOME: path.join(root, 'home'),
      GEMINI_API_KEY: ANTIGRAVITY_API_KEY_PLACEHOLDER,
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
    })) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    antigravityRuntimeOwnership.contractOwnsRuntimeFiles = false;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server?.close();
    proxy?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  let conversation = '';

  it(
    'runs two turns in one process with the rule file, memory and placeholder key on the wire',
    async () => {
      const events: ProviderEvent[] = [];
      const query = newProvider().query({
        prompt: 'hello',
        cwd: path.join(root, 'workspace'),
        systemContext: { instructions: 'NATIVE-INSTRUCTIONS-MARKER' },
      });
      const done = collect(query.events, events);
      await waitFor(() => events.some((event) => event.type === 'result'));
      query.push('again');
      await waitFor(() => events.filter((event) => event.type === 'result').length === 2);
      query.end();
      await done;

      const init = events.find((event) => event.type === 'init') as { continuation: string };
      conversation = init.continuation;
      expect(conversation).toMatch(/^[0-9a-f-]{36}$/);
      expect(events.filter((event) => event.type === 'result')).toEqual([
        { type: 'result', text: expect.stringContaining('PONG') },
        { type: 'result', text: expect.stringContaining('PONG') },
      ] as never);
      const turns = seen.filter((request) => request.url.includes(':streamGenerateContent'));
      expect(turns.length).toBeGreaterThanOrEqual(2);
      for (const request of turns) {
        expect(request.apiKey).toBe(ANTIGRAVITY_API_KEY_PLACEHOLDER);
        // Group-level memory rides in the always-on rule (the system
        // instruction); the session's context rides in-band in the
        // conversation, never in the shared rule file.
        expect(request.systemInstruction).toContain('NATIVE-MEMORY-MARKER');
        expect(request.systemInstruction).not.toContain('NATIVE-INSTRUCTIONS-MARKER');
        expect(request.contents).toContain('nanoclaw_system_context');
        expect(request.contents).toContain('NATIVE-INSTRUCTIONS-MARKER');
      }
      // Only the process's first line carries the block: the second turn's
      // request holds it once, from history.
      const last = turns[turns.length - 1].contents;
      expect(last.split('NATIVE-INSTRUCTIONS-MARKER').length - 1).toBe(1);
      const rule = fs.readFileSync(path.join(root, 'home', '.gemini', 'config', 'rules', 'nanoclaw.md'), 'utf-8');
      expect(rule).not.toContain('NATIVE-INSTRUCTIONS-MARKER');
      // agy normalised, but kept, the provider it needs for API-key mode.
      const settings = path.join(root, 'home', '.gemini', 'antigravity-cli', 'settings.json');
      expect(JSON.parse(fs.readFileSync(settings, 'utf-8')).modelProvider).toBe('gemini');
      // Model calls never reached the refusing proxy.
      expect(proxyConnects.some((target) => target.startsWith('generativelanguage'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resumes the conversation with its history',
    async () => {
      const before = seen.length;
      const events: ProviderEvent[] = [];
      const query = newProvider().query({
        prompt: 'resumed',
        continuation: conversation,
        cwd: path.join(root, 'workspace'),
      });
      const done = collect(query.events, events);
      await waitFor(() => events.some((event) => event.type === 'result'));
      query.end();
      await done;
      expect(meaningful(events)[0]).toEqual({ type: 'init', continuation: conversation });
      expect(events.some((event) => event.type === 'progress')).toBe(false);
      expect(seen.slice(before).some((request) => request.contents.includes('hello'))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts fresh, with a progress note, for an unknown conversation',
    async () => {
      const missing = '00000000-0000-0000-0000-000000000000';
      const events: ProviderEvent[] = [];
      const query = newProvider().query({ prompt: 'who', continuation: missing, cwd: path.join(root, 'workspace') });
      const done = collect(query.events, events);
      await waitFor(() => events.some((event) => event.type === 'result'));
      query.end();
      await done;
      const init = events.find((event) => event.type === 'init') as { continuation: string };
      expect(init.continuation).not.toBe(missing);
      expect(events).toContainEqual({
        type: 'progress',
        message: `Antigravity conversation ${missing} was not found; started a new conversation`,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reaches a stdio MCP server from mcp_config.json with its cwd and env',
    async () => {
      const mcpLog = path.join(root, 'mcp.log');
      const events: ProviderEvent[] = [];
      const query = newProvider({
        probe: {
          command: process.execPath,
          args: [path.join(root, 'mcp.mjs'), mcpLog],
          env: { NC_TEST_ENV: 'yes' },
          cwd: root,
        },
      }).query({ prompt: 'NATIVE_MCP', cwd: path.join(root, 'workspace') });
      const done = collect(query.events, events);
      await waitFor(() => events.some((event) => event.type === 'result'));
      query.end();
      await done;
      expect(events).toContainEqual({ type: 'progress', message: 'probe/echo…' });
      expect(events.filter((event) => event.type === 'result')).toEqual([
        { type: 'result', text: expect.stringContaining('TOOL-DONE') },
      ] as never);
      const calls = fs
        .readFileSync(mcpLog, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; cwd: string; env: string });
      const call = calls.find((entry) => entry.method === 'tools/call');
      expect(call).toEqual({ method: 'tools/call', cwd: fs.realpathSync(root), env: 'yes' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'aborts a running turn quietly and the process exits',
    async () => {
      const events: ProviderEvent[] = [];
      const query = newProvider().query({ prompt: 'NATIVE_SLOW', cwd: path.join(root, 'workspace') });
      const done = collect(query.events, events);
      await waitFor(() => events.some((event) => event.type === 'init'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const started = Date.now();
      query.abort();
      await done;
      expect(Date.now() - started).toBeLessThan(7_000);
      expect(events.some((event) => event.type === 'result' || event.type === 'error')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'turns a model API error into an error event and a failed result',
    async () => {
      const events: ProviderEvent[] = [];
      const query = newProvider().query({ prompt: 'NATIVE_FAIL', cwd: path.join(root, 'workspace') });
      const done = collect(query.events, events);
      await waitFor(() => events.some((event) => event.type === 'result'), 110_000);
      query.end();
      await done;
      const error = events.find((event) => event.type === 'error') as Extract<ProviderEvent, { type: 'error' }>;
      expect(error.message).toContain('API key not valid');
      expect(error.classification).toBe('auth');
      expect(events.find((event) => event.type === 'result')).toMatchObject({ text: null, isError: true });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers a follow-up queued behind a failed turn, resuming the conversation if agy exits',
    async () => {
      const events: ProviderEvent[] = [];
      const query = newProvider().query({ prompt: 'NATIVE_FAIL again', cwd: path.join(root, 'workspace') });
      query.push('after the failure');
      const done = collect(query.events, events);
      await waitFor(() => events.filter((event) => event.type === 'result').length === 2, 110_000);
      query.end();
      await done;
      const resultEvents = events.filter((event) => event.type === 'result');
      expect(resultEvents[0]).toMatchObject({ text: null, isError: true });
      expect(resultEvents[1]).toEqual({ type: 'result', text: expect.stringContaining('PONG') } as never);
    },
    TEST_TIMEOUT_MS,
  );
});
