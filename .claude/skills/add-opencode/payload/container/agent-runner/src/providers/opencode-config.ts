import type { ProviderOptions } from './types.js';
import type { ResolvedRuntimeConfiguration, RuntimeInferenceInput } from '../provider-contracts/registry.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { fileURLToPath } from 'node:url';
const MODEL_INPUT_MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'] as const;
const AGENT_DIR = '/workspace/agent';

/** The managed container uses core-composed config and a dependency-free local plugin.
 * Its config directory ships in the existing read-only /app/src mount. OpenCode
 * skips npm dependency installation for read-only config directories, so a fresh
 * container can load the plugin without reaching the package registry. Runtime
 * data, cache and state keep their separate writable XDG locations.
 */
export function buildOpenCodeServerEnv(
  config: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    XDG_CONFIG_HOME: fileURLToPath(new URL('./opencode-managed-config/', import.meta.url)),
    OPENCODE_CONFIG_DIR: fileURLToPath(new URL('./opencode-managed-config/opencode', import.meta.url)),
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
}
function log(message: string): void {
  console.error(`[opencode-provider] ${message}`);
}

// A limit env var must be a bare positive integer (a token count) — units
// ("64k"), blank strings, zero, and negatives are rejected rather than
// coerced: Number() would turn blank into 0 (silently disables compaction,
// see below) and "64k" into NaN (the emitted config becomes unparseable
// JSON, and OpenCode fails to start). Invalid input is treated as unset.
function parseLimitEnv(varName: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) <= 0) {
    log(`Ignoring invalid ${varName}: "${raw}"`);
    return undefined;
  }
  return Number(trimmed);
}

export function resolveOpenCodeInference(
  input: RuntimeInferenceInput,
  environment: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const provider = environment.OPENCODE_PROVIDER || 'anthropic';
  const model = input.model ?? environment.OPENCODE_MODEL;
  const smallModel = environment.OPENCODE_SMALL_MODEL;
  // Reasoning effort from the group's container config (ncl groups config
  // update --effort). OpenCode forwards a free-form per-model `options` object
  // to the ai-sdk provider, which maps reasoningEffort onto reasoning_effort in
  // the request body.
  const effort = input.effort;
  // New installs own their endpoint setting. The explicit native value
  // suppresses the historical shared-variable fallback without editing it.
  const endpoint = environment.OPENCODE_BASE_URL ?? environment.ANTHROPIC_BASE_URL;
  const proxyUrl = endpoint === 'native' ? undefined : endpoint;

  const stripProviderPrefix = (value: string | undefined) =>
    value?.startsWith(`${provider}/`) ? value.slice(provider.length + 1) : value;
  const providerModelId = stripProviderPrefix(model);
  const providerSmallModelId = stripProviderPrefix(smallModel);
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  // OpenCode auto-compacts a session once tokens >= limit.context - maxOutputTokens.
  // Undeclared custom models resolve limit.context to 0, which silently disables
  // compaction and kills long sessions against a fixed-window backend (e.g. vLLM).
  // Absent these env vars, behavior is unchanged (no `limit` key emitted).
  const contextLimitEnv = environment.OPENCODE_MODEL_CONTEXT_LIMIT;
  const outputLimitEnv = environment.OPENCODE_MODEL_OUTPUT_LIMIT;
  const contextLimit = parseLimitEnv('OPENCODE_MODEL_CONTEXT_LIMIT', contextLimitEnv);
  const outputLimit = parseLimitEnv('OPENCODE_MODEL_OUTPUT_LIMIT', outputLimitEnv);
  if (outputLimitEnv !== undefined && contextLimit === undefined) {
    log('Ignoring OPENCODE_MODEL_OUTPUT_LIMIT: no valid OPENCODE_MODEL_CONTEXT_LIMIT to pair it with');
  }
  const modelLimit =
    contextLimit !== undefined
      ? { context: contextLimit, ...(outputLimit !== undefined ? { output: outputLimit } : {}) }
      : undefined;

  // OpenCode drops every non-text file part whose modality the model does not
  // declare: the provider transform keeps a part only when the model advertises
  // that input modality, and otherwise substitutes
  // `ERROR: Cannot read … (this model does not support <modality> input)`.
  // A registry-unknown custom model resolves each of those flags to false
  // (provider/provider.ts:1154-1158), so an image reaches the session store but
  // never the model — live-confirmed on a vLLM-hosted model, which answered
  // that it does not support image input while the prompt carried zero image
  // tokens. Declaring the modalities is the only thing that opens that gate;
  // `attachment` is a registry/UI flag rather than a pipeline gate, but it is
  // set alongside so the entry stays internally consistent.
  // Absent this env var, behavior is unchanged (no capability keys emitted).
  const modalityEnv = environment.OPENCODE_MODEL_INPUT_MODALITIES;
  const requestedModalities = (modalityEnv ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry, i, a) => a.indexOf(entry) === i)
    .filter((entry) => {
      if ((MODEL_INPUT_MODALITIES as readonly string[]).includes(entry)) return true;
      log(`Ignoring unknown OPENCODE_MODEL_INPUT_MODALITIES entry: ${entry}`);
      return false;
    })
    .filter((entry) => entry !== 'text');
  const modelModalities =
    requestedModalities.length > 0 ? { input: ['text', ...requestedModalities], output: ['text'] } : undefined;

  // Native API providers also need a placeholder to become connected before
  // any HTTP request reaches OneCLI. Model options do not depend on baseURL.
  const providerOptions: Record<string, unknown> = {
    [provider]: {
      // A custom base URL on the `openai` provider means a self-hosted
      // OpenAI-compatible endpoint (vLLM, llama.cpp, …). The stock openai
      // SDK package speaks the Responses API, whose multi-turn history
      // vLLM rejects (assistant items lack id/status) — pin the Chat
      // Completions transport. Scoped to `openai` only: other providers
      // (e.g. `openrouter`, set alongside ANTHROPIC_BASE_URL per the
      // documented OpenRouter config) ship their own native ai-sdk
      // package and must keep OpenCode's default transport resolution.
      ...(provider === 'openai' && proxyUrl ? { npm: '@ai-sdk/openai-compatible' } : {}),
      options: { apiKey: 'placeholder', ...(proxyUrl ? { baseURL: proxyUrl } : {}) },
      ...(modelsToRegister.length > 0
        ? {
            models: Object.fromEntries(
              modelsToRegister.map((mid) => {
                // limit/modalities describe the MAIN model only — the env
                // vars name no small-model equivalent. Spreading them onto
                // a distinct OPENCODE_SMALL_MODEL entry would falsely
                // declare its context window and media support as the
                // main model's own. A small model that differs from the
                // main one gets a bare entry instead, which resolves
                // through OpenCode's own undeclared-model default.
                const isMainModel = mid === providerModelId;
                return [
                  mid,
                  {
                    id: mid,
                    name: mid,
                    tool_call: true,
                    ...(isMainModel && effort ? { options: { reasoningEffort: effort } } : {}),
                    ...(isMainModel && modelLimit ? { limit: modelLimit } : {}),
                    ...(isMainModel && modelModalities ? { attachment: true, modalities: modelModalities } : {}),
                  },
                ];
              }),
            ),
          }
        : {}),
    },
  };

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    provider: providerOptions,
  };
}

// OpenCode's interactive question tool cannot wait for an answer in a headless runner.
export function resolveOpenCodeExecutionPolicy(): Record<string, unknown> {
  return {
    read: 'allow',
    edit: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    bash: 'allow',
    task: 'allow',
    external_directory: 'allow',
    todowrite: 'allow',
    question: 'deny',
    webfetch: 'allow',
    websearch: 'allow',
    codesearch: 'allow',
    lsp: 'allow',
    doom_loop: 'allow',
    skill: 'allow',
  };
}

export function buildOpenCodeConfig(
  options: ProviderOptions,
  configuration?: ResolvedRuntimeConfiguration,
): Record<string, unknown> {
  const inference = (configuration?.inference ?? resolveOpenCodeInference(options, process.env)) as Record<
    string,
    unknown
  >;
  return {
    ...inference,
    permission: configuration ? configuration.executionPolicy : resolveOpenCodeExecutionPolicy(),
    mcp: configuration ? configuration.mcpServers : mcpServersToOpenCodeConfig(options.mcpServers),
    autoupdate: false,
    snapshot: false,
    // Core's human-question tool waits up to five minutes. This request budget
    // leaves room for delivery/polling; MCP connection startup keeps its own limit.
    experimental: { mcp_timeout: 330_000 },
    plugin: [new URL('./opencode-memory-plugin.ts', import.meta.url).href],
    // Memory is rendered by the shared session hook at startup and compaction.
    // These files are the core-composed project and local instructions only.
    instructions: [`${AGENT_DIR}/CLAUDE.md`, `${AGENT_DIR}/CLAUDE.local.md`],
  };
}
