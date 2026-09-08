import { execFileSync } from 'child_process';
import * as p from '@clack/prompts';
import { brightSelect } from '../setup/lib/bright-select.js';
import { CONTAINER_IMAGE } from '../src/config.js';
import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import { buildOneCliManagedStub } from '../src/providers/opencode-auth-stub.js';

const MAX_MODEL_DISCOVERY_BYTES = 1024 * 1024;

/** Probe a container-facing OpenAI-compatible URL from the host setup process. */
export async function discoverLocalModelIds(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  apiKey?: string,
): Promise<string[]> {
  const url = new URL(baseUrl);
  if (url.hostname === 'host.docker.internal') url.hostname = '127.0.0.1';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  url.search = '';
  url.hash = '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_DISCOVERY_BYTES) {
      throw new Error('response is too large');
    }
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_MODEL_DISCOVERY_BYTES) throw new Error('response is too large');
    const payload = JSON.parse(body) as unknown;
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).data)) {
      throw new Error('response has no data array');
    }
    return [
      ...new Set(
        ((payload as Record<string, unknown>).data as unknown[])
          .flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return [];
            const id = (entry as Record<string, unknown>).id;
            return typeof id === 'string' && id.trim() ? [id.trim()] : [];
          })
          .sort((a, b) => a.localeCompare(b)),
      ),
    ];
  } finally {
    clearTimeout(timeout);
  }
}

const MANUAL_MODEL = '__manual_model__';

export function validateModel(model: string, provider: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) return 'Invalid configured OpenCode provider id.';
  if (!model.startsWith(`${provider}/`) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model.slice(provider.length + 1))) {
    return `Use a ${provider}/model-id from the configured backend.`;
  }
  return undefined;
}

/** Parse the pinned CLI's ID + JSON records, keeping text/tool-capable models. */
export function parseRuntimeModels(output: string, provider: string): string[] {
  const records: Array<{ id: string; lines: string[] }> = [];
  for (const line of output.split('\n')) {
    if (line.startsWith(`${provider}/`) && !validateModel(line.trim(), provider)) {
      records.push({ id: line.trim(), lines: [] });
    } else if (records.length) records[records.length - 1].lines.push(line);
  }
  return [
    ...new Set(
      records.flatMap(({ id, lines }) => {
        const model = JSON.parse(lines.join('\n'));
        return model.providerID === provider &&
          model.capabilities?.toolcall === true &&
          model.capabilities?.input?.text === true &&
          model.capabilities?.output?.text === true &&
          model.status !== 'deprecated'
          ? [id]
          : [];
      }),
    ),
  ].sort();
}

export function runtimeModelArgs(provider: string, refresh = false, chatgpt = false): string[] {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) throw new Error('Invalid configured OpenCode provider id.');
  // Catalog lookup only: no vault, host OpenCode files, or runtime credential mounts.
  // A placeholder registers the backend; this does not establish account access.
  const config = { enabled_providers: [provider], provider: { [provider]: { options: { apiKey: 'placeholder' } } } };
  const command = ['models', provider, '--verbose', ...(refresh ? ['--refresh'] : [])];
  const args = ['run', '--rm', '-e', `OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`];
  if (!chatgpt) return [...args, '--entrypoint', 'opencode', CONTAINER_IMAGE, ...command];
  if (provider !== 'openai') throw new Error('ChatGPT mode requires the openai backend.');
  // Activate the same OAuth model filter as the agent runtime, with fixed
  // non-secret sentinels only. No login, OneCLI access, or host mounts occur.
  return [
    ...args,
    '-e',
    'XDG_DATA_HOME=/tmp/opencode-model-catalog',
    '-e',
    `OPENCODE_CATALOG_AUTH=${JSON.stringify(buildOneCliManagedStub())}`,
    '--entrypoint',
    'sh',
    CONTAINER_IMAGE,
    '-c',
    'mkdir -p "$XDG_DATA_HOME/opencode" && printf "%s" "$OPENCODE_CATALOG_AUTH" > "$XDG_DATA_HOME/opencode/auth.json" && unset OPENCODE_CATALOG_AUTH && exec opencode "$@"',
    'opencode',
    ...command,
  ];
}

export function discoverRuntimeModels(provider: string, refresh = false, chatgpt = false): string[] {
  const output = execFileSync(CONTAINER_RUNTIME_BIN, runtimeModelArgs(provider, refresh, chatgpt), {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const models = parseRuntimeModels(output, provider);
  if (!models.length) throw new Error('The installed runtime returned no text/tool-capable models.');
  return models;
}

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Error('Model selection cancelled; settings unchanged.');
  return value as T;
}

export async function chooseOpenCodeModel(provider: string, models: string[], current?: string): Promise<string> {
  const choices = models.filter((id) => !validateModel(id, provider) && id !== current);
  const selected = answer(
    await brightSelect<string>({
      message: 'Which default model should OpenCode use?',
      options: [
        ...(current && !validateModel(current, provider) ? [{ value: current, label: `Keep ${current}` }] : []),
        ...choices.map((id) => ({ value: id, label: id })),
        { value: MANUAL_MODEL, label: 'Enter a model id manually' },
      ],
    }),
  );
  if (selected !== MANUAL_MODEL) return selected;
  return answer(
    await p.text({
      message: 'Model id in provider/model form',
      placeholder: `${provider}/model-id`,
      validate: (value) => validateModel(String(value ?? '').trim(), provider),
    }),
  ).trim();
}
