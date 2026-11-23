/**
 * Setup entry for the `pi` provider.
 *
 * pi owns no login of its own: it reads credentials from its agentDir, which
 * the container fills with `gateway-managed` placeholders before every session
 * open. The selected gateway owns storage, injection, and refresh. This hook
 * therefore never asks pi for a token file — it records which provider keys the
 * gateway holds and (for API-key providers) writes them through the gateway's
 * provider-credential seam.
 *
 * ChatGPT subscription (pi's `openai-codex` provider) reuses the gateway's
 * existing Codex/ChatGPT login, so there is nothing to store here: the check
 * below only reports whether that login exists.
 */
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { readEnvFile } from '../../src/env.js';
import {
  getCredentialStore,
  type GatewayCredentialTarget,
  type ProviderCredentialStore,
} from '../gateways/credential-store.js';
import { brightSelect } from '../lib/bright-select.js';
import { brandBody } from '../lib/theme.js';
import { upsertEnvVar } from '../set-env.js';
import { registerSetupProvider } from './registry.js';

const GATEWAY_PROVIDERS_KEY = 'PI_GATEWAY_PROVIDERS';
/** Must equal PI_CREDENTIAL_PLACEHOLDER / PI_CHATGPT_PROVIDER_ID in the container payload. */
const PLACEHOLDER = 'gateway-managed';
const CHATGPT_PROVIDER_ID = 'openai-codex';

/**
 * The ChatGPT login pi reuses rather than owns, as the gateway stores it. Codex
 * recorded it under this name and host, and `find()` addresses an entry by the
 * name its own provider gave it — so a grant has to ask for `Codex`, not for pi.
 * The client id and token endpoint are OpenAI's public Codex values: `keep()`
 * reads an existing entry and never rewrites the token, so they only describe
 * the profile the record already has.
 */
const CHATGPT_RECORD_NAME = 'Codex';
const CHATGPT_RECORD_HOST = 'chatgpt.com';
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

interface ApiKeyProvider {
  id: string;
  label: string;
  hint: string;
  host: string;
  injection: { headerName: string; valueFormat: string };
}

const API_KEY_PROVIDERS: readonly ApiKeyProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude models via an Anthropic API key',
    host: 'api.anthropic.com',
    injection: { headerName: 'x-api-key', valueFormat: '{value}' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'OpenAI API key (not a ChatGPT subscription)',
    host: 'api.openai.com',
    injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  },
  {
    id: 'google',
    label: 'Google Gemini',
    hint: 'Google AI Studio key',
    host: 'generativelanguage.googleapis.com',
    injection: { headerName: 'x-goog-api-key', valueFormat: '{value}' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'One key for many hosted models',
    host: 'openrouter.ai',
    injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hint: 'DeepSeek API key',
    host: 'api.deepseek.com',
    injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  },
];

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

function apiKeyTarget(provider: ApiKeyProvider): GatewayCredentialTarget {
  return {
    name: `pi ${provider.label}`,
    host: provider.host,
    proxyValue: PLACEHOLDER,
    kind: 'api-key',
    injection: provider.injection,
    // Names the agent provider this credential belongs to. Gateways that grant
    // per agent record the saved id under it and attach it to the groups that
    // run this provider on every spawn; without it the credential is stored but
    // never granted, and the group's first turns fail with `401 access
    // restricted`. OneCLI's adapter keys its `provider-credentials.json` on it.
    provider: 'pi',
  };
}

function configuredProviders(root: string): string[] {
  const raw = process.env[GATEWAY_PROVIDERS_KEY] ?? readEnvFile([GATEWAY_PROVIDERS_KEY], root)[GATEWAY_PROVIDERS_KEY];
  return [...new Set((raw ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))];
}

/** Record a gateway-held provider id so the container writes its placeholder. */
function recordGatewayProvider(root: string, providerId: string): void {
  const providers = [...new Set([...configuredProviders(root), providerId])];
  upsertEnvVar(GATEWAY_PROVIDERS_KEY, providers.join(','), root);
}

/**
 * Attach the gateway's existing ChatGPT login to pi's groups.
 *
 * `provider-auth codex` records the login under `codex`, and a spawn grants a
 * group only the credentials recorded for the group's own provider — so without
 * this a pi group is handed nothing and its first turn dies with
 * `401 access restricted`, with the vault holding a perfectly good login. The
 * seam has no verb for "grant an existing entry to another provider"; `find()`
 * followed by `keep()` is exactly that, since `keep()` reconciles the observed
 * entry and records its id against `target.provider`.
 *
 * Returns false when the gateway cannot address the record — the caller warns
 * rather than failing a working login over a grant it could not perform.
 *
 * Exported for the setup test: the seam is the only thing that can be faked here,
 * and a real vault is not available in a unit test.
 */
export async function grantChatGptLogin(store: ProviderCredentialStore): Promise<boolean> {
  if (!store.connection) return false;
  try {
    const connection = store.connection({
      name: CHATGPT_RECORD_NAME,
      host: CHATGPT_RECORD_HOST,
      proxyValue: PLACEHOLDER,
      provider: 'pi',
      kind: 'oauth',
      oauth: { profile: 'chatgpt', clientId: CHATGPT_CLIENT_ID, tokenEndpoint: CHATGPT_TOKEN_ENDPOINT },
    });
    if (!(await connection.find())) return false;
    await connection.keep();
    return true;
  } catch {
    // Recorded state lives with the gateway, so a lookup that throws (no
    // management connection, an adapter that cannot address this record) is the
    // same outcome as one that finds nothing: pi has no grant yet.
    return false;
  }
}

async function runPiAuthStep(): Promise<void> {
  const store = await getCredentialStore();
  if (!store.connection) {
    throw new Error(
      'The selected gateway does not support provider credential connections; pi credentials must live in the gateway.',
    );
  }

  const method = ensureAnswer(
    await brightSelect<'chatgpt' | 'api' | 'skip'>({
      message: 'How should pi reach its models?',
      options: [
        {
          value: 'chatgpt',
          label: 'ChatGPT subscription (Codex)',
          hint: 'reuses the gateway login; set that up first if it is missing',
        },
        {
          value: 'api',
          label: 'Save a provider API key',
          hint: 'stored in your gateway, never copied into the container',
        },
        { value: 'skip', label: "Skip — I'll connect later", hint: 'pi turns fail auth until configured' },
      ],
    }),
  );

  if (method === 'skip') {
    p.log.warn(brandBody('pi is not connected. Add a provider key in your gateway before switching groups to pi.'));
    return;
  }

  if (method === 'chatgpt') {
    let connected = false;
    try {
      // pi's `openai-codex` provider rides the same ChatGPT login the gateway
      // stores for Codex; the seam exposes no host-based lookup, so this asks
      // the gateway for that provider name directly.
      connected = await store.has('codex');
    } catch {
      connected = false;
    }
    if (connected) {
      recordGatewayProvider(process.cwd(), CHATGPT_PROVIDER_ID);
      if (await grantChatGptLogin(store)) {
        p.log.success(brandBody('The gateway already holds a ChatGPT login — pi will use it.'));
      } else {
        p.log.warn(
          brandBody(
            'The gateway holds a ChatGPT login but it could not be granted to pi groups; their turns will fail with 401 access restricted.',
          ),
        );
        console.log(k.dim('   Re-run this step, or attach the existing secret to the pi provider in your gateway.'));
      }
      return;
    }
    p.log.warn(
      brandBody(
        'No ChatGPT login is stored in the gateway yet. Run `pnpm exec tsx setup/index.ts --step provider-auth codex`, then re-run this step.',
      ),
    );
    return;
  }

  const providerId = ensureAnswer(
    await brightSelect<string>({
      message: 'Which provider is this key for?',
      options: API_KEY_PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label, hint: entry.hint })),
    }),
  );
  const provider = API_KEY_PROVIDERS.find((entry) => entry.id === providerId)!;

  const key = ensureAnswer(
    await p.password({
      message: `Paste your ${provider.label} API key`,
      validate: (value) => (value && value.trim() ? undefined : 'Required'),
    }),
  ) as string;

  try {
    const connection = store.connection(apiKeyTarget(provider));
    // The gateway seam requires observing the entry before writing it: find()
    // records the existing id (or its absence) that save() then replaces or
    // creates. save() without a prior find() is rejected by the seam.
    await connection.find();
    await connection.save(key.trim());
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    p.log.error(brandBody(`Couldn't save the ${provider.label} key to the gateway.`));
    console.log(k.dim(`   ${message}`));
    throw err;
  }

  recordGatewayProvider(process.cwd(), provider.id);
  p.log.success(brandBody(`${provider.label} connected — the key lives in your gateway, never in the container.`));
  p.log.info(
    brandBody(
      `pi presents the literal "${PLACEHOLDER}" placeholder for this provider. Keep that value in the group's auth.json/models.json; the gateway replaces it on the wire.`,
    ),
  );
}

const REQUIRED_FILES = [
  'src/providers/pi.ts',
  'src/provider-contracts/pi.ts',
  'container/agent-runner/src/providers/pi.ts',
  'container/agent-runner/src/providers/mcp-to-pi.ts',
  'setup/providers/pi.ts',
];

const BARRELS = [
  'src/providers/index.ts',
  'src/provider-contracts/index.ts',
  'container/agent-runner/src/providers/index.ts',
  'container/agent-runner/src/provider-contracts/index.ts',
  'setup/providers/index.ts',
];

function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Verify the pi payload is fully wired — the same pre-flight the skill checks. */
export function verifyPiInstall(root = process.cwd()): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }
  for (const barrel of BARRELS) {
    const content = readIfPresent(path.join(root, barrel));
    if (!content || !content.includes("import './pi.js';")) problems.push(`missing barrel import in ${barrel}`);
  }
  const packageJson = readIfPresent(path.join(root, 'container/agent-runner/package.json'));
  if (!packageJson?.includes('@earendil-works/pi-coding-agent')) {
    problems.push('container/agent-runner/package.json is missing the @earendil-works/pi-coding-agent dependency');
  }
  return { ok: problems.length === 0, problems };
}

export async function runPiInstallCheck(root = process.cwd()): Promise<void> {
  const { ok, problems } = verifyPiInstall(root);
  if (ok) {
    p.log.success(brandBody('pi installed properly.'));
    return;
  }
  p.log.warn(brandBody('The pi provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  throw new Error(`pi provider is not fully installed: ${problems.join('; ')}`);
}

registerSetupProvider({
  value: 'pi',
  label: 'pi',
  hint: 'In-process pi SDK — models via the gateway',
  runAuth: runPiAuthStep,
  runInstallCheck: runPiInstallCheck,
});
