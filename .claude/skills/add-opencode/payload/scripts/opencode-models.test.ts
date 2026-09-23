import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ exec: vi.fn(), choose: vi.fn(), text: vi.fn() }));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: (...args: unknown[]) => fixture.exec(...args),
}));
vi.mock('../setup/lib/bright-select.js', () => ({ brightSelect: (...args: unknown[]) => fixture.choose(...args) }));
vi.mock('@clack/prompts', () => ({
  isCancel: (value: unknown) => typeof value === 'symbol',
  text: (...args: unknown[]) => fixture.text(...args),
  log: { warn: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
import { discoverRuntimeModels, parseRuntimeModels, runtimeModelArgs, validateModel } from './opencode-model-config.js';
import { runModelSelection } from './opencode-models.js';

const originalCwd = process.cwd();
let directory: string;
const initial =
  '# custom settings\nOPENCODE_PROVIDER=openai\nOPENCODE_MODEL=openai/current\nOPENCODE_SMALL_MODEL=openai/small\nOPENCODE_BASE_URL=native\nOPENCODE_AUTH_MODE=chatgpt\nANTHROPIC_BASE_URL=https://example.test\nOTHER=preserve\n';
function record(id: string, toolcall = true, text = true, status = 'active') {
  return `${id}\n${JSON.stringify({ providerID: id.split('/')[0], capabilities: { toolcall, input: { text }, output: { text } }, status }, null, 2)}\n`;
}
function contents() {
  return fs.readFileSync(path.join(directory, '.env'), 'utf8');
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-models-test-'));
  process.chdir(directory);
  fs.writeFileSync('.env', initial);
  vi.resetAllMocks();
  for (const key of [
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL',
    'OPENCODE_AUTH_MODE',
    'OPENCODE_BASE_URL',
    'ANTHROPIC_BASE_URL',
  ])
    vi.stubEnv(key, undefined);
  fixture.exec.mockReturnValue(record('openai/new-model') + record('openai/current'));
  fixture.choose.mockResolvedValue('openai/new-model');
});
afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('installed runtime catalog', () => {
  it('matches runtime fallback when an exported empty endpoint suppresses the saved native setting', async () => {
    vi.stubEnv('OPENCODE_BASE_URL', '');
    const transport = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'local-model' }] })));
    vi.stubGlobal('fetch', transport);
    await runModelSelection(['--list']);
    expect(transport).toHaveBeenCalledWith(new URL('https://example.test/models'), expect.any(Object));
    expect(fixture.exec).not.toHaveBeenCalled();
    expect(contents()).toBe(initial);
  });

  it('filters metadata instead of using a static GPT allowlist', () => {
    const output =
      record('openai/new-future-model') +
      record('openai/o-new') +
      record('openai/image', false) +
      record('openai/embedding', false, false) +
      record('openai/old', true, true, 'deprecated') +
      record('openai/o-new');
    expect(parseRuntimeModels(output, 'openai')).toEqual(['openai/new-future-model', 'openai/o-new']);
  });
  it('rejects malformed runtime output rather than presenting guessed models', () => {
    expect(() => parseRuntimeModels('openai/test\ninvalid', 'openai')).toThrow();
    fixture.exec.mockReturnValue('provider not found');
    expect(() => discoverRuntimeModels('openai')).toThrow('no text/tool-capable');
  });
  it('queries the container only, enables refresh, and activates ChatGPT filtering with a fixed sentinel', () => {
    discoverRuntimeModels('openai', true, true);
    const [command, args, options] = fixture.exec.mock.calls[0];
    expect(command).not.toBe('opencode');
    expect(args).toContain('--refresh');
    expect(args).toContain('--verbose');
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--mount');
    expect(args).not.toContain('--env-file');
    const stubArg = args.find((value: string) => value.startsWith('OPENCODE_CATALOG_AUTH='));
    expect(JSON.parse(stubArg.split('=').slice(1).join('='))).toEqual({
      openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: Date.UTC(2100, 0, 1) },
    });
    expect(options.timeout).toBe(60000);
    expect(options.maxBuffer).toBeGreaterThan(0);
  });
  it('keeps API backend discovery outside ChatGPT mode and rejects invalid provider arguments', () => {
    expect(runtimeModelArgs('openrouter')).not.toContain('sh');
    expect(() => runtimeModelArgs('--help')).toThrow();
    expect(() => runtimeModelArgs('openrouter', false, true)).toThrow('openai backend');
  });
});

describe('default model command', () => {
  it('discovers from the configured local endpoint instead of offering native OpenAI models', async () => {
    fs.writeFileSync(
      '.env',
      initial.replace('OPENCODE_BASE_URL=native', 'OPENCODE_BASE_URL=http://host.docker.internal:8000/v1'),
    );
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen-local' }] })));
    vi.stubGlobal('fetch', request);
    fixture.choose.mockResolvedValue('openai/qwen-local');
    await runModelSelection(['--refresh']);
    expect(request).toHaveBeenCalledWith(new URL('http://127.0.0.1:8000/v1/models'), expect.any(Object));
    expect(fixture.exec).not.toHaveBeenCalled();
    expect(fixture.choose.mock.calls[0][0].options).toContainEqual({
      value: 'openai/qwen-local',
      label: 'openai/qwen-local',
    });
    expect(contents()).toContain('OPENCODE_MODEL=openai/qwen-local');
  });
  it('uses manual/current choices when a custom catalog is unavailable, without native fallback', async () => {
    fs.writeFileSync('.env', initial.replace('OPENCODE_BASE_URL=native', 'OPENCODE_BASE_URL=http://127.0.0.1:8000/v1'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );
    fixture.choose.mockResolvedValue('openai/current');
    await runModelSelection(['--refresh']);
    expect(fixture.exec).not.toHaveBeenCalled();
    expect(fixture.choose.mock.calls[0][0].options.map((entry: { value: string }) => entry.value)).toEqual([
      'openai/current',
      '__manual_model__',
    ]);
  });
  it('changes only the main default and preserves all other bytes in .env', async () => {
    await runModelSelection(['--model', 'openai/new-model']);
    expect(contents()).toBe(initial.replace('OPENCODE_MODEL=openai/current', 'OPENCODE_MODEL=openai/new-model'));
    expect(fixture.exec).not.toHaveBeenCalled();
  });
  it('keeps current model first even if it is missing from the refreshed catalog', async () => {
    fixture.exec.mockReturnValue(record('openai/new-model'));
    fixture.choose.mockResolvedValue('openai/current');
    await runModelSelection(['--refresh']);
    expect(fixture.choose.mock.calls[0][0].options[0]).toEqual({
      value: 'openai/current',
      label: 'Keep openai/current',
    });
    expect(contents()).toBe(initial);
  });
  it('lists refreshed runtime models without changing any settings', async () => {
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runModelSelection(['--list', '--refresh']);
    expect(print).toHaveBeenCalledWith('openai/current\nopenai/new-model');
    expect(contents()).toBe(initial);
    expect(fixture.choose).not.toHaveBeenCalled();
    print.mockRestore();
  });
  it('leaves settings unchanged on cancellation', async () => {
    fixture.choose.mockResolvedValue(Symbol('cancel'));
    await expect(runModelSelection([])).rejects.toThrow('cancelled');
    expect(contents()).toBe(initial);
  });
  it('allows manual selection when discovery fails, without starting authentication', async () => {
    fixture.exec.mockImplementation(() => {
      throw new Error('offline');
    });
    fixture.choose.mockResolvedValue('__manual_model__');
    fixture.text.mockResolvedValue('openai/future-model');
    await runModelSelection([]);
    expect(contents()).toBe(initial.replace('OPENCODE_MODEL=openai/current', 'OPENCODE_MODEL=openai/future-model'));
  });
  it('fails read-only listing on a catalog failure', async () => {
    fixture.exec.mockImplementation(() => {
      throw new Error('offline');
    });
    await expect(runModelSelection(['--list'])).rejects.toThrow('settings unchanged');
    expect(contents()).toBe(initial);
  });
  it.each(['openrouter/model', 'openai/model\nOTHER=changed', 'openai/$&', 'openai/', '--help'])(
    'refuses invalid or mismatched model %s before mutation',
    async (model) => {
      await expect(runModelSelection(['--model', model])).rejects.toThrow();
      expect(contents()).toBe(initial);
    },
  );
  it.each([['--unknown'], ['--model'], ['--list', '--model', 'openai/new']])(
    'rejects invalid arguments %j',
    async (...args) => {
      await expect(runModelSelection(args)).rejects.toThrow();
      expect(contents()).toBe(initial);
    },
  );
  it('matches runtime precedence when an exported empty auth mode disables ChatGPT', async () => {
    vi.stubEnv('OPENCODE_AUTH_MODE', '');
    fixture.choose.mockResolvedValue('openai/current');
    await runModelSelection([]);
    expect(fixture.exec.mock.calls[0][1]).not.toContain('sh');
    expect(contents()).toBe(initial);
  });
  it('refuses an exported model override that would hide the saved change', async () => {
    vi.stubEnv('OPENCODE_MODEL', 'openai/exported');
    await expect(runModelSelection(['--model', 'openai/new-model'])).rejects.toThrow('exported OPENCODE_MODEL');
    expect(contents()).toBe(initial);
  });
  it('refuses an exported backend that differs from the persisted backend', async () => {
    vi.stubEnv('OPENCODE_PROVIDER', 'openrouter');
    await expect(runModelSelection(['--model', 'openrouter/new-model'])).rejects.toThrow('exported OPENCODE_PROVIDER');
    expect(contents()).toBe(initial);
  });
  it('requires an existing configured backend', async () => {
    fs.writeFileSync('.env', 'OTHER=keep\n');
    await expect(runModelSelection([])).rejects.toThrow('Configure an OpenCode backend');
    expect(contents()).toBe('OTHER=keep\n');
  });
  it('accepts nested provider model ids and rejects control characters', () => {
    expect(validateModel('openrouter/vendor/model:free', 'openrouter')).toBeUndefined();
    expect(validateModel('openai/a\rb', 'openai')).toBeDefined();
  });
});
