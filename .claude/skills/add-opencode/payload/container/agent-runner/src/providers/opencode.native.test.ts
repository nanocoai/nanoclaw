import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeClient as createQuestionClient } from '@opencode-ai/sdk/v2';
import { OpenCodeProvider, setSharedRuntimeDepsForTesting, destroySharedRuntime } from './opencode.js';
import { buildOpenCodeServerEnv } from './opencode-config.js';
import { initTestSessionDb, closeSessionDb } from '../mailbox/sqlite/connection.js';
import { registerAgentMailbox, resetAgentMailboxForTesting } from '../mailbox/index.js';
import { SqliteAgentMailbox } from '../mailbox/sqlite/index.js';

// Explicit integration check: OPENCODE_TEST_BINARY=/absolute/path/opencode bun test <this file>.
// The local model fixture exercises the pinned native server and SDK without account credentials.
it.skipIf(!process.env.OPENCODE_TEST_BINARY)(
  'runs native turns, compaction, inherited memory, cancellation and a 65-second MCP call',
  async () => {
    const binary = process.env.OPENCODE_TEST_BINARY!;
    assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), '1.18.25');
    const savedDataHome = process.env.XDG_DATA_HOME;
    const savedConfigHome = process.env.XDG_CONFIG_HOME;
    const root = mkdtempSync(path.join(tmpdir(), 'opencode-native-'));
    process.env.XDG_CONFIG_HOME = path.join(root, 'tool-config');
    const records: unknown[] = [];
    // Exercise the inherited environment inside actual native children, including
    // the compaction hook (startup runs in the runner before the server starts).
    writeFileSync(
      path.join(root, 'config-probe.mjs'),
      `
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
const home = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
let error;
try {
  mkdirSync(path.join(home, process.argv[2]), { recursive: true });
  writeFileSync(path.join(home, process.argv[2], 'proof'), 'writable');
} catch (failure) { error = failure.code; }
appendFileSync(${JSON.stringify(path.join(root, 'environment-probes.jsonl'))},
  JSON.stringify({ child: process.argv[2], home, error }) + String.fromCharCode(10));
`,
    );

    let scenario = 'basic';
    let mainCalls = 0;
    const seen: Array<{
      scenario: string;
      title: boolean;
      compact: boolean;
      child: boolean;
      memory: string;
      body: any;
    }> = [];
    function streaming(text: string, tool?: { name: string; args: object }, usage = 100) {
      const chunk = (delta: unknown, finish_reason: string | null) => ({
        id: 'chatcmpl_fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta, finish_reason }],
      });
      const delta: any = { role: 'assistant', content: text };
      if (tool)
        delta.tool_calls = [
          {
            index: 0,
            id: 'call_fixture_' + Date.now(),
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          },
        ];
      return new Response(
        [
          chunk(delta, null),
          chunk({}, tool ? 'tool_calls' : 'stop'),
          {
            ...chunk({}, null),
            choices: [],
            usage: { prompt_tokens: usage, completion_tokens: 10, total_tokens: usage + 10 },
          },
        ]
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    const backend = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as any;
        records.push(body);
        const title = body.messages.some(
          (m: any) => m.role === 'system' && String(m.content).startsWith('You are a title generator'),
        );
        const compact = !title && !body.tools?.length;
        const child =
          scenario === 'child' &&
          body.messages.some((m: any) => m.role === 'user' && String(m.content).includes('CHILD_HELLO'));
        const memory = body.messages
          .filter((m: any) => m.role === 'system')
          .map((m: any) => m.content)
          .join('\n');
        seen.push({ scenario, title, compact, child, memory, body });
        if (title) return streaming('Fixture title');
        if (compact) return streaming('INTERNAL_COMPACTION_SUMMARY. Retain the task and continue.');
        if (child) return streaming('CHILD_WORK_COMPLETED');
        mainCalls++;
        if (scenario === 'overflow' && mainCalls === 1) {
          writeFileSync(path.join(root, 'memory-source'), 'MEMORY_AFTER_OVERFLOW');
          return Response.json(
            {
              error: {
                message: 'maximum context length exceeded',
                type: 'invalid_request_error',
                code: 'context_length_exceeded',
              },
            },
            { status: 400 },
          );
        }
        if (scenario === 'auto' && mainCalls === 1) {
          writeFileSync(path.join(root, 'memory-source'), 'MEMORY_AFTER_AUTO');
          return streaming(
            '<message to="fixture">BEFORE_COMPACTION</message>',
            {
              name: 'bash',
              args: {
                command: `${process.execPath} '${root}/config-probe.mjs' bash && printf native-tool-proof > '${root}/workspace/tool-proof'`,
                description: 'Write fixture proof',
              },
            },
            19500,
          );
        }
        if (scenario === 'child' && mainCalls === 1)
          return streaming('', {
            name: 'task',
            args: { description: 'Fixture child task', prompt: 'CHILD_HELLO', subagent_type: 'general' },
          });
        if (['mcp', 'cancel'].includes(scenario) && mainCalls === 1)
          return streaming('', {
            name: body.tools.find((tool: any) => tool.function.name.endsWith('_hold')).function.name,
            args: { delay: scenario === 'cancel' ? 300000 : 65000 },
          });
        if (scenario === 'error')
          return Response.json(
            {
              error: {
                message: 'fixture authentication failed',
                type: 'authentication_error',
                code: 'invalid_api_key',
              },
            },
            { status: 401 },
          );
        return streaming(`<message to="fixture">NATIVE_${scenario.toUpperCase()}_PASS</message>`);
      },
    });
    const portProbe = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('');
      },
    });
    const port = portProbe.port;
    portProbe.stop(true);
    process.env.XDG_DATA_HOME = path.join(root, 'data');
    mkdirSync(path.join(root, 'workspace'));
    writeFileSync(path.join(root, 'memory-source'), 'NATIVE_MEMORY_SNAPSHOT');
    writeFileSync(
      path.join(root, 'hook.sh'),
      `#!/bin/sh\n${process.execPath} '${root}/config-probe.mjs' hook\ncat >> '${root}/hook-events.log'\nprintf '\\n' >> '${root}/hook-events.log'\ncat '${root}/memory-source'\n`,
    );
    const composedFactory = resetAgentMailboxForTesting();
    initTestSessionDb();
    registerAgentMailbox(() => new SqliteAgentMailbox());
    writeFileSync(
      path.join(root, 'mcp-fixture.mjs'),
      `import { writeFileSync } from 'node:fs';
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
await import('node:child_process').then(({ execFileSync }) => execFileSync(process.execPath, [${JSON.stringify(path.join(root, 'config-probe.mjs'))}, 'mcp']));
const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'hold', description: 'Wait for the requested milliseconds', inputSchema: { type: 'object', properties: { delay: { type: 'integer' } }, required: ['delay'] } }] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const delay = request.params.arguments?.delay;
  writeFileSync(${JSON.stringify(path.join(root, 'mcp-started'))}, String(delay));
  return await new Promise((resolve) => {
    const abort = () => { writeFileSync(${JSON.stringify(path.join(root, 'mcp-aborted'))}, String(delay)); clearTimeout(timer); resolve({ content: [{ type: 'text', text: 'ABORTED' }], isError: true }); };
    const timer = setTimeout(() => { extra.signal.removeEventListener('abort', abort); resolve({ content: [{ type: 'text', text: 'WAITED_' + delay }] }); }, delay);
    extra.signal.addEventListener('abort', abort, { once: true });
  });
});
await server.connect(new StdioServerTransport());
`,
    );
    let nativeLog = '';
    let spawnCount = 0;
    setSharedRuntimeDepsForTesting({
      spawnServer: async (config) => {
        spawnCount++;
        let spawnLog = '';
        const proc = spawn(binary, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
          cwd: path.join(root, 'workspace'),
          detached: true,
          env: buildOpenCodeServerEnv(config, {
            PATH: process.env.PATH,
            HOME: root,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            XDG_CACHE_HOME: path.join(root, 'cache'),
            XDG_STATE_HOME: path.join(root, 'state'),
            OPENCODE_DISABLE_MODELS_FETCH: 'true',
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stderr.on('data', (data) => {
          nativeLog += data;
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Native startup timeout'));
          }, 30000);
          proc.stdout.on('data', (data) => {
            nativeLog += data;
            spawnLog += data;
            if (spawnLog.includes('opencode server listening')) {
              clearTimeout(timer);
              resolve();
            }
          });
          proc.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Native exit ${code}`));
          });
        });
        return { url: `http://127.0.0.1:${port}`, proc };
      },
      createClient: (url, cwd) => createOpencodeClient({ baseUrl: url, directory: cwd }) as any,
      createQuestionClient: (url) => createQuestionClient({ baseUrl: url }) as any,
    });
    try {
      const provider = new OpenCodeProvider({}, undefined, {
        executionPolicy: { '*': 'allow', question: 'deny' },
        mcpServers: {
          fixture: { type: 'local', command: [process.execPath, path.join(root, 'mcp-fixture.mjs')], enabled: true },
        },
        inference: {
          model: 'openai/fixture',
          small_model: 'openai/fixture',
          enabled_providers: ['openai'],
          provider: {
            openai: {
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: `http://127.0.0.1:${backend.port}/v1`, apiKey: 'fixture-placeholder' },
              models: {
                fixture: { id: 'fixture', name: 'fixture', tool_call: true, limit: { context: 20000, output: 1000 } },
              },
            },
          },
        },
      });
      provider.registerMemorySessionHook({
        command: `sh ${root}/hook.sh`,
        legacyCommands: [],
        sources: ['startup', 'compact'],
      });
      async function run(name: string, continuation?: string) {
        scenario = name;
        mainCalls = 0;
        const query = provider.query({
          prompt: `Run the ${name} fixture.`,
          cwd: path.join(root, 'workspace'),
          continuation,
          systemContext: { instructions: 'NATIVE_CORE_INSTRUCTIONS' },
        });
        query.end();
        const output: any[] = [];
        for await (const event of query.events) output.push(event);
        const final = output.find((event) => event.type === 'result');
        const result = final?.text;
        if (name === 'error') {
          assert.equal(final?.isError, true);
          assert.equal(result, null);
          assert.ok(
            output.some((event) => event.type === 'error' && event.message.includes('fixture authentication failed')),
          );
          assert.equal(output.filter((event) => event.type === 'result').length, 1);
          return output[0].continuation;
        }
        assert.ok(
          result?.includes(`NATIVE_${name.toUpperCase()}_PASS`),
          `Missing native result for ${name}: ${result}`,
        );
        assert.ok(!result?.includes('INTERNAL_COMPACTION_SUMMARY'));
        if (name === 'auto') assert.ok(result.includes('BEFORE_COMPACTION'), 'Lost the pre-compaction deliverable');
        console.log(
          JSON.stringify({
            scenario: name,
            continuation: output[0].continuation,
            result,
            requests: seen.filter((request) => request.scenario === name).length,
          }),
        );
        return output[0].continuation as string;
      }
      await run('basic');
      const autoSession = await run('auto');
      assert.equal(readFileSync(path.join(root, 'workspace/tool-proof'), 'utf8'), 'native-tool-proof');
      assert.ok(seen.some((request) => request.scenario === 'auto' && request.compact));
      assert.ok(
        seen
          .filter((request) => request.scenario === 'auto' && !request.title)
          .at(-1)
          ?.memory.includes('MEMORY_AFTER_AUTO'),
      );
      const probes = readFileSync(path.join(root, 'environment-probes.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { child: string; home: string; error?: string });
      assert.deepEqual([...new Set(probes.map((probe) => probe.child))].sort(), ['bash', 'hook', 'mcp']);
      assert.ok(probes.filter((probe) => probe.child === 'hook').length >= 3, 'Missing native compaction hook probe');
      for (const probe of probes) {
        assert.equal(probe.home, process.env.XDG_CONFIG_HOME, `${probe.child} changed the inherited config home`);
        assert.equal(probe.error, undefined, `${probe.child} config write failed`);
        assert.equal(readFileSync(path.join(probe.home, probe.child, 'proof'), 'utf8'), 'writable');
      }
      assert.equal(existsSync(path.join(process.env.XDG_CONFIG_HOME!, 'opencode', 'node_modules')), false);
      console.log('Native writable config children:', JSON.stringify(probes));
      const startupCount = readFileSync(path.join(root, 'hook-events.log'), 'utf8').match(/startup/g)?.length;
      destroySharedRuntime();
      await run('resume', autoSession);
      assert.equal(readFileSync(path.join(root, 'hook-events.log'), 'utf8').match(/startup/g)?.length, startupCount);
      assert.ok(
        seen
          .filter((request) => request.scenario === 'resume')
          .every((request) => request.memory.includes('MEMORY_AFTER_AUTO')),
      );
      await run('overflow');
      assert.ok(seen.some((request) => request.scenario === 'overflow' && request.compact));
      assert.ok(
        seen
          .filter((request) => request.scenario === 'overflow' && !request.title)
          .at(-1)
          ?.memory.includes('MEMORY_AFTER_OVERFLOW'),
      );
      await run('child');
      assert.ok(
        seen.some(
          (request) =>
            request.scenario === 'child' &&
            request.body.messages.some(
              (message: any) =>
                message.role === 'tool' && JSON.stringify(message.content).includes('CHILD_WORK_COMPLETED'),
            ),
        ),
        'The child request must complete and return its result to the parent',
      );
      assert.ok(
        seen.some(
          (request) =>
            request.child &&
            request.memory.includes('MEMORY_AFTER_OVERFLOW') &&
            request.memory.includes('NATIVE_CORE_INSTRUCTIONS'),
        ),
      );
      await run('error');
      await run('mcp');
      assert.ok(
        seen.some((request) =>
          request.body.messages.some(
            (message: any) => message.role === 'tool' && JSON.stringify(message.content).includes('WAITED_65000'),
          ),
        ),
        'Native MCP timeout truncated a supported human/tool wait',
      );
      scenario = 'cancel';
      mainCalls = 0;
      const cancellation = provider.query({
        prompt: 'Start the cancellable MCP fixture.',
        cwd: path.join(root, 'workspace'),
      });
      cancellation.end();
      let cancelledSession: string | undefined;
      const spawnsBeforeCancel = spawnCount;
      const draining = (async () => {
        for await (const event of cancellation.events) {
          if (event.type === 'init') cancelledSession = event.continuation;
        }
      })();
      async function waitForFile(file: string, expected: string, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try {
            if (readFileSync(path.join(root, file), 'utf8') === expected) return;
          } catch {
            /* Not created yet. */
          }
          await Bun.sleep(25);
        }
        throw new Error(`Native fixture did not write ${file}=${expected}`);
      }
      await waitForFile('mcp-started', '300000');
      cancellation.abort();
      await draining;
      await waitForFile('mcp-aborted', '300000');
      assert.ok(cancelledSession);
      assert.equal(await run('after_cancel', cancelledSession), cancelledSession);
      assert.equal(spawnCount, spawnsBeforeCancel, 'Acknowledged cancellation should keep the shared server usable');
      console.log(
        JSON.stringify({
          success: true,
          root,
          requests: records.length,
          hooks: readFileSync(path.join(root, 'hook-events.log'), 'utf8'),
        }),
      );
    } finally {
      destroySharedRuntime();
      setSharedRuntimeDepsForTesting();
      backend.stop(true);
      resetAgentMailboxForTesting();
      closeSessionDb();
      if (composedFactory) registerAgentMailbox(composedFactory);
      if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedDataHome;
      if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedConfigHome;
      writeFileSync(path.join(root, 'requests.json'), JSON.stringify(seen, null, 2));
      writeFileSync(path.join(root, 'native.log'), nativeLog);
      console.log('Native evidence:', root);
    }
  },
  180000,
);
