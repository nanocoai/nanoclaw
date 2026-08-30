/** Deterministic NanoClaw installer invoked by `ollama launch nanoclaw`. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applySkill, fullyApplied } from '../../../../scripts/skill-apply.js';
import { DATA_DIR, EGRESS_LOCKDOWN } from '../../../../src/config.js';
import { getAgentGroup, getAgentGroupByFolder } from '../../../../src/db/agent-groups.js';
import { initDb } from '../../../../src/db/connection.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigScalars,
} from '../../../../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../../../src/db/messaging-groups.js';
import { runMigrations } from '../../../../src/db/migrations/index.js';
import { readEnvFile } from '../../../../src/env.js';
import { getInstallSlug, getLaunchdLabel, getSystemdUnit } from '../../../../src/install-slug.js';
import {
  deleteDestination,
  getDestinationByTarget,
  normalizeName,
} from '../../../../src/modules/agent-to-agent/db/agent-destinations.js';
import { addMember } from '../../../../src/modules/permissions/db/agent-group-members.js';
import {
  grantRole,
  hasAnyOwner,
  isAdminOfAgentGroup,
  isOwner,
} from '../../../../src/modules/permissions/db/user-roles.js';
import { getUser, upsertUser } from '../../../../src/modules/permissions/db/users.js';
import type { AgentGroup } from '../../../../src/types.js';
import { isUpgradeCurrent } from '../../../../src/upgrade-state.js';
import { openUrl } from '../../../../setup/lib/browser.js';
import { upsertEnvVar } from '../../../../setup/set-env.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../../../..');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '[::1]']);
const DEFAULT_WEB_PORT = 3210;
const WEB_CHANNEL = 'local-web';
const WEB_PLATFORM_ID = 'local-web:local';
const WEB_USER_ID = WEB_PLATFORM_ID;
const WEB_TOKEN_HEADER = 'x-nanoclaw-local-web-token';
const WELCOME_TEXT = 'System instruction: run /welcome to introduce yourself to the user on this new channel.';
const OLLAMA_MODEL_STATE_DIR = path.join('provider-state', 'ollama');

export interface LaunchArgs {
  model: string;
  runtimeModel: string;
  baseUrl: string;
  webBrowsing: 'enabled' | 'disabled';
  displayName?: string;
  agentName?: string;
  group?: string;
  contextLength?: number;
}

export type ParseResult = { ok: true; value: LaunchArgs } | { ok: false; message: string };

export function parseArgs(argv: string[]): ParseResult {
  const values: Partial<
    Record<
      'model' | 'runtimeModel' | 'baseUrl' | 'webBrowsing' | 'displayName' | 'agentName' | 'group' | 'contextLength',
      string
    >
  > = {};
  const flags: Record<string, keyof typeof values> = {
    '--model': 'model',
    '--runtime-model': 'runtimeModel',
    '--base-url': 'baseUrl',
    '--web-browsing': 'webBrowsing',
    '--display-name': 'displayName',
    '--agent-name': 'agentName',
    '--group': 'group',
    '--context-length': 'contextLength',
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const key = flags[flag];
    if (!key) return { ok: false, message: `unknown argument: ${flag}` };
    const value = argv[++i];
    if (!value || value.startsWith('--')) return { ok: false, message: `missing value for ${flag}` };
    values[key] = value;
  }
  if (!values.model) return { ok: false, message: 'missing required argument: --model' };
  if (!values.baseUrl) return { ok: false, message: 'missing required argument: --base-url' };
  if (!values.webBrowsing) return { ok: false, message: 'missing required argument: --web-browsing' };
  if (!['enabled', 'disabled'].includes(values.webBrowsing)) {
    return { ok: false, message: '--web-browsing must be enabled or disabled' };
  }
  const contextLength = values.contextLength === undefined ? undefined : Number(values.contextLength);
  if (contextLength !== undefined && (!Number.isSafeInteger(contextLength) || contextLength <= 0)) {
    return { ok: false, message: '--context-length must be a positive integer' };
  }
  return {
    ok: true,
    value: {
      model: values.model,
      runtimeModel: values.runtimeModel ?? values.model,
      baseUrl: values.baseUrl,
      webBrowsing: values.webBrowsing as 'enabled' | 'disabled',
      ...(values.displayName && { displayName: values.displayName }),
      ...(values.agentName && { agentName: values.agentName }),
      ...(values.group && { group: values.group }),
      ...(contextLength !== undefined && { contextLength }),
    },
  };
}

export function writeOllamaModelState(
  sourceModel: string,
  runtimeModel: string,
  contextLength?: number,
  dataDir = DATA_DIR,
): boolean {
  const directory = path.join(dataDir, OLLAMA_MODEL_STATE_DIR);
  const target = path.join(directory, `${createHash('sha256').update(sourceModel).digest('hex')}.json`);
  const content = `${JSON.stringify({
    source: sourceModel,
    runtime: runtimeModel,
    ...(contextLength !== undefined && { contextLength }),
  })}\n`;
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) return false;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o600 });
  return true;
}

/** Convert a host-loopback URL into the address visible inside the agent container. */
export function rewriteBaseUrlForContainer(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LaunchError(1, `invalid --base-url: ${baseUrl}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LaunchError(1, '--base-url must be an http(s) URL without credentials, query, or fragment');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return baseUrl.replace(/\/$/, '');
  const suffix = `${url.port ? `:${url.port}` : ''}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`;
  return `${url.protocol}//host.docker.internal${suffix}`;
}

/** Give the local browser its own conversation with the selected agent. */
export async function ensureWebWiring(agentGroupId: string): Promise<boolean> {
  const now = new Date().toISOString();
  let newlyWired = false;
  let messagingGroup = await getMessagingGroupByPlatform(WEB_CHANNEL, WEB_PLATFORM_ID);
  if (!messagingGroup) {
    messagingGroup = {
      id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel_type: WEB_CHANNEL,
      platform_id: WEB_PLATFORM_ID,
      name: 'User',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    await createMessagingGroup(messagingGroup);
  }
  for (const wiring of await getMessagingGroupAgents(messagingGroup.id)) {
    if (wiring.agent_group_id === agentGroupId) continue;
    await deleteMessagingGroupAgent(wiring.id);
    const destination = await getDestinationByTarget(wiring.agent_group_id, 'channel', messagingGroup.id);
    if (destination) await deleteDestination(wiring.agent_group_id, destination.local_name);
  }
  if (!(await getMessagingGroupAgentByPair(messagingGroup.id, agentGroupId))) {
    await createMessagingGroupAgent({
      id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messaging_group_id: messagingGroup.id,
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    newlyWired = true;
  }

  // The CLI channel is only a bootstrap seam for creating the first group.
  // Leaving it addressable makes smaller local models send browser replies to
  // `local-cli`; once web is wired, keep the launched agent web-only.
  const cliGroup = await getMessagingGroupByPlatform('cli', 'local');
  const cliWiring = cliGroup && (await getMessagingGroupAgentByPair(cliGroup.id, agentGroupId));
  if (cliGroup && cliWiring) {
    await deleteMessagingGroupAgent(cliWiring.id);
    const destination = await getDestinationByTarget(agentGroupId, 'channel', cliGroup.id);
    if (destination) await deleteDestination(agentGroupId, destination.local_name);
  }
  return newlyWired;
}

/**
 * Register the loopback browser as the launch operator through NanoClaw's normal
 * access tables. Returns whether it holds ownership of the install.
 *
 * A launch-only install has no other human identity, so the browser becomes the
 * first owner, the same rule the wizard applies when a phone pairs
 * (`setup/pair-dial.ts`). Once an owner exists, the browser is scoped to the
 * launched group instead: launching Ollama next to an existing Telegram install
 * must not silently mint a second install-wide owner. An existing grant is never
 * downgraded, since that could lock the operator out of their own install.
 */
export async function ensureLocalWebOperator(agentGroupId: string, displayName?: string): Promise<boolean> {
  const now = new Date().toISOString();
  const currentUser = await getUser(WEB_USER_ID);
  await upsertUser({
    id: WEB_USER_ID,
    kind: WEB_CHANNEL,
    display_name: displayName ?? currentUser?.display_name ?? 'Local operator',
    created_at: now,
  });
  // Both guards are load-bearing: the user_roles primary key does not dedupe the
  // owner row (SQLite treats its NULL agent_group_id as distinct), and re-inserting
  // the scoped admin row throws. Enforced by the double-call in both ownership
  // tests in scripts/ollama-launch.test.ts.
  const alreadyOwner = await isOwner(WEB_USER_ID);
  const ownsInstall = alreadyOwner || !(await hasAnyOwner());
  if (ownsInstall) {
    if (!alreadyOwner) {
      await grantRole({ user_id: WEB_USER_ID, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
    }
  } else if (!(await isAdminOfAgentGroup(WEB_USER_ID, agentGroupId))) {
    await grantRole({
      user_id: WEB_USER_ID,
      role: 'admin',
      agent_group_id: agentGroupId,
      granted_by: null,
      granted_at: now,
    });
  }
  await addMember({ user_id: WEB_USER_ID, agent_group_id: agentGroupId, added_by: null, added_at: now });
  return ownsInstall;
}

/**
 * Point the launched group at Ollama. Unrestricted `ncl` follows install
 * ownership rather than being stamped on whatever group the launcher happens to
 * target: a non-owner launch must not widen someone else's agent group.
 */
export async function applyLaunchContainerConfig(
  agentGroupId: string,
  model: string,
  ownsInstall: boolean,
): Promise<void> {
  await ensureContainerConfig(agentGroupId, 'ollama');
  await updateContainerConfigScalars(agentGroupId, {
    provider: 'ollama',
    model,
    ...(ownsInstall && { cli_scope: 'global' }),
  });
}

export function hasReusableOnecli(env: NodeJS.ProcessEnv = process.env): boolean {
  const localBin = env.HOME ? path.join(env.HOME, '.local', 'bin') : undefined;
  const searchPath = [localBin, env.PATH].filter((entry): entry is string => Boolean(entry)).join(path.delimiter);
  const result = spawnSync('onecli', ['agents', 'list'], {
    env: { ...env, PATH: searchPath },
    stdio: 'ignore',
    timeout: 5_000,
  });
  return !result.error && result.status === 0;
}

class LaunchError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function runSkillGitCommand(command: string, cwd = PROJECT_ROOT): boolean {
  const fetch =
    /^git fetch ([A-Za-z0-9][A-Za-z0-9._-]*) \+refs\/heads\/([A-Za-z0-9][A-Za-z0-9._/-]*):refs\/remotes\/\1\/\2$/.exec(
      command,
    );
  if (fetch) {
    const remote = fetch[1]!;
    const branch = fetch[2]!;
    const result = spawnSync('git', ['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], {
      cwd,
      stdio: 'pipe',
    });
    if (result.error || result.status !== 0) throw new Error(`could not ${command}`);
    return false;
  }

  const show =
    /^git show ([A-Za-z0-9][A-Za-z0-9._/-]*):([A-Za-z0-9][A-Za-z0-9._/-]*) > ([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(
      command,
    );
  if (show) {
    const destination = path.resolve(cwd, show[3]!);
    if (!destination.startsWith(`${path.resolve(cwd)}${path.sep}`))
      throw new Error(`unexpected skill command: ${command}`);
    const result = spawnSync('git', ['show', `${show[1]}:${show[2]}`], { cwd, stdio: 'pipe' });
    if (result.error || result.status !== 0) throw new Error(`could not ${command}`);
    const changed = !fs.existsSync(destination) || !fs.readFileSync(destination).equals(result.stdout);
    if (changed) fs.writeFileSync(destination, result.stdout);
    return changed;
  }

  // Version-agnostic so a pin bump in the skill's nc:dep fence does not break the launcher.
  const dep = /^pnpm add (markdown-it@[\d.]+)$/.exec(command);
  if (dep) {
    const result = spawnSync('pnpm', ['add', dep[1]!], { cwd, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`could not ${command}`);
    return false;
  }

  throw new Error(`unexpected skill command: ${command}`);
}

async function applyBundledSkill(name: string): Promise<boolean> {
  let changed = false;
  const result = await applySkill(path.join(PROJECT_ROOT, '.claude', 'skills', name), PROJECT_ROOT, {
    inputs: {},
    mode: 'refresh',
    skipEffects: ['build', 'test', 'restart'],
    exec: (command) => {
      changed = runSkillGitCommand(command) || changed;
    },
  });
  if (!fullyApplied(result)) {
    const reason = result.agentTasks[0]?.reason ?? result.deferred[0] ?? 'unknown failure';
    throw new LaunchError(1, `could not apply /${name}: ${reason}`);
  }
  return changed;
}

export function providerPayloadNeedsContainerBuild(onboarded: boolean, providerChanged: boolean): boolean {
  return onboarded && providerChanged;
}

function runSetupStep(step: string, args: string[] = [], env?: NodeJS.ProcessEnv): void {
  console.error(`[ollama-launch] ${step}`);
  const result = spawnSync('pnpm', ['exec', 'tsx', 'setup/index.ts', '--step', step, ...args], {
    cwd: PROJECT_ROOT,
    env: env ?? process.env,
    stdio: 'inherit',
  });
  if (result.error) throw new LaunchError(1, `failed to start setup step ${step}: ${result.error.message}`);
  if (result.status !== 0) throw new LaunchError(1, `setup step ${step} failed`);
}

function restartAgentGroup(agentGroupId: string): void {
  const result = spawnSync(path.join(PROJECT_ROOT, 'bin', 'ncl'), ['groups', 'restart', '--id', agentGroupId], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw new LaunchError(1, `failed to restart agent group: ${result.error.message}`);
  if (result.status !== 0) throw new LaunchError(1, 'failed to restart agent group');
}

async function waitForCli(): Promise<void> {
  const cli = path.join(PROJECT_ROOT, 'bin', 'ncl');
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync(cli, ['groups', 'list'], { cwd: PROJECT_ROOT, stdio: 'ignore' });
    if (!result.error && result.status === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  throw new LaunchError(1, 'NanoClaw started, but its ncl socket is not ready; check logs/nanoclaw.error.log');
}

async function resolveAgentGroup(args: Pick<LaunchArgs, 'group' | 'displayName'>): Promise<AgentGroup> {
  if (args.group) {
    const group = await getAgentGroup(args.group);
    if (!group) throw new LaunchError(1, `no agent group with id ${args.group}`);
    return group;
  }
  if (args.displayName) {
    const folder = `cli-with-${normalizeName(args.displayName)}`;
    const group = await getAgentGroupByFolder(folder);
    if (!group) throw new LaunchError(1, `agent group was not created for ${args.displayName}`);
    return group;
  }
  const webGroup = await getMessagingGroupByPlatform(WEB_CHANNEL, WEB_PLATFORM_ID);
  const cliGroup = await getMessagingGroupByPlatform('cli', 'local');
  const messagingGroup = webGroup ?? cliGroup;
  // getMessagingGroupAgents orders by priority DESC already; the first row is the primary wiring.
  const wiring = messagingGroup && (await getMessagingGroupAgents(messagingGroup.id))[0];
  const group = wiring && (await getAgentGroup(wiring.agent_group_id));
  if (!group) throw new LaunchError(1, 'no local agent found; retry with --display-name');
  return group;
}

function configuredWebPort(): number {
  // Duplicates the local-web adapter's port resolution: main cannot import the
  // adapter payload (it is installed from the channels branch at skill time).
  const raw = process.env.NANOCLAW_LOCAL_WEB_PORT ?? readEnvFile(['NANOCLAW_LOCAL_WEB_PORT']).NANOCLAW_LOCAL_WEB_PORT;
  const port = raw ? Number(raw) : DEFAULT_WEB_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new LaunchError(1, `invalid NANOCLAW_LOCAL_WEB_PORT: ${raw}`);
  }
  return port;
}

/**
 * The browser's access token, minted by the local-web adapter. The path suffix is
 * spelled out here for the same reason configuredWebPort re-derives the port: the
 * adapter is channels-branch payload that main cannot import. Absent before the
 * channel's first start, which only matters if it is still absent once /healthz
 * answers.
 */
function localWebToken(): string | null {
  const file = path.join(DATA_DIR, 'local-web', 'token');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() || null : null;
}

function isExpectedFetchFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

async function waitForWebChat(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await webChatIsReady(url)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  const restart =
    process.platform === 'darwin'
      ? `launchctl kickstart -k gui/$(id -u)/${getLaunchdLabel(PROJECT_ROOT)}`
      : `systemctl --user restart ${getSystemdUnit(PROJECT_ROOT)}`;
  throw new LaunchError(1, `web chat did not start at ${url}; check logs/nanoclaw.error.log or run ${restart}`);
}

export async function webChatIsReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).channel === WEB_CHANNEL &&
      (body as Record<string, unknown>).install === getInstallSlug(PROJECT_ROOT)
    );
  } catch (error: unknown) {
    if (isExpectedFetchFailure(error) || error instanceof SyntaxError) return false;
    throw error;
  }
}

export async function sendWiringWelcome(url: string, token: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${url}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url, [WEB_TOKEN_HEADER]: token },
      body: JSON.stringify({ text: WELCOME_TEXT }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error: unknown) {
    if (!isExpectedFetchFailure(error)) throw error;
    throw new LaunchError(1, `could not queue the local web welcome at ${url}`);
  }
  if (!response.ok) throw new LaunchError(1, `could not queue the local web welcome (HTTP ${response.status})`);
}

async function warmOllama(baseUrl: string, model: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: -1 }),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new LaunchError(1, `Ollama could not load ${model} (HTTP ${response.status})`);
  } catch (error: unknown) {
    if (!isExpectedFetchFailure(error)) throw error;
    throw new LaunchError(1, `could not reach Ollama at ${baseUrl}; confirm Ollama is running and relaunch`);
  }
}

export async function verifyOllamaContext(baseUrl: string, model: string, required: number): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ps`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error: unknown) {
    if (!isExpectedFetchFailure(error)) throw error;
    throw new LaunchError(1, `could not verify ${model}'s context allocation from Ollama at ${baseUrl}`);
  }
  if (!response.ok)
    throw new LaunchError(1, `could not verify ${model}'s context allocation (HTTP ${response.status})`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new LaunchError(1, `Ollama returned an invalid context report for ${model}`);
  }
  const models =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).models
      : undefined;
  const loaded = Array.isArray(models)
    ? models.find((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const record = item as Record<string, unknown>;
        return [record.name, record.model].some(
          (name) => name === model || (typeof name === 'string' && !model.includes(':') && name === `${model}:latest`),
        );
      })
    : undefined;
  const allocated =
    loaded && typeof loaded === 'object' && !Array.isArray(loaded)
      ? (loaded as Record<string, unknown>).context_length
      : undefined;
  if (!Number.isInteger(allocated)) throw new LaunchError(1, `Ollama did not report a context allocation for ${model}`);
  if ((allocated as number) < required) {
    throw new LaunchError(
      1,
      `Ollama loaded ${model} with ${(allocated as number).toLocaleString()} tokens, below the ${required.toLocaleString()} requested by its launch alias; update Ollama and relaunch`,
    );
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) throw new LaunchError(1, parsed.message);
  if (EGRESS_LOCKDOWN) {
    throw new LaunchError(3, 'NANOCLAW_EGRESS_LOCKDOWN=true blocks access to host-loopback Ollama');
  }

  const { model, runtimeModel, baseUrl, webBrowsing, displayName, agentName, group, contextLength } = parsed.value;
  const containerBaseUrl = rewriteBaseUrlForContainer(baseUrl);
  const webPort = configuredWebPort();
  const webUrl = `http://127.0.0.1:${webPort}`;

  // Validate every external Ollama prerequisite before applying skills or
  // writing launch state. A retry after a failed warm-up must not lose the
  // fact that newly copied provider/channel code still needs a restart.
  console.error(`[ollama-launch] warming ${model}`);
  await warmOllama(baseUrl, runtimeModel);
  if (contextLength !== undefined) await verifyOllamaContext(baseUrl, runtimeModel, contextLength);

  const providerChanged = await applyBundledSkill('add-ollama-provider');
  const localWebChanged = await applyBundledSkill('add-local-web-chat');
  const skillsChanged = providerChanged || localWebChanged;

  const onboarded = isUpgradeCurrent();
  if (!onboarded) {
    runSetupStep('environment');
    const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
    if (docker.error || docker.status !== 0) throw new LaunchError(2, 'Docker is required but is not running');
    runSetupStep('container', [], { ...process.env, DOCKER_BUILDKIT: '1' });
    runSetupStep('onecli', hasReusableOnecli() ? ['--reuse'] : []);
    runSetupStep('mounts', ['--empty']);
  } else if (providerPayloadNeedsContainerBuild(onboarded, providerChanged)) {
    runSetupStep('container', [], { ...process.env, DOCKER_BUILDKIT: '1' });
  }

  const previousBaseUrl = readEnvFile(['OLLAMA_BASE_URL']).OLLAMA_BASE_URL;
  const previousWebBrowsing = readEnvFile(['OLLAMA_WEB_BROWSING']).OLLAMA_WEB_BROWSING;
  upsertEnvVar('OLLAMA_BASE_URL', containerBaseUrl);
  upsertEnvVar('OLLAMA_WEB_BROWSING', webBrowsing);
  upsertEnvVar('NANOCLAW_LOCAL_WEB_PORT', String(webPort));
  if (displayName && !group) {
    const args = ['--display-name', displayName];
    if (agentName) args.push('--agent-name', agentName);
    runSetupStep('cli-agent', args, { ...process.env, NANOCLAW_PICKED_PROVIDER: 'ollama' });
  }

  const db = await initDb(path.join(DATA_DIR, 'v2.db'));
  await runMigrations(db);
  const agentGroup = await resolveAgentGroup({ group, displayName });
  const previousConfig = await getContainerConfig(agentGroup.id);
  const ownsInstall = await ensureLocalWebOperator(agentGroup.id, displayName);
  const configChanged =
    (previousConfig?.provider ?? 'claude').toLowerCase() !== 'ollama' ||
    previousConfig?.model !== model ||
    (ownsInstall && previousConfig?.cli_scope !== 'global') ||
    previousBaseUrl !== containerBaseUrl ||
    previousWebBrowsing !== webBrowsing;
  await applyLaunchContainerConfig(agentGroup.id, model, ownsInstall);
  const runtimeModelChanged = writeOllamaModelState(model, runtimeModel, contextLength);

  // Rebuild only for a first install, newly-applied files, or a config change.
  // Warm before restart and queue the wiring welcome only after the web channel is ready.
  if (!onboarded || skillsChanged || configChanged || runtimeModelChanged || !(await webChatIsReady(webUrl))) {
    runSetupStep('service');
  }

  await waitForWebChat(webUrl);
  if (skillsChanged || configChanged || runtimeModelChanged) {
    await waitForCli();
    restartAgentGroup(agentGroup.id);
  }
  const newlyWired = await ensureWebWiring(agentGroup.id);
  await db.close();
  const token = localWebToken();
  if (!token) throw new LaunchError(1, `web chat answered at ${webUrl} but minted no access token; check logs/`);
  if (newlyWired) await sendWiringWelcome(webUrl, token);

  // Fragment, so the page can store and strip it before the URL reaches browser
  // history. openUrl is best-effort and silent on failure, and isHeadless() is
  // hardcoded false on macOS, so SSH-to-a-Mac would otherwise have no handoff at
  // all. Emit the URL unconditionally, on stderr: stdout carries the CHAT: line
  // the ollama CLI consumes, and we do not control what it does with that stream.
  // Printing the tokened URL here is safe because this is the operator's own
  // terminal; the add-local-web-chat skill must not, because it runs in an agent.
  const chatUrl = `${webUrl}/#token=${encodeURIComponent(token)}`;
  openUrl(chatUrl);
  process.stderr.write(`\nIf your browser did not open, visit:\n${chatUrl}\n\n`);
  console.log(`CHAT: ${webUrl}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof LaunchError) {
        console.error(`ollama-launch: ${error.message}`);
        process.exit(error.exitCode);
      }
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    });
}
