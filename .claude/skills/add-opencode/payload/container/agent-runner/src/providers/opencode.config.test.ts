import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildOpenCodeConfig } from './opencode.js';
import { buildOpenCodeServerEnv } from './opencode-config.js';

const ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_BASE_URL',
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const configFixtures: string[] = [];

function configFixture(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'opencode-config-env-'));
  configFixtures.push(directory);
  return directory;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const directory of configFixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('managed OpenCode config environment', () => {
  it('keeps the original writable XDG parent and reuses only its managed OpenCode symlink', () => {
    const directory = configFixture();
    const environment = { XDG_CONFIG_HOME: directory, HOME: '/unused', PATH: '/fixture/bin' };
    mkdirSync(path.join(directory, 'gh'));
    writeFileSync(path.join(directory, 'gh', 'config.yml'), 'existing tool config');
    const config = { model: 'fixture/model' };
    const first = buildOpenCodeServerEnv(config, environment);
    const second = buildOpenCodeServerEnv(config, environment);
    expect(first).toEqual(second);
    expect(first.XDG_CONFIG_HOME).toBe(directory);
    expect(readlinkSync(path.join(directory, 'opencode'))).toBe(first.OPENCODE_CONFIG_DIR);
    expect(JSON.parse(first.OPENCODE_CONFIG_CONTENT!)).toEqual(config);
    expect(first.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
    expect(readFileSync(path.join(directory, 'gh', 'config.yml'), 'utf8')).toBe('existing tool config');
    expect(environment).toEqual({ XDG_CONFIG_HOME: directory, HOME: '/unused', PATH: '/fixture/bin' });
  });

  it('uses the normal HOME/.config default when XDG_CONFIG_HOME is absent', () => {
    const directory = configFixture();
    const environment = buildOpenCodeServerEnv({}, { HOME: directory });
    expect(environment.XDG_CONFIG_HOME).toBe(path.join(directory, '.config'));
    expect(readlinkSync(path.join(directory, '.config', 'opencode'))).toBe(environment.OPENCODE_CONFIG_DIR);
  });

  it.each(['directory', 'file', 'symlink'])('refuses to replace an existing OpenCode config %s', (kind) => {
    const directory = configFixture();
    const target = path.join(directory, 'opencode');
    if (kind === 'directory') mkdirSync(target);
    if (kind === 'file') writeFileSync(target, 'existing configuration');
    if (kind === 'symlink') symlinkSync('/a/different/config', target, 'dir');
    expect(() => buildOpenCodeServerEnv({}, { XDG_CONFIG_HOME: directory })).toThrow(
      `cannot use existing configuration at ${target}`,
    );
    if (kind === 'directory') {
      writeFileSync(path.join(target, 'proof'), 'still a directory');
      expect(readFileSync(path.join(target, 'proof'), 'utf8')).toBe('still a directory');
    }
    if (kind === 'file') expect(readFileSync(target, 'utf8')).toBe('existing configuration');
    if (kind === 'symlink') expect(readlinkSync(target)).toBe('/a/different/config');
  });
});

describe('buildOpenCodeConfig provider transport', () => {
  it('allows the core five-minute human-question window plus transport overhead', () => {
    expect(buildOpenCodeConfig({}).experimental).toMatchObject({ mcp_timeout: 330_000 });
  });
  it('treats a custom provider prefix literally rather than as a regular expression', () => {
    process.env.OPENCODE_PROVIDER = 'local[1]';
    process.env.OPENCODE_MODEL = 'local[1]/model';
    process.env.OPENCODE_SMALL_MODEL = 'local[1]/small';
    const config = buildOpenCodeConfig({});
    expect(config.provider).toMatchObject({
      'local[1]': { models: { model: { id: 'model' }, small: { id: 'small' } } },
    });
  });
  it('uses ProviderOptions.model before the compatibility env fallback', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/legacy-model';
    const config = buildOpenCodeConfig({ model: 'openai/typed-model' });
    expect(config.model).toBe('openai/typed-model');
  });

  it('falls back to OPENCODE_MODEL when ProviderOptions.model is omitted', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/legacy-model';
    const config = buildOpenCodeConfig({});
    expect(config.model).toBe('openai/legacy-model');
  });

  it('native cloud providers receive the OneCLI placeholder without an endpoint override', () => {
    process.env.OPENCODE_PROVIDER = 'anthropic';
    process.env.OPENCODE_MODEL = 'anthropic/claude-sonnet-4-6';
    delete process.env.ANTHROPIC_BASE_URL;
    const config = buildOpenCodeConfig({});
    expect(config.provider).toMatchObject({ anthropic: { options: { apiKey: 'placeholder' } } });
  });

  it('custom base URL pins the Chat Completions transport', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/some/local-model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    const config = buildOpenCodeConfig({});
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    expect(entry.npm).toBe('@ai-sdk/openai-compatible');
    expect(entry.options).toEqual({ apiKey: 'placeholder', baseURL: 'https://inference.example.test/v1' });
  });

  it('no base URL keeps the native transport and still passes inference overrides', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/gpt-5.2';
    delete process.env.ANTHROPIC_BASE_URL;
    const config = buildOpenCodeConfig({ effort: 'high' });
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    expect(entry.options).toEqual({ apiKey: 'placeholder' });
    expect(entry.npm).toBeUndefined();
    expect(entry.models).toMatchObject({ 'gpt-5.2': { options: { reasoningEffort: 'high' } } });
  });

  it('openrouter with a base URL keeps its native transport (no pin)', () => {
    process.env.OPENCODE_PROVIDER = 'openrouter';
    process.env.OPENCODE_MODEL = 'openrouter/some/model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    const config = buildOpenCodeConfig({});
    const entry = (config.provider as Record<string, Record<string, unknown>>).openrouter;
    expect(entry.npm).toBeUndefined();
  });

  it('openai with a base URL still pins the Chat Completions transport', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/some/local-model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    const config = buildOpenCodeConfig({});
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    expect(entry.npm).toBe('@ai-sdk/openai-compatible');
  });
});

describe('buildOpenCodeConfig model limit', () => {
  function limitEnv() {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/some/local-model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
  }

  function limit(config: Record<string, unknown>) {
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    return (entry.models as Record<string, Record<string, unknown>>)['some/local-model'].limit;
  }

  // buildOpenCodeConfig logs through console.error (see `log` at the top of
  // opencode.ts); capture it so the invalid-input tests can assert on the
  // message instead of just the silent absence of a limit. `spyOn(console,
  // 'error')` does not intercept calls made from other modules on this Bun
  // version, so patch the method directly.
  function captureErrors(fn: () => Record<string, unknown>) {
    const messages: string[] = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      messages.push(String(args[0]));
    }) as typeof console.error;
    try {
      return { config: fn(), messages };
    } finally {
      console.error = original;
    }
  }

  it('declares limit.context/output on the registered model when both env vars are set', () => {
    limitEnv();
    process.env.OPENCODE_MODEL_CONTEXT_LIMIT = '65536';
    process.env.OPENCODE_MODEL_OUTPUT_LIMIT = '8192';
    const config = buildOpenCodeConfig({});
    expect(limit(config)).toEqual({ context: 65536, output: 8192 });
  });

  it('omits limit when the env vars are unset', () => {
    limitEnv();
    delete process.env.OPENCODE_MODEL_CONTEXT_LIMIT;
    delete process.env.OPENCODE_MODEL_OUTPUT_LIMIT;
    const config = buildOpenCodeConfig({});
    expect(limit(config)).toBeUndefined();
  });

  it.each([[' '], ['64k'], ['0'], ['-5']])(
    'rejects OPENCODE_MODEL_CONTEXT_LIMIT=%p, omits limit, and logs the rejection',
    (value) => {
      limitEnv();
      process.env.OPENCODE_MODEL_CONTEXT_LIMIT = value;
      delete process.env.OPENCODE_MODEL_OUTPUT_LIMIT;
      const { config, messages } = captureErrors(() => buildOpenCodeConfig({}));
      expect(limit(config)).toBeUndefined();
      expect(messages.some((m) => m.includes('Ignoring invalid OPENCODE_MODEL_CONTEXT_LIMIT'))).toBe(true);
    },
  );

  it('ignores a set OPENCODE_MODEL_OUTPUT_LIMIT when there is no valid context limit, and logs it', () => {
    limitEnv();
    delete process.env.OPENCODE_MODEL_CONTEXT_LIMIT;
    process.env.OPENCODE_MODEL_OUTPUT_LIMIT = '8192';
    const { config, messages } = captureErrors(() => buildOpenCodeConfig({}));
    expect(limit(config)).toBeUndefined();
    expect(
      messages.some(
        (m) => m.includes('Ignoring OPENCODE_MODEL_OUTPUT_LIMIT') && m.includes('OPENCODE_MODEL_CONTEXT_LIMIT'),
      ),
    ).toBe(true);
  });
});

describe('buildOpenCodeConfig model input modalities', () => {
  function models(config: Record<string, unknown>) {
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    return (entry.models as Record<string, Record<string, unknown>>)['some/local-model'];
  }

  function customModelEnv() {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/some/local-model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
  }

  it('declares attachment + modalities so file parts survive the model call', () => {
    customModelEnv();
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'image,pdf';
    const model = models(buildOpenCodeConfig({}));
    expect(model.attachment).toBe(true);
    // `text` is always prepended: the declared input list REPLACES the defaults,
    // so omitting it would turn off text input on the model entry.
    expect(model.modalities).toEqual({ input: ['text', 'image', 'pdf'], output: ['text'] });
  });

  it('omits both capability keys when the env var is unset', () => {
    customModelEnv();
    delete process.env.OPENCODE_MODEL_INPUT_MODALITIES;
    const model = models(buildOpenCodeConfig({}));
    expect(model.attachment).toBeUndefined();
    expect(model.modalities).toBeUndefined();
  });

  it('omits both capability keys when the env var is empty or only separators', () => {
    customModelEnv();
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = ' , ,';
    const model = models(buildOpenCodeConfig({}));
    expect(model.attachment).toBeUndefined();
    expect(model.modalities).toBeUndefined();
  });

  it('drops entries outside the schema enum and keeps the valid ones', () => {
    customModelEnv();
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = ' IMAGE , hologram, pdf ,image';
    const model = models(buildOpenCodeConfig({}));
    expect(model.modalities).toEqual({ input: ['text', 'image', 'pdf'], output: ['text'] });
  });

  it('does not duplicate text when the operator lists it explicitly', () => {
    customModelEnv();
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'text,image';
    const model = models(buildOpenCodeConfig({}));
    expect(model.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
  });
});

describe('buildOpenCodeConfig small model scope', () => {
  function scopeEnv() {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_MODEL = 'openai/main/model';
    process.env.ANTHROPIC_BASE_URL = 'https://inference.example.test/v1';
    process.env.OPENCODE_MODEL_CONTEXT_LIMIT = '65536';
    process.env.OPENCODE_MODEL_OUTPUT_LIMIT = '8192';
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'image,pdf';
  }

  function models(config: Record<string, unknown>) {
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    return entry.models as Record<string, Record<string, unknown>>;
  }

  it('applies limit and modalities to the main model only, leaving a distinct small model bare', () => {
    scopeEnv();
    process.env.OPENCODE_SMALL_MODEL = 'openai/small/model';
    const all = models(buildOpenCodeConfig({}));

    expect(all['main/model']).toEqual({
      id: 'main/model',
      name: 'main/model',
      tool_call: true,
      limit: { context: 65536, output: 8192 },
      attachment: true,
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    });
    // A distinct small model carries neither key — an undeclared context
    // window / modality set is the safe default it falls back to.
    expect(all['small/model']).toEqual({ id: 'small/model', name: 'small/model', tool_call: true });
  });

  it('small model unset or equal to the main model keeps the pre-existing single-entry shape', () => {
    scopeEnv();
    delete process.env.OPENCODE_SMALL_MODEL;
    const unset = models(buildOpenCodeConfig({}));

    process.env.OPENCODE_SMALL_MODEL = 'openai/main/model'; // same as OPENCODE_MODEL
    const same = models(buildOpenCodeConfig({}));

    const expected = {
      'main/model': {
        id: 'main/model',
        name: 'main/model',
        tool_call: true,
        limit: { context: 65536, output: 8192 },
        attachment: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
    };
    expect(unset).toEqual(expected);
    expect(same).toEqual(expected);
  });
});

// The instructions array is covered in opencode.memory.test.ts, where the
// memory-delivery contract it used to (wrongly) carry now lives.

describe('buildOpenCodeConfig permission', () => {
  it('pins `question` to deny deterministically instead of a wildcard string', () => {
    const config = buildOpenCodeConfig({});
    // A flat 'allow' string previously left `question` to OpenCode's own
    // resolution, which produced contradictory rules (question -> deny *
    // AND question -> allow * for the same session, observed live). An
    // explicit object with one value per category can never produce that:
    // there is exactly one entry for `question`, and it is not 'allow'.
    expect(typeof config.permission).toBe('object');
    expect(config.permission).not.toBe('allow');
    const permission = config.permission as Record<string, unknown>;
    expect(permission.question).toBe('deny');
  });

  it('keeps every other known permission category on allow (no capability regression)', () => {
    const config = buildOpenCodeConfig({});
    const permission = config.permission as Record<string, unknown>;
    const nonQuestionKeys = Object.keys(permission).filter((k) => k !== 'question');
    expect(nonQuestionKeys.length).toBeGreaterThan(0);
    for (const key of nonQuestionKeys) {
      expect(permission[key]).toBe('allow');
    }
  });
});

describe('buildOpenCodeConfig reasoning effort', () => {
  function effortEnv() {
    process.env.OPENCODE_PROVIDER = 'opencode-go';
    process.env.OPENCODE_MODEL = 'opencode-go/deepseek-v4-flash';
    process.env.ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go/v1';
    delete process.env.OPENCODE_SMALL_MODEL;
  }

  function modelOptions(config: Record<string, unknown>, modelId: string) {
    const entry = (config.provider as Record<string, Record<string, unknown>>)['opencode-go'];
    return (entry.models as Record<string, Record<string, unknown>>)[modelId].options;
  }

  it('emits reasoningEffort on the main model when the group config sets an effort', () => {
    effortEnv();
    const config = buildOpenCodeConfig({ effort: 'max' });
    expect(modelOptions(config, 'deepseek-v4-flash')).toEqual({ reasoningEffort: 'max' });
  });

  it('omits model options when no effort is set', () => {
    effortEnv();
    const config = buildOpenCodeConfig({});
    expect(modelOptions(config, 'deepseek-v4-flash')).toBeUndefined();
  });

  it('leaves a distinct small model untouched', () => {
    effortEnv();
    process.env.OPENCODE_SMALL_MODEL = 'opencode-go/deepseek-v4-flash-lite';
    const config = buildOpenCodeConfig({ effort: 'high' });
    expect(modelOptions(config, 'deepseek-v4-flash')).toEqual({ reasoningEffort: 'high' });
    expect(modelOptions(config, 'deepseek-v4-flash-lite')).toBeUndefined();
  });
});

describe('provider-owned endpoint defaults', () => {
  it('uses OpenCode endpoint without changing the historical shared fallback', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.ANTHROPIC_BASE_URL = 'https://claude.example.test';
    process.env.OPENCODE_BASE_URL = 'http://localhost:8891/v1';
    const config = buildOpenCodeConfig({ model: 'openai/test' });
    expect(config.provider).toMatchObject({ openai: { options: { baseURL: 'http://localhost:8891/v1' } } });
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://claude.example.test');
  });
  it('explicit native endpoint suppresses a shared Claude URL and preserves model limits', () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    process.env.OPENCODE_BASE_URL = 'native';
    process.env.ANTHROPIC_BASE_URL = 'https://claude.example.test';
    process.env.OPENCODE_MODEL_CONTEXT_LIMIT = '32768';
    process.env.OPENCODE_MODEL_OUTPUT_LIMIT = '4096';
    const config = buildOpenCodeConfig({ model: 'openai/test', effort: 'high' });
    const entry = (config.provider as Record<string, Record<string, unknown>>).openai;
    expect(entry.options).toEqual({ apiKey: 'placeholder' });
    expect(entry.npm).toBeUndefined();
    expect(entry.models).toMatchObject({
      test: { limit: { context: 32768, output: 4096 }, options: { reasoningEffort: 'high' } },
    });
  });
});
