import { spawn } from 'child_process';
import { isDeepStrictEqual } from 'node:util';
import { planSkill } from './skill-apply.js';
import { parseDirectives } from './skill-directives.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';

import { brightSelect } from '../setup/lib/bright-select.js';
import { brandBody } from '../setup/lib/theme.js';
import * as setupLog from '../setup/logs.js';
import { removeEnvVar, upsertEnvVar } from '../setup/set-env.js';
import { pathToFileURL } from 'url';
export { buildOneCliManagedStub } from '../src/providers/opencode-auth-stub.js';
import { CONTAINER_IMAGE } from '../src/config.js';
import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import { chooseOpenCodeModel, discoverRuntimeModels, discoverLocalModelIds } from './opencode-model-config.js';
export { discoverLocalModelIds } from './opencode-model-config.js';
import { apiKeyInjection, CHATGPT_SECRET, createOpenCodeVault, findOpenCodeSecret } from './opencode-vault.js';

type Backend = 'chatgpt' | 'local' | 'openrouter' | 'deepseek' | 'custom' | 'skip';
type ChatGptLoginMethod = 'browser' | 'device';

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

function validHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      return undefined;
  } catch {
    // handled below
  }
  return 'Enter an absolute http(s) URL without embedded credentials, query, or fragment.';
}

function checkExportedDefaults(defaults: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(defaults)) {
    if (process.env[name] !== undefined && process.env[name] !== (value ?? '')) {
      throw new Error(
        `An exported ${name} overrides this selection. Unset it before changing the saved configuration.`,
      );
    }
  }
}

/** Clack returns undefined when an optional password prompt is submitted blank. */
export function normalizeOptionalInput(value: string | undefined): string {
  return value?.trim() ?? '';
}

function runInherit(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

export function buildOpenCodeLoginArgs(
  loginDir: string,
  method: ChatGptLoginMethod,
  interactive: boolean,
  identity = { uid: process.getuid?.(), gid: process.getgid?.() },
): string[] {
  const label = method === 'device' ? 'ChatGPT Pro/Plus (headless)' : 'ChatGPT Pro/Plus (browser)';
  return [
    'run',
    '--rm',
    // Match the private host directory's owner, including root installations.
    ...(identity.uid !== undefined ? ['--user', `${identity.uid}:${identity.gid ?? identity.uid}`] : []),
    ...(interactive ? ['-i', '-t'] : ['-i']),
    '-v',
    `${loginDir}:/opencode-login`,
    ...(method === 'browser' ? ['-p', '127.0.0.1:1455:1455'] : []),
    '-e',
    'XDG_DATA_HOME=/opencode-login/data',
    '-e',
    'XDG_CONFIG_HOME=/opencode-login/config',
    '-e',
    'XDG_CACHE_HOME=/opencode-login/cache',
    '-e',
    'HOME=/opencode-login',
    '--entrypoint',
    'opencode',
    CONTAINER_IMAGE,
    'auth',
    'login',
    '--provider',
    'openai',
    '--method',
    label,
  ];
}

/**
 * Translate OpenCode's `auth.json` into the Codex-shaped OAuth record OneCLI recognises.
 *
 * OneCLI's ingest classifier and its gateway injector both key off
 * `tokens.access_token` / `tokens.refresh_token`; OpenCode writes
 * `openai.access` / `openai.refresh` / `openai.accountId` instead. Vaulting the
 * OpenCode file verbatim is classified as an opaque api-key, so the gateway
 * injects the whole JSON blob as a bearer and never refreshes it. Emitting this
 * shape instead is what makes the ChatGPT credential an `oauth` secret.
 */
export function buildOneCliOAuthSecret(authJson: unknown, now: Date = new Date()): Record<string, unknown> {
  if (!authJson || typeof authJson !== 'object') throw new Error('OpenCode auth.json is not an object');
  const openai = (authJson as Record<string, unknown>).openai;
  if (!openai || typeof openai !== 'object') throw new Error('OpenCode auth.json has no OpenAI entry');
  const record = openai as Record<string, unknown>;
  if (
    record.type !== 'oauth' ||
    typeof record.access !== 'string' ||
    !record.access.trim() ||
    typeof record.refresh !== 'string' ||
    !record.refresh.trim()
  ) {
    throw new Error('OpenCode did not create an OpenAI OAuth credential');
  }
  if (typeof record.accountId !== 'string' || !record.accountId.trim()) {
    // Without an account id the gateway cannot set `chatgpt-account-id`, and every
    // ChatGPT request fails auth. Fail loudly rather than vault a broken record.
    throw new Error('OpenCode ChatGPT credential has no account id — sign in again and pick a ChatGPT plan');
  }
  return {
    tokens: {
      access_token: record.access,
      refresh_token: record.refresh,
      account_id: record.accountId,
    },
    OPENAI_API_KEY: null,
    last_refresh: now.toISOString(),
  };
}

/** Reject unavailable/ambiguous metadata rather than creating duplicate credentials. */
export function findChatGptSecret(payload: unknown): string | null {
  return findOpenCodeSecret(payload, CHATGPT_SECRET);
}

export interface ChatGptVault {
  find: () => Promise<string | null>;
  save: (secret: Record<string, unknown>, existingId: string | null) => Promise<void>;
}

/** Host-only management API; use the same gateway and key as NanoClaw's runtime. */
export function createChatGptVault(
  url?: string,
  apiKey?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): ChatGptVault {
  const vault = createOpenCodeVault(CHATGPT_SECRET, url, apiKey, fetchImpl);
  return {
    find: vault.find,
    save: async (secret, existingId) => {
      await vault.save(JSON.stringify(secret), existingId);
    },
  };
}

export interface ChatGptAuthDeps {
  vault?: ChatGptVault;
  signIn?: (method: ChatGptLoginMethod, root: string, existingId: string | null, vault: ChatGptVault) => Promise<void>;
  root?: string;
  reauth?: boolean;
}

export async function runOpenCodeChatGptAuth(method: ChatGptLoginMethod, deps: ChatGptAuthDeps = {}): Promise<void> {
  const root = deps.root ?? process.cwd();
  const vault = deps.vault ?? createChatGptVault();
  const existingId = await vault.find();
  if (existingId && !deps.reauth) {
    p.log.info(
      brandBody(
        'A ChatGPT credential exists in OneCLI; sign-in skipped. To replace an expired or revoked login, run: pnpm exec tsx scripts/opencode-auth.ts --reauth',
      ),
    );
    return;
  }
  await (deps.signIn ?? performChatGptSignIn)(method, root, existingId, vault);
}

async function performChatGptSignIn(
  method: ChatGptLoginMethod,
  root: string,
  existingId: string | null,
  vault: ChatGptVault,
): Promise<void> {
  const loginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-vault-login-'));
  try {
    p.log.step(brandBody(method === 'device' ? 'Starting ChatGPT device pairing…' : 'Opening ChatGPT sign-in…'));
    const code = await runInherit(
      CONTAINER_RUNTIME_BIN,
      buildOpenCodeLoginArgs(loginDir, method, Boolean(process.stdin.isTTY && process.stdout.isTTY)),
      process.env,
    );
    if (code !== 0) throw new Error('OpenCode ChatGPT sign-in did not complete');
    const authPath = path.join(loginDir, 'data', 'opencode', 'auth.json');
    if (!fs.existsSync(authPath)) throw new Error('OpenCode sign-in completed without writing auth.json');
    let authJson: unknown;
    try {
      authJson = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    } catch {
      throw new Error('OpenCode wrote an unreadable credential file. Sign in again.');
    }
    const secret = buildOneCliOAuthSecret(authJson);
    // Delete native token files before any network wait. A Ctrl-C during vault
    // lookup or save must not strand them when the process exits immediately.
    fs.rmSync(loginDir, { recursive: true, force: true });
    if ((await vault.find()) !== existingId)
      throw new Error('The ChatGPT vault entry changed during sign-in. Retry after checking OneCLI.');
    await vault.save(secret, existingId);
  } finally {
    fs.rmSync(loginDir, { recursive: true, force: true });
  }
}

/** Reauthentication changes the credential only, preserving backend and model defaults. */
export async function runOpenCodeAuthCli(args: string[]): Promise<void> {
  if (!args.length) return runOpenCodeAuthStep();
  if (
    args[0] !== '--reauth' ||
    (args.length !== 1 && !(args.length === 3 && args[1] === '--method' && ['device', 'browser'].includes(args[2])))
  ) {
    throw new Error('Usage: opencode-auth.ts [--reauth [--method device|browser]]');
  }
  const method = (args[2] ?? 'device') as ChatGptLoginMethod;
  await runOpenCodeChatGptAuth(method, { reauth: true });
  p.log.success(
    brandBody(
      'ChatGPT credential saved in OneCLI. Existing agent permissions and model settings are preserved. Retry the failed request.',
    ),
  );
}

export async function runOpenCodeAuthStep(): Promise<void> {
  const backend = answer(
    await brightSelect<Backend>({
      message: 'Which model backend should OpenCode use?',
      options: [
        {
          value: 'chatgpt',
          label: 'ChatGPT subscription',
          hint: 'Plus or Pro via browser sign-in or device pairing',
        },
        {
          value: 'local',
          label: 'Local or self-hosted',
          hint: 'vLLM, llama.cpp, or another OpenAI-compatible endpoint',
        },
        { value: 'openrouter', label: 'OpenRouter', hint: 'API key stored in OneCLI' },
        { value: 'deepseek', label: 'DeepSeek', hint: 'API key stored in OneCLI' },
        {
          value: 'custom',
          label: 'Something else',
          hint: 'OpenAI, Google, Anthropic, OpenRouter, or DeepSeek API key',
        },
        { value: 'skip', label: 'Skip for now', hint: 'configure OpenCode later' },
      ],
    }),
  );
  setupLog.userInput('opencode_backend', backend);

  if (backend === 'skip') {
    setupLog.step('auth', 'skipped', 0, { PROVIDER: 'opencode', REASON: 'user-skipped' });
    p.log.warn(brandBody('OpenCode configuration skipped. Re-run /add-opencode before using OpenCode groups.'));
    return;
  }

  let provider: string = backend;
  let baseUrl = '';
  let host = '';
  let chatGptMethod: ChatGptLoginMethod = 'device';
  if (backend === 'chatgpt') {
    provider = 'openai';
    host = 'chatgpt.com';
    chatGptMethod = answer(
      await brightSelect<ChatGptLoginMethod>({
        message: 'How would you like to connect ChatGPT?',
        options: [
          { value: 'device', label: 'Device pairing', hint: 'recommended over SSH — shows a URL and code' },
          {
            value: 'browser',
            label: 'Browser sign-in',
            hint: 'open the displayed URL; requires a local browser callback',
          },
        ],
      }),
    );
    setupLog.userInput('opencode_chatgpt_auth_method', chatGptMethod);
  } else if (backend === 'local') {
    provider = 'openai';
    baseUrl = answer(
      await p.text({
        message: 'OpenAI-compatible base URL (include /v1)',
        placeholder: 'http://host.docker.internal:8000/v1',
        validate: (value) => validHttpUrl(String(value ?? '').trim()),
      }),
    ).trim();
    host = new URL(baseUrl).hostname;
  } else if (backend === 'openrouter') {
    provider = 'openrouter';
    host = 'openrouter.ai';
  } else if (backend === 'deepseek') {
    provider = 'deepseek';
    host = 'api.deepseek.com';
  } else {
    provider = answer(
      await p.text({
        message: 'OpenCode provider id',
        placeholder: 'google',
        validate: (v) => {
          try {
            apiKeyInjection(
              String(v ?? '')
                .trim()
                .toLowerCase(),
            );
          } catch (error) {
            return (error as Error).message;
          }
        },
      }),
    )
      .trim()
      .toLowerCase();
    apiKeyInjection(provider);
    baseUrl = answer(
      await p.text({
        message: 'Custom API base URL (leave blank for OpenCode native configuration)',
        placeholder: 'https://api.example.com/v1',
        validate: (value) => (String(value ?? '').trim() ? validHttpUrl(String(value).trim()) : undefined),
      }),
    ).trim();
    host = baseUrl
      ? new URL(baseUrl).hostname
      : ((
          {
            google: 'generativelanguage.googleapis.com',
            anthropic: 'api.anthropic.com',
            openai: 'api.openai.com',
            openrouter: 'openrouter.ai',
            deepseek: 'api.deepseek.com',
          } as Record<string, string>
        )[provider] ?? '');
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) throw new Error('Invalid OpenCode provider id.');

  const defaults: Record<string, string | undefined> = {
    OPENCODE_PROVIDER: provider,
    OPENCODE_BASE_URL: baseUrl || 'native',
    OPENCODE_AUTH_MODE: backend === 'chatgpt' ? 'chatgpt' : undefined,
  };
  checkExportedDefaults(defaults);

  // Guarded model catalogs need the newly entered key before discovery.
  // Keeping a vaulted key never reads it back into the host setup process.
  const customCatalog = provider === 'openai' && Boolean(baseUrl);
  const exportedModel = process.env.OPENCODE_MODEL ?? process.env.OPENCODE_SMALL_MODEL;
  // An exported model restricts the choice. Resolve it without a keyed catalog
  // so a conflicting selection fails before requesting or transmitting a key.
  let model =
    customCatalog && exportedModel !== undefined ? await chooseOpenCodeModel(provider, [], exportedModel) : undefined;
  if (model !== undefined) {
    checkExportedDefaults({ OPENCODE_MODEL: model, OPENCODE_SMALL_MODEL: model });
  }
  const pendingKey =
    customCatalog && model === undefined ? await promptOpenCodeApiKey(provider, baseUrl, host) : undefined;
  if (model === undefined) {
    let discoveredModels: string[] = [];
    try {
      discoveredModels = customCatalog
        ? pendingKey?.keepExisting
          ? []
          : (await discoverLocalModelIds(baseUrl, globalThis.fetch, pendingKey?.key)).map((id) => `${provider}/${id}`)
        : discoverRuntimeModels(provider, true, backend === 'chatgpt');
    } catch {
      p.log.warn(brandBody('Could not list models. Enter a model id manually; no built-in model list is substituted.'));
    }
    if (pendingKey?.keepExisting) {
      p.log.info(
        brandBody(
          'Your existing key stays in OneCLI. Enter the model id manually, or rerun setup and enter a key to list models.',
        ),
      );
    }
    model = await chooseOpenCodeModel(provider, discoveredModels);
  }
  defaults.OPENCODE_MODEL = model;
  defaults.OPENCODE_SMALL_MODEL = model;
  checkExportedDefaults(defaults);

  if (backend === 'chatgpt') {
    await runOpenCodeChatGptAuth(chatGptMethod);
  } else {
    await (pendingKey ?? (await promptOpenCodeApiKey(provider, baseUrl, host))).save();
  }

  // Commit defaults only after prompts and vaulting succeed. Preserve other
  // providers' endpoint settings, including the old shared variable.
  for (const [name, value] of Object.entries(defaults)) {
    if (value === undefined) removeEnvVar(name);
    else upsertEnvVar(name, value);
  }

  setupLog.step('auth', 'success', 0, { PROVIDER: 'opencode', BACKEND: backend });
  p.log.success(brandBody('OpenCode configured. Credentials, when supplied, live in OneCLI.'));
}

/** Prepare credentials without changing the vault or saved defaults. */
async function promptOpenCodeApiKey(provider: string, baseUrl: string, host: string) {
  if (!host) {
    host = answer(
      await p.text({
        message: 'Credential host pattern',
        placeholder: 'api.example.com',
        validate: (v) => (String(v ?? '').trim() ? undefined : 'Required.'),
      }),
    ).trim();
  }
  const keyless =
    provider === 'openai' &&
    Boolean(baseUrl) &&
    answer(
      await p.confirm({
        message: 'Does this endpoint work without an API key?',
        initialValue: true,
      }),
    );
  if (keyless) return { key: undefined, keepExisting: false, save: async () => {} };
  const vault = createOpenCodeVault({
    name: `OpenCode ${provider}`,
    type: 'generic',
    hostPattern: host,
    injectionConfig: apiKeyInjection(provider),
  });
  const existingId = await vault.find({
    confirmHostChange: async (previous, next) =>
      answer(
        await p.confirm({
          message: `Move the existing ${provider} credential from ${previous} to ${next}? Agents already granted this credential will use the new host.`,
          initialValue: false,
        }),
      ),
  });
  const key = normalizeOptionalInput(
    answer(
      await p.password({
        message: existingId ? 'API key (leave blank to keep the existing credential)' : 'API key',
        validate: (value) => (existingId || String(value ?? '').trim() ? undefined : 'Required.'),
      }),
    ),
  );
  if (!key && !existingId) throw new Error('An API key is required for this backend.');
  return {
    key: key || undefined,
    keepExisting: !key,
    async save() {
      if (key) {
        const id = await vault.save(key, existingId);
        p.log.info(
          brandBody(
            `OneCLI credential ${id} ${existingId ? 'updated; existing grants preserved' : 'created; grant it to selective agents before use'}.`,
          ),
        );
      } else {
        await vault.keep(existingId!);
      }
    },
  };
}

/** Check declared installation state; install/refresh verifies contracts and builds the image. */
export async function checkOpenCodeInstall(): Promise<void> {
  const root = process.cwd();
  const skillDir = path.join(root, '.claude/skills/add-opencode');
  const markdown = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const { steps } = planSkill(skillDir, root);
  const installation = steps.filter(({ kind }) => ['copy', 'append', 'dep', 'json-merge'].includes(kind));
  if (!installation.length) throw new Error('OpenCode skill has no installation declarations. Restore SKILL.md.');
  const pending = installation.find(({ status }) => status !== 'skip');
  if (pending) throw new Error(`OpenCode installation is incomplete: ${pending.detail}. Refresh the provider skill.`);

  // Install mode preserves existing files and packages. Compare its declared
  // pins explicitly without maintaining a second version/file inventory here.
  const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const directive of parseDirectives(markdown)) {
    if (directive.kind === 'dep') {
      const manifest = readJson(path.join(String(directive.attrs.cwd ?? ''), 'package.json'));
      for (const spec of directive.body) {
        const at = spec.lastIndexOf('@');
        const name = spec.slice(0, at);
        const version = spec.slice(at + 1);
        if ((manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]) !== version) {
          throw new Error(
            `OpenCode dependency ${name} must match the skill pin ${version}. Refresh the provider skill.`,
          );
        }
      }
    } else if (directive.kind === 'json-merge') {
      const expected = JSON.parse(directive.body.join('\n'));
      const key = String(directive.attrs.key);
      const entries = readJson(String(directive.attrs.into)) as Record<string, unknown>[];
      const installed = entries.find((entry) => entry[key] === expected[key]);
      if (Object.entries(expected).some(([field, value]) => !isDeepStrictEqual(installed?.[field], value))) {
        throw new Error(`OpenCode ${expected[key]} does not match its skill declaration. Refresh the provider skill.`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkOpenCodeInstall()
    .then(() => runOpenCodeAuthCli(process.argv.slice(2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'OpenCode authentication failed');
      process.exitCode = 1;
    });
}
