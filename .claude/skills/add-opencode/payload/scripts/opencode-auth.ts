import { spawn } from 'child_process';
import { isDeepStrictEqual } from 'node:util';
import { planSkill } from './skill-apply.js';
import { parseDirectives } from './skill-directives.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';

import { getCredentialStore } from '../setup/gateways/credential-store.js';
import type { ChatGptOAuthCredential, GatewayCredentialConnection } from '../setup/gateways/credential-store.js';
import { brightSelect } from '../setup/lib/bright-select.js';
import { brandBody } from '../setup/lib/theme.js';
import * as setupLog from '../setup/logs.js';
import { removeEnvVar, upsertEnvVar } from '../setup/set-env.js';
import { pathToFileURL } from 'url';
import { CONTAINER_IMAGE } from '../src/config.js';
import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import { chooseOpenCodeModel, discoverRuntimeModels, discoverLocalModelIds } from './opencode-model-config.js';
export { discoverLocalModelIds } from './opencode-model-config.js';
import { apiKeyInjection, CHATGPT_SECRET, createOpenCodeVault } from './opencode-vault.js';

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

/** Parse OpenCode's own login file. The result is the ChatGPT profile the gateway seam names; no gateway is chosen here. */
export function readOpenCodeOAuth(authJson: unknown): ChatGptOAuthCredential {
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
  if ([record.access, record.refresh, record.accountId].some((value) => /[\r\n]/.test(value as string)))
    throw new Error('OpenCode returned a multiline OAuth credential; sign in again.');
  return {
    profile: 'chatgpt',
    accessToken: record.access,
    refreshToken: record.refresh,
    accountId: record.accountId,
  };
}

export type ChatGptVault = GatewayCredentialConnection;

export function createChatGptVault(root = process.cwd()): ChatGptVault {
  return createOpenCodeVault(CHATGPT_SECRET, root);
}

export interface ChatGptAuthDeps {
  vault?: ChatGptVault;
  signIn?: (method: ChatGptLoginMethod, root: string, vault: ChatGptVault) => Promise<void>;
  root?: string;
  reauth?: boolean;
}

export async function runOpenCodeChatGptAuth(method: ChatGptLoginMethod, deps: ChatGptAuthDeps = {}): Promise<void> {
  const root = deps.root ?? process.cwd();
  const vault = deps.vault ?? createChatGptVault(root);
  const existing = await vault.find();
  // A stored login the gateway cannot keep (an expired refresh, for instance)
  // is signed in again without --reauth; the gateway decides reusability.
  if (existing?.reusable && !deps.reauth) {
    await vault.keep();
    p.log.info(
      brandBody(
        'A ChatGPT credential exists in the selected gateway; sign-in skipped. To replace an expired or revoked login, run: pnpm exec tsx scripts/opencode-auth.ts --reauth',
      ),
    );
    return;
  }
  await (deps.signIn ?? performChatGptSignIn)(method, root, vault);
}

async function performChatGptSignIn(method: ChatGptLoginMethod, root: string, vault: ChatGptVault): Promise<void> {
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
    const secret = readOpenCodeOAuth(authJson);
    // Delete native token files before any network wait. A Ctrl-C during the
    // gateway save must not strand them when the process exits immediately.
    // The gateway refuses the save if its entry changed since the lookup.
    fs.rmSync(loginDir, { recursive: true, force: true });
    await vault.save(secret);
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
      'ChatGPT credential saved in the selected gateway. Existing agent permissions and model settings are preserved. Retry the failed request.',
    ),
  );
}

export async function runOpenCodeAuthStep(options: { allowSkip?: boolean } = {}): Promise<void> {
  const startedAt = Date.now();
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
        { value: 'openrouter', label: 'OpenRouter', hint: 'API key stored in the selected gateway' },
        { value: 'deepseek', label: 'DeepSeek', hint: 'API key stored in the selected gateway' },
        {
          value: 'custom',
          label: 'Something else',
          hint: 'OpenAI, Google, Anthropic, OpenRouter, or DeepSeek API key',
        },
        ...(options.allowSkip === false
          ? []
          : [{ value: 'skip' as const, label: 'Skip for now', hint: 'configure OpenCode later' }]),
      ],
    }),
  );
  setupLog.userInput('opencode_backend', backend);

  if (backend === 'skip') {
    if (options.allowSkip === false) throw new Error('OpenCode setup requires a configured backend.');
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
  const endpoint = (await getCredentialStore()).modelEndpoint?.(baseUrl || `https://${host}`);

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
  let discoveredModels: string[] = [];
  if (model === undefined) {
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
          'Your existing key stays in the selected gateway. Enter the model id manually, or rerun setup and enter a key to list models.',
        ),
      );
    }
    model = await chooseOpenCodeModel(provider, discoveredModels);
  }
  defaults.OPENCODE_MODEL = model;
  defaults.OPENCODE_SMALL_MODEL = model;
  checkExportedDefaults(defaults);
  // A custom endpoint counts as checked only when its own catalog listed the
  // chosen model. The probe runs from the host, not through the container and
  // gateway, so the first agent reply is still the end-to-end check.
  const endpointCheck = customCatalog
    ? discoveredModels.includes(model)
      ? 'model-listed'
      : 'not-verified'
    : undefined;
  if (endpointCheck === 'not-verified') {
    p.log.warn(
      brandBody(
        `Setup couldn't confirm that ${baseUrl} serves ${model}. Your assistant's first reply will show whether it works.`,
      ),
    );
  }

  if (backend === 'chatgpt') {
    await runOpenCodeChatGptAuth(chatGptMethod);
  } else {
    await (pendingKey ?? (await promptOpenCodeApiKey(provider, baseUrl, host))).save();
  }

  await endpoint?.configure();

  // Commit defaults only after prompts and vaulting succeed. Preserve other
  // providers' endpoint settings, including the old shared variable.
  for (const [name, value] of Object.entries(defaults)) {
    if (value === undefined) removeEnvVar(name);
    else upsertEnvVar(name, value);
  }

  setupLog.step('auth', 'success', Date.now() - startedAt, {
    PROVIDER: 'opencode',
    BACKEND: backend,
    ENDPOINT_CHECK: endpointCheck,
  });
  p.log.success(brandBody('OpenCode configured. Credentials, when supplied, live in the selected gateway.'));
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
    kind: 'api-key',
    host,
    injection: apiKeyInjection(provider),
  });
  const existing = await vault.find({
    confirmHostChange: async (previous, next) =>
      answer(
        await p.confirm({
          message: `Move the existing ${provider} credential from ${previous} to ${next}? Agents already granted this credential will use the new host.`,
          initialValue: false,
        }),
      ),
  });
  const canKeep = Boolean(existing?.reusable);
  const key = normalizeOptionalInput(
    answer(
      await p.password({
        message: canKeep ? 'API key (leave blank to keep the existing credential)' : 'API key',
        validate: (value) => (canKeep || String(value ?? '').trim() ? undefined : 'Required.'),
      }),
    ),
  );
  if (!key && !canKeep) throw new Error('An API key is required for this backend.');
  return {
    key: key || undefined,
    keepExisting: !key,
    async save() {
      if (key) {
        await vault.save(key);
        p.log.info(
          brandBody(
            existing
              ? 'Gateway credential updated; its existing grants are preserved.'
              : 'Gateway credential created. Follow the selected gateway skill to grant it to agents.',
          ),
        );
      } else {
        await vault.keep();
      }
    },
  };
}

/** Setup treats a normal return as success and may select this provider as the default. */
export async function runOpenCodeSetupAuth(): Promise<void> {
  await runOpenCodeAuthStep({ allowSkip: false });
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
