import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminal = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  confirmAnswers: [] as boolean[],
  selectAnswers: [] as string[],
}));
const socket = vi.hoisted(() => ({
  requests: [] as Array<{ command: string; args: Record<string, unknown> }>,
}));

vi.mock('@clack/prompts', () => ({
  autocomplete: vi.fn(
    async (opts: { options: Array<{ value: string }> }) => terminal.selectAnswers.shift() ?? opts.options[0]?.value,
  ),
  confirm: vi.fn(async (opts: { message: string; initialValue?: boolean }) => {
    terminal.events.push({
      type: 'prompt',
      kind: 'confirm',
      message: opts.message,
      default: opts.initialValue,
    });
    return terminal.confirmAnswers.shift() ?? opts.initialValue ?? true;
  }),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  note: vi.fn(),
  outro: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('./lib/bright-select.js', () => ({
  brightSelect: vi.fn(
    async (opts: { message: string; options: Array<{ value: string; label: string }>; initialValue?: string }) => {
      terminal.events.push({
        type: 'prompt',
        kind: 'singleChoice',
        message: opts.message,
        choices: opts.options.map(({ value, label }) => ({ id: value, label })),
        default: opts.initialValue,
      });
      return terminal.selectAnswers.shift() ?? opts.initialValue ?? opts.options[0]?.value;
    },
  ),
}));

// The production helper lists template carriers before creating one, which
// reads the template manifest from the local templates directory. Point it
// at a scratch root so the test never depends on the checkout's templates/.
const PARITY_TEMPLATES_DIR = '/tmp/nanoclaw-setup-driver-parity/templates';
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  TEMPLATES_DIR: '/tmp/nanoclaw-setup-driver-parity/templates',
}));
vi.mock('../src/cli/socket-client.js', () => ({
  SocketTransport: class {
    async sendFrame(request: { command: string; args: Record<string, unknown> }) {
      socket.requests.push({ command: request.command, args: request.args });
      return {
        id: 'fixture',
        ok: true,
        data:
          request.command === 'groups-create'
            ? {
                id: 'ag-template',
                name: 'SDR',
                folder: 'sdr',
                agent_provider: null,
                created_at: '2026-01-01T00:00:00.000Z',
              }
            : request.command === 'groups-list' || request.command === 'wirings-list'
              ? []
              : {},
      };
    }
  },
}));

import { PLUGIN_SCHEMA_URL } from '../src/templates/manifest.js';
import { installSelectedTemplateAgent, runTemplateSetup } from './auto.js';
import { TerminalSetupDriver } from './lib/setup-driver.js';

const ROOT = process.cwd();
const TSX_LOADER = import.meta.resolve('tsx');
const CHILD = path.join(ROOT, 'setup', 'lib', 'fixtures', 'setup-driver-transcript-child.ts');
const envelope = { protocol: 'nanoclaw.driver.v1', operation: 'setup' } as const;

beforeEach(() => {
  terminal.events.length = 0;
  terminal.confirmAnswers.length = 0;
  terminal.selectAnswers.length = 0;
  socket.requests.length = 0;
  fs.rmSync(PARITY_TEMPLATES_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(PARITY_TEMPLATES_DIR, 'sales', 'sdr'), { recursive: true });
  fs.writeFileSync(
    path.join(PARITY_TEMPLATES_DIR, 'sales', 'sdr', 'plugin.json'),
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }),
  );
  process.env.NANOCLAW_NO_DIAGNOSTICS = '1';
  delete process.env.NANOCLAW_TEMPLATE_PATH;
  delete process.env.NANOCLAW_TEMPLATE_AGENT_ID;
  delete process.env.NANOCLAW_AGENT_NAME;
});

afterEach(() => {
  fs.rmSync(PARITY_TEMPLATES_DIR, { recursive: true, force: true });
  delete process.env.NANOCLAW_NO_DIAGNOSTICS;
  delete process.env.NANOCLAW_TEMPLATE_PATH;
  delete process.env.NANOCLAW_TEMPLATE_AGENT_ID;
  delete process.env.NANOCLAW_AGENT_NAME;
});

async function machineProduction(scenario: 'standard' | 'template-first-agent') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-production-parity-'));
  const requestsPath = path.join(root, 'requests.json');
  const child = spawn(process.execPath, ['--import', TSX_LOADER, CHILD, scenario], {
    cwd: root,
    env: {
      ...process.env,
      NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1',
      NANOCLAW_OPERATION: 'setup',
      NANOCLAW_NO_DIAGNOSTICS: '1',
      NANOCLAW_TEMPLATE_PATH: scenario === 'template-first-agent' ? 'sales/sdr' : '',
      NANOCLAW_TEMPLATE_AGENT_ID: '',
      NANOCLAW_AGENT_NAME: '',
      NANOCLAW_TEST_REQUESTS: requestsPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: Array<Record<string, unknown>> = [];
  let buffer = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      if (event.type !== 'prompt') continue;
      const prompt = event.prompt as { id: string };
      child.stdin.write(`${JSON.stringify({ ...envelope, type: 'answer', promptId: prompt.id, value: 'none' })}\n`);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  try {
    expect(code, stderr).toBe(0);
    return {
      events,
      requests: fs.existsSync(requestsPath)
        ? (JSON.parse(fs.readFileSync(requestsPath, 'utf8')) as Array<{
            command: string;
            args: Record<string, unknown>;
          }>)
        : [],
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function promptShape(value: Record<string, unknown>) {
  const prompt = value.prompt as Record<string, unknown> | undefined;
  return prompt
    ? {
        kind: prompt.kind,
        message: prompt.message,
        choices: prompt.choices,
        default: prompt.default,
      }
    : {
        kind: value.kind,
        message: value.message,
        choices: value.choices,
        default: value.default,
      };
}

describe('setup driver production parity', () => {
  it('uses the production first-agent choice in both renderers', async () => {
    terminal.selectAnswers.push('none');
    await runTemplateSetup(new TerminalSetupDriver('setup'), false, false);
    const machine = await machineProduction('standard');

    const terminalPrompt = terminal.events.find((event) => event.type === 'prompt');
    const machinePrompt = machine.events.find((event) => event.type === 'prompt');
    expect(terminalPrompt).toBeDefined();
    expect(machinePrompt).toBeDefined();
    expect(promptShape(machinePrompt!)).toEqual(promptShape(terminalPrompt!));
  });

  it('stamps the selected template through the real socket-backed production helper', async () => {
    process.env.NANOCLAW_TEMPLATE_PATH = 'sales/sdr';
    await installSelectedTemplateAgent(new TerminalSetupDriver('setup'), 'claude');
    const machine = await machineProduction('template-first-agent');

    // Production lists the template's existing carriers (to offer connect /
    // update / create another) before stamping a fresh agent.
    const expected = [
      { command: 'groups-list', args: { limit: Number.MAX_SAFE_INTEGER } },
      { command: 'wirings-list', args: { limit: Number.MAX_SAFE_INTEGER } },
      { command: 'groups-create', args: { template: 'sales/sdr', new: true } },
      { command: 'groups-config-update', args: { id: 'ag-template', provider: 'claude' } },
    ];
    expect(socket.requests).toEqual(expected);
    expect(machine.requests).toEqual(expected);
    expect(machine.events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        stepId: 'template-agent',
        state: 'succeeded',
      }),
    );
    expect(process.env.NANOCLAW_TEMPLATE_AGENT_ID).toBe('ag-template');
  });

  it('keeps production ordering and direct prompt primitives behind the driver', () => {
    const source = fs.readFileSync(path.join(ROOT, 'setup', 'auto.ts'), 'utf8');
    expect(source).not.toMatch(/\bp\.(confirm|text|password)\s*\(/);
    expect(source).not.toMatch(/\bbrightSelect\s*\(/);
    expect(source.match(/createSetupDriver\s*\(/g)).toHaveLength(1);
    expect(source.indexOf('await runTemplateSetup(driver')).toBeLessThan(source.indexOf("if (!skip.has('container'))"));
    expect(source.indexOf('await runTimezoneStep(driver)')).toBeLessThan(
      source.indexOf('await installSelectedTemplateAgent(driver'),
    );
    expect(source.indexOf('await installSelectedTemplateAgent(driver')).toBeLessThan(
      source.indexOf("if (!skip.has('channel')"),
    );
    const registryFlow = source.slice(
      source.indexOf('async function chooseImageSource'),
      source.indexOf('async function askAgentProviderChoice'),
    );
    expect(registryFlow).not.toContain("driver.mode === 'terminal'");
    expect(registryFlow.match(/runRegistryLoginWithDriver\s*\(/g)).toHaveLength(1);
    expect(fs.existsSync(path.join(ROOT, 'setup', 'lib', 'fixtures', 'setup-driver-transcript.ts'))).toBe(false);
  });
});
