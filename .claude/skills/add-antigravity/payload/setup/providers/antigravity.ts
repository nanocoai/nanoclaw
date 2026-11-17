/**
 * Antigravity provider setup: Gemini API key hand-off and install check.
 *
 * Antigravity-owned payload code: `/add-antigravity` copies it in from the
 * skill's `payload/`. Its only trunk reach-in is the `setup/providers/index.ts`
 * barrel import; the setup picker offers Antigravity from the skill's own
 * frontmatter.
 *
 * Why a Gemini API key and no Google sign-in: agy can also log in with a
 * personal Google account, but Google's Antigravity terms (antigravity.google/terms
 * §6, restated by a Google maintainer on google-antigravity/antigravity-cli#1493)
 * do not allow that consumer OAuth login to be used from a third-party
 * harness, and NanoClaw is one. A key from Google AI Studio (or any paid
 * Gemini API key) is the supported route, and it is also the only one that
 * fits the gateway: agy sends it as a plain `x-goog-api-key` header the
 * gateway can swap.
 *
 * The key is typed once into a local masked prompt and handed straight to the
 * selected gateway's `connection()`. It is never printed, never passed in argv
 * and never written to `.env`. Containers send ANTIGRAVITY_CREDENTIAL_PLACEHOLDER
 * in its place.
 */
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import {
  getCredentialStore,
  type GatewayCredentialConnection,
  type GatewayCredentialTarget,
} from '../gateways/credential-store.js';
import { brightSelect } from '../lib/bright-select.js';
import { brandBody, note } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { registerSetupProvider } from './registry.js';

/** Must equal `ANTIGRAVITY_API_KEY_PLACEHOLDER` in src/providers/antigravity.ts (a test keeps them in sync). */
export const ANTIGRAVITY_CREDENTIAL_PLACEHOLDER = 'nc-antigravity-placeholder';

export const GEMINI_API_HOST = 'generativelanguage.googleapis.com';
export const GEMINI_API_KEY_URL = 'https://aistudio.google.com/apikey';

/**
 * The one credential agy needs. Host-wide, not path-scoped: every agy model
 * call goes to /v1beta/models/<model>:streamGenerateContent on this host with
 * the key in `x-goog-api-key`, and nothing else agy sends there carries a
 * different token. Leaving `path` out also keeps this usable on gateways
 * without `connectionPaths`.
 */
export const ANTIGRAVITY_CREDENTIAL_TARGET: GatewayCredentialTarget = {
  name: 'Antigravity Gemini API',
  kind: 'api-key',
  host: GEMINI_API_HOST,
  injection: { headerName: 'x-goog-api-key', valueFormat: '{value}' },
  proxyValue: ANTIGRAVITY_CREDENTIAL_PLACEHOLDER,
  provider: 'antigravity',
};

/** `force` replaces a stored key without asking first (key rotation). */
export interface AntigravityAuthOptions {
  force?: boolean;
  root?: string;
}

export async function antigravityCredentialConnection(root = process.cwd()): Promise<GatewayCredentialConnection> {
  const store = await getCredentialStore(root);
  if (!store.connection) throw new Error('The selected gateway does not support provider credential connections.');
  return store.connection(ANTIGRAVITY_CREDENTIAL_TARGET);
}

/** AI Studio keys are `AIza` plus 35 URL-safe characters. Advisory only. */
export function looksLikeGoogleApiKey(value: string): boolean {
  return /^AIza[0-9A-Za-z_-]{35}$/.test(value.trim());
}

/**
 * Prompt validation. Blocks only what can never work (an empty value, or
 * whitespace inside the key, which agy would send verbatim); the `AIza`
 * shape is a warning after entry, since Google issues other key formats too.
 */
export function geminiKeyProblem(value: string | undefined): string | undefined {
  const key = (value ?? '').trim();
  if (!key) return 'Enter a Gemini API key.';
  if (/\s/.test(key)) return 'A Gemini API key contains no spaces or line breaks.';
  return undefined;
}

/**
 * Gateway adapters throw operator-facing messages, but one that echoes its
 * input could carry the key. Mask the exact value and any long token-like run,
 * then keep the first line only.
 */
export function gatewayFailure(err: unknown, secret?: string): string {
  if (err instanceof SyntaxError) return `${err.name}: a gateway response could not be parsed (excerpt withheld)`;
  let message = err instanceof Error ? err.message : String(err);
  if (secret) message = message.split(secret).join('[redacted]');
  return message
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, '[redacted]')
    .split('\n')[0]
    .slice(0, 300);
}

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

function fail(code: string, message: string, details: Record<string, string> = {}): never {
  setupLog.step('auth', 'failed', 0, { PROVIDER: 'antigravity', ERROR: code, ...details });
  p.log.error(brandBody(message));
  process.exit(1);
}

export async function runAntigravityAuthStep(options: AntigravityAuthOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();
  let connection: GatewayCredentialConnection;
  let existing: { reusable: boolean } | null;
  try {
    connection = await antigravityCredentialConnection(root);
    existing = await connection.find({
      confirmHostChange: async (previous, next) =>
        ensureAnswer(
          await p.confirm({
            message: `Move the stored Antigravity Gemini API key from ${previous} to ${next}? Agents already granted it will use the new host.`,
            initialValue: false,
          }),
        ),
    });
  } catch (err) {
    const reason = gatewayFailure(err);
    fail(
      `gateway_lookup_failed: ${reason}`,
      `Couldn't read the credential gateway before connecting Antigravity: ${reason}`,
    );
  }

  if (existing?.reusable && !options.force) {
    // Without a terminal there is no one to ask; keep what is stored so a
    // scripted `provider-auth antigravity` stays idempotent.
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const choice = interactive
      ? ensureAnswer(
          await brightSelect<'keep' | 'replace'>({
            message: 'A Gemini API key for Antigravity is already in your credential gateway.',
            options: [
              { value: 'keep', label: 'Keep the stored key', hint: 'nothing changes' },
              { value: 'replace', label: 'Replace it with a new key', hint: 'for a rotated or revoked key' },
            ],
            initialValue: 'keep',
          }),
        )
      : 'keep';
    setupLog.userInput('antigravity_existing_key', choice);
    if (choice === 'keep') {
      try {
        // Lets the gateway finish anything an interrupted earlier save left undone.
        await connection.keep();
      } catch (err) {
        const reason = gatewayFailure(err);
        fail(
          `gateway_keep_failed: ${reason}`,
          `Couldn't confirm the stored Gemini API key with the credential gateway: ${reason}`,
        );
      }
      setupLog.step('auth', 'skipped', 0, { REASON: 'antigravity-key-already-present', PROVIDER: 'antigravity' });
      p.log.success(brandBody('Antigravity is already connected to the Gemini API.'));
      return;
    }
  } else if (existing && !existing.reusable) {
    p.log.warn(brandBody('The stored Antigravity Gemini API key cannot be reused as it is. Enter the key again.'));
  }

  // Without a terminal the masked prompt below never resolves: stdin hits EOF,
  // the event loop drains, and the process exits 0 with no key stored.
  if (!process.stdin.isTTY) {
    fail(
      'no_terminal',
      'A Gemini API key has to be entered in a terminal. Run `pnpm exec tsx setup/index.ts --step provider-auth antigravity` in a terminal on the NanoClaw host.',
    );
  }

  note(
    [
      'Antigravity runs on a Gemini API key, not on a Google account sign-in.',
      `Create one at ${GEMINI_API_KEY_URL}. Usage is billed to that key's`,
      'Google Cloud project at Gemini API rates (free-tier keys are rate-limited).',
      '',
      "Google's Antigravity terms do not allow a personal Google account login",
      'to be used from a third-party harness such as NanoClaw, so setup never offers one.',
      '',
      'The key goes straight to your credential gateway. Agents only ever see a placeholder.',
    ].join('\n'),
    'Gemini API key',
  );

  const key = String(
    ensureAnswer(
      await p.password({
        message: 'Paste your Gemini API key here (never in chat)',
        clearOnError: true,
        validate: geminiKeyProblem,
      }),
    ) ?? '',
  ).trim();
  // Validation already ran in the prompt; this guards a prompt that skipped it.
  const problem = geminiKeyProblem(key);
  if (problem) fail('invalid_key_shape', problem);
  if (!looksLikeGoogleApiKey(key)) {
    p.log.warn(
      brandBody(
        "That doesn't look like a Google AI Studio key (those start with AIza). Saving it anyway; if Antigravity can't reach Gemini, check the key and run provider-auth again.",
      ),
    );
  }

  try {
    await connection.save(key);
  } catch (err) {
    const reason = gatewayFailure(err, key);
    fail(`gateway_save_failed: ${reason}`, `Couldn't save your Gemini API key to the credential gateway: ${reason}`, {
      METHOD: 'api-key',
    });
  }
  setupLog.step('auth', 'success', 0, { PROVIDER: 'antigravity', METHOD: 'api-key' });
  p.log.success(
    brandBody(
      existing
        ? 'Gemini API key replaced in your credential gateway; existing grants are kept.'
        : 'Antigravity connected: the Gemini API key is in your credential gateway.',
    ),
  );
}

// ─── install check ───────────────────────────────────────────────────────

/** The five barrels `/add-antigravity` appends `import './antigravity.js';` to. */
export const ANTIGRAVITY_BARRELS = [
  'src/providers/index.ts',
  'src/provider-contracts/index.ts',
  'container/agent-runner/src/providers/index.ts',
  'container/agent-runner/src/provider-contracts/index.ts',
  'setup/providers/index.ts',
] as const;

/** Payload files the provider cannot run without. Tests other than conformance are not listed. */
export const ANTIGRAVITY_PAYLOAD_FILES = [
  'src/providers/antigravity.ts',
  'src/provider-contracts/antigravity.ts',
  'container/agent-runner/src/providers/antigravity.ts',
  'container/agent-runner/src/providers/antigravity-config.ts',
  'container/agent-runner/src/providers/antigravity-protocol.ts',
  'container/agent-runner/src/providers/antigravity.conformance.test.ts',
  'container/agent-runner/src/provider-contracts/antigravity.ts',
  'container/install-antigravity.sh',
  'setup/providers/antigravity.ts',
] as const;

/** First line of the block `/add-antigravity` inserts into container/Dockerfile. */
export const ANTIGRAVITY_DOCKERFILE_MARKER = '# ---- Antigravity CLI (add-antigravity) ----';

/** Closing line of core's marker region the block is inserted into. */
export const PROVIDER_BINARIES_OPEN = '>>> nanoclaw:provider-binaries';
export const PROVIDER_BINARIES_CLOSE = '<<< nanoclaw:provider-binaries';

/**
 * The block runs from its marker to core's `<<< nanoclaw:provider-binaries`
 * line. agy is a native binary, not an npm CLI, so it cannot go through
 * cli-tools.json.
 */
function dockerfileProblems(root: string): string[] {
  const dockerfilePath = path.join(root, 'container', 'Dockerfile');
  if (!fs.existsSync(dockerfilePath)) return ['missing file: container/Dockerfile'];
  const lines = fs.readFileSync(dockerfilePath, 'utf-8').split('\n');
  const start = lines.findIndex((line) => line.trim() === ANTIGRAVITY_DOCKERFILE_MARKER);
  if (start === -1)
    return [`container/Dockerfile is missing the Antigravity CLI block (${ANTIGRAVITY_DOCKERFILE_MARKER})`];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.includes(PROVIDER_BINARIES_CLOSE));
  const block = (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim()).filter(Boolean);

  const problems: string[] = [];
  if (!block.some((line) => line.startsWith('RUN') && line.includes('install-antigravity.sh'))) {
    problems.push('container/Dockerfile Antigravity block does not run install-antigravity.sh');
  }
  // Inside core's region the build is still root, and core's own `USER node`
  // follows. Anywhere else the install runs as `node` (and fails) or lands
  // after the provenance labels. Other skills' blocks may share the region.
  const open = lines.findIndex((line) => line.includes(PROVIDER_BINARIES_OPEN));
  if (end === -1 || open === -1 || open > start) {
    problems.push(`container/Dockerfile Antigravity block must sit inside the nanoclaw:provider-binaries region`);
  }
  return problems;
}

export function verifyAntigravityInstall(root = process.cwd()): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  for (const file of ANTIGRAVITY_PAYLOAD_FILES) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }

  for (const barrel of ANTIGRAVITY_BARRELS) {
    const barrelPath = path.join(root, barrel);
    if (!fs.existsSync(barrelPath) || !fs.readFileSync(barrelPath, 'utf-8').includes("import './antigravity.js';")) {
      problems.push(`missing barrel import in ${barrel}`);
    }
  }

  problems.push(...dockerfileProblems(root));

  return { ok: problems.length === 0, problems };
}

export async function runAntigravityInstallCheck(root = process.cwd()): Promise<void> {
  p.log.step(brandBody('Checking the Antigravity provider install…'));
  const { ok, problems } = verifyAntigravityInstall(root);
  if (ok) {
    setupLog.step('antigravity-install', 'success', 0, {});
    p.log.success(brandBody('Antigravity installed properly.'));
    return;
  }

  setupLog.step('antigravity-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The Antigravity provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  p.log.warn(
    brandBody(
      'Finish it with your coding agent of choice: open this repo and run the /add-antigravity skill, then retry setup.',
    ),
  );
  throw new Error(`Antigravity provider install is incomplete: ${problems.join('; ')}`);
}

// Self-registration: the setup picker and the standalone `provider-auth` step
// render from the registry. `label` and `hint` must match the
// `nanoclaw-provider-label` / `-hint` frontmatter of .claude/skills/add-antigravity
// (a trunk test keeps the pair in sync).
registerSetupProvider({
  value: 'antigravity',
  label: 'Antigravity',
  hint: 'Google Antigravity CLI — Gemini API key',
  runAuth: () => runAntigravityAuthStep(),
  runInstallCheck: runAntigravityInstallCheck,
});
