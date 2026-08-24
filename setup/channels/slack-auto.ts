/**
 * Automatic Slack app provisioning — the wizard's Slack channel pre-step.
 *
 * The add-slack SKILL.md owns the channel procedure (adapter install,
 * credential prompts, auth.test, DM resolution, wire). This module runs
 * BEFORE it and, when the operator opts in, provisions the agent's Slack app
 * programmatically — through the managed-Slack broker (slack.nanoclaw.dev,
 * authenticated with the registry install token; sign-in offered on demand)
 * or directly with a SLACK_MANAGER_TOKEN. The provisioned tokens are handed
 * to the skill as pre-bound `inputs`, so its nc:prompt directives skip and
 * the rest of the flow (build, auth.test, wire, welcome) runs unchanged.
 *
 * This module is the wizard UX only — prompts, flow control, spinner copy.
 * The provisioning core (manifest, scope sets, broker + direct-Slack
 * transports) is NOT part of this tree: it ships in the add-slack channel
 * payload and lives at src/provisioning/slack-app.ts on an installed tree.
 * Before offering provisioning, this pre-step ensures the module is present —
 * already installed means a plain dynamic import; otherwise it bootstraps that
 * one file from the channels branch the same way the skill engine fetches
 * payloads (git fetch + git show, remote resolution included). Setup runs
 * under tsx, so importing the fetched .ts file directly works.
 *
 * Loaded through slack-auto-register.ts via dynamic import, so a wizard run
 * that never reaches the Slack pre-step never evaluates this file or its
 * strings.
 *
 * Returns undefined to mean "walk the manual path" — never throws for
 * expected declines (not signed in, provisioning refused, cancel) or for
 * expected bootstrap failures (offline, branch missing, file missing).
 */
import * as p from '@clack/prompts';
import k from 'kleur';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import * as setupLog from '../logs.js';
import { brightSelect } from '../lib/bright-select.js';
import { confirmThenOpen } from '../lib/browser.js';
import { runInheritScript } from '../lib/inherit-script.js';
import {
  REGISTRY_LOGIN_SCRIPT,
  clearImageSource,
  imageSourceDecided,
  loginScriptAvailable,
  readImageSource,
  readRegistryAccount,
  writeImageSource,
} from '../lib/registry-state.js';
import { ensureAnswer } from '../lib/runner.js';
import { wrapForGutter } from '../lib/theme.js';

// Both browser round-trips this file waits on — connecting a workspace, and
// approving an app install — are the same wait: an operator finishing an OAuth
// step in another window and coming back.
const OAUTH_POLL_INTERVAL_MS = 5_000;
const OAUTH_POLL_TIMEOUT_MS = 5 * 60_000;

/** The provisioning core's home in an installed tree (the add-slack payload ships it). */
export const PROVISIONING_MODULE = 'src/provisioning/slack-app.ts';
const CHANNELS_BRANCH = 'channels';

// Structural mirrors of the provisioning core's exported types. Deliberately
// local: the module is not part of this tree, so nothing here may import its
// types statically — the build must pass without src/provisioning present.
export interface BrokerWorkspace {
  team_id: string;
  team_name: string;
  status: string;
  connected_as?: string;
  connected_at?: string;
}

export interface ProvisionedApp {
  appId: string;
  /** xapp-… app-level token for Socket Mode. */
  appToken: string;
  /** xoxb-… bot token — absent when auto-install was refused. */
  botToken?: string;
  /** Manual install URL — the fallback when auto-install was refused. */
  installUrl: string;
  teamDomain?: string;
  installError?: string;
}

/**
 * The slice of src/provisioning/slack-app.ts this flow calls.
 *
 * The optional attribution fields (requested_by, client_version) are
 * optional metadata riding the service request — additive and
 * safe against an installed core that predates them: the broker transport
 * spreads its spec into the HTTP body verbatim (the service ignores fields it
 * does not know), and the direct-Slack transport reads only name/description/
 * agentView, so extra fields never reach the app manifest.
 */
export interface ProvisioningCore {
  BrokerHttpError: new (status: number, path: string, detail?: string) => Error & { status: number; path: string };
  brokerListWorkspaces(token: string): Promise<BrokerWorkspace[]>;
  brokerOauthUrl(token: string): Promise<{ url: string }>;
  /**
   * Deferred install completion, for workspaces that make an admin approve
   * every app install. OPTIONAL on purpose: an installed tree carries whatever
   * version of the core its add-slack payload shipped, and a core that
   * predates these must leave this flow working — it degrades to the manual
   * walkthrough rather than failing. `waitForInstall` is what this flow drives;
   * `brokerAppStatus` is the single read it polls with.
   */
  brokerAppStatus?(token: string, appId: string): Promise<{ status: string; bot_token?: string | null }>;
  waitForInstall?(
    token: string,
    appId: string,
    opts?: { intervalMs?: number; timeoutMs?: number; onPoll?: (elapsedMs: number) => void },
  ): Promise<{ botToken: string } | null>;
  brokerProvision(
    token: string,
    spec: { team_id: string; name: string; requested_by?: string; client_version?: string },
  ): Promise<ProvisionedApp>;
  provisionManagedApp(managerToken: string, spec: { name: string; client_version?: string }): Promise<ProvisionedApp>;
  readInstallToken(): string | undefined;
  readManagerToken(): string | undefined;
  /** Where the broker calls go — named in the message when they are refused. */
  readServiceBase(): string;
}

/** Injection seam for tests — the bootstrap never touches git or the loader in a unit test. */
export interface BootstrapDeps {
  root?: string;
  /** Run a shell command at root; returns stdout, throws on failure. */
  exec?: (command: string) => string;
  importModule?: (fileUrl: string) => Promise<ProvisioningCore>;
}

/** Whether an earlier setup run already saved this install's Slack app credentials. */
function hasSavedSlackBotToken(root: string): boolean {
  try {
    return fs
      .readFileSync(path.join(root, '.env'), 'utf8')
      .split('\n')
      .some((line) => /^\s*SLACK_BOT_TOKEN\s*=\s*\S/.test(line));
  } catch {
    return false;
  }
}

/**
 * The installing host's package.json version — the clientRecord idiom from
 * setup/registry-login.ts, against the same root the provisioning-core
 * bootstrap uses. Undefined (rather than 'unknown') when unreadable, so the
 * optional client_version field is simply omitted from the request.
 */
function hostVersion(root: string): string | undefined {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const version = (pkg as Record<string, unknown>)?.version;
    return typeof version === 'string' && version.trim() ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mirror of the skill engine's remote resolution (defaultResolveRemote in
 * scripts/skill-apply.ts): NANOCLAW_CHANNELS_REMOTE override first, else the
 * first remote (origin preferred) that has the channels branch, else origin.
 */
function resolveChannelsRemote(exec: (command: string) => string): string {
  const override = process.env.NANOCLAW_CHANNELS_REMOTE;
  if (override) return override;
  const cap = (command: string): string => {
    try {
      return exec(command);
    } catch {
      return '';
    }
  };
  const remotes = cap('git remote')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const ordered = remotes.includes('origin') ? ['origin', ...remotes.filter((r) => r !== 'origin')] : remotes;
  for (const r of ordered) if (cap(`git ls-remote --heads ${r} ${CHANNELS_BRANCH}`).trim()) return r;
  return 'origin';
}

/**
 * Ensure the provisioning core is present in the tree, then import it.
 * Already installed (the add-slack payload carries it) → plain import, no
 * fetch. Absent → materialize that one file from the channels branch exactly
 * the way the skill engine copies payloads. Any failure resolves undefined —
 * the caller logs one line and walks the manual path.
 */
export async function loadProvisioningCore(deps: BootstrapDeps = {}): Promise<ProvisioningCore | undefined> {
  const root = deps.root ?? process.cwd();
  const exec =
    deps.exec ?? ((command: string) => execSync(command, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  const importModule = deps.importModule ?? ((fileUrl: string) => import(fileUrl) as Promise<ProvisioningCore>);
  const modulePath = path.join(root, PROVISIONING_MODULE);
  const start = Date.now();
  try {
    if (!fs.existsSync(modulePath)) {
      const remote = resolveChannelsRemote(exec);
      exec(`git fetch ${remote} ${CHANNELS_BRANCH}`);
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      exec(`git show ${remote}/${CHANNELS_BRANCH}:${PROVISIONING_MODULE} > ${PROVISIONING_MODULE}`);
      setupLog.step('slack-provision-bootstrap', 'success', Date.now() - start, { REMOTE: remote });
    }
    return await importModule(pathToFileURL(modulePath).href);
  } catch (err) {
    setupLog.step('slack-provision-bootstrap', 'failed', Date.now() - start, {
      ERROR: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Offer to create the agent's Slack app programmatically. Resolves to the
 * skill `inputs` to pre-bind (tokens + connection mode), or undefined for
 * the manual walkthrough. `agentName` doubles as the Slack app name.
 */
export async function maybeAutoProvisionSlack(
  agentName: string,
  deps: BootstrapDeps = {},
): Promise<Record<string, string> | undefined> {
  if (hasSavedSlackBotToken(deps.root ?? process.cwd())) {
    p.log.info(
      `${agentName} already has a Slack app connected from a previous run — reusing its saved credentials instead of creating a new one.`,
    );
    return undefined;
  }

  const core = await loadProvisioningCore(deps);
  if (!core) {
    p.log.warn("Couldn't load the Slack provisioning module — walking through manual app creation instead.");
    return undefined;
  }
  const managerToken = core.readManagerToken();
  const installToken = managerToken ? undefined : core.readInstallToken();
  // Offered even when not enrolled yet — signing in is a step of the flow,
  // not a precondition for seeing it. Hidden only when this copy has no way
  // to auto-provision at all.
  if (!managerToken && !installToken && !loginScriptAvailable()) return undefined;

  const needsSignIn = !managerToken && !installToken;
  // Automatic provisioning leads as the default; supplying your own bot
  // token stays available as the explicit, advanced alternative.
  const mode = ensureAnswer(
    await brightSelect<'auto' | 'manual'>({
      message: 'How do you want to create the Slack app?',
      initialValue: 'auto',
      options: [
        {
          value: 'auto',
          label: 'Create it for me',
          hint: needsSignIn
            ? 'Add Agent to Slack — sign in with your NanoClaw account, then app + install in one step'
            : 'Add Agent to Slack — app + install in one step, no token pasting',
        },
        {
          value: 'manual',
          label: 'I will create it myself',
          hint: 'walk through api.slack.com/apps by hand',
        },
      ],
    }),
  );
  setupLog.userInput('slack_provision_mode', mode);
  if (mode === 'manual') return undefined;

  const clientVersion = hostVersion(deps.root ?? process.cwd());
  if (managerToken) return provisionDirect(core, managerToken, agentName, clientVersion);

  // The login driver is idempotent: it validates a matching saved credential
  // without opening a browser, and re-authenticates when its issuer or token
  // is stale. Always pass through it rather than treating "a token exists" as
  // proof that the token belongs to this setup's registry environment — and
  // ask it, via --require-verified, to answer "no" rather than "keep what you
  // have" when it could not reach the service to check.
  const validatedToken = await signInForBroker(core);
  if (!validatedToken) {
    p.log.warn('Not signed in — walking through manual app creation instead.');
    return undefined;
  }
  return provisionViaBroker(core, validatedToken, agentName, clientVersion);
}

/**
 * Sign in with the NanoClaw account so the broker can act for this install.
 * Reuses the registry login driver (device flow / enrollment code) — one
 * account, one sign-in, shared by the image pull and the Slack broker.
 *
 * The login driver flips the install's image source to 'hardened' as a side
 * effect (it exists to enable the pull). Signing in for Slack must not answer
 * the image question on the operator's behalf: a deliberate local-build choice
 * is restored, and an install that has not been asked yet goes back to unasked
 * rather than silently becoming a pulling one.
 *
 * `--require-verified` is what makes the return value mean something: without
 * it the driver exits 0 for a credential it merely kept, and this function
 * cannot tell that apart from one it checked. `retry` re-authenticates a
 * credential the driver was happy with but the Slack service refused.
 */
async function signInForBroker(core: ProvisioningCore, opts: { retry?: boolean } = {}): Promise<string | undefined> {
  const savedAccount = readRegistryAccount();
  const savedService = displayServiceOrigin(savedAccount?.api);
  p.note(
    wrapForGutter(
      opts.retry
        ? [
            'The Slack service would not accept the saved credentials.',
            'Signing in again — finish it in your browser, then come',
            'back here.',
          ].join('\n')
        : savedAccount
          ? [
              'Found saved NanoClaw credentials.',
              `Service: ${savedService ?? 'unknown'}`,
              'Checking whether they are valid for this setup…',
            ].join('\n')
          : [
              'Creating the app for you runs through your NanoClaw account.',
              'A code appears below — finish the sign-in in your browser,',
              'then come back here.',
            ].join('\n'),
      6,
    ),
    'NanoClaw sign-in',
  );
  const wasDecided = imageSourceDecided();
  const priorSource = wasDecided ? readImageSource() : undefined;
  const start = Date.now();
  const args = [REGISTRY_LOGIN_SCRIPT, '--require-verified', ...(opts.retry ? ['--force'] : [])];
  const code = await runInheritScript('bash', args);
  if (priorSource === 'local') writeImageSource('local');
  else if (!wasDecided) clearImageSource();
  const token = code === 0 ? core.readInstallToken() : undefined;
  setupLog.step('slack-broker-login', token ? 'success' : code === 2 ? 'skipped' : 'failed', Date.now() - start, {
    EXIT_CODE: String(code),
    ...(opts.retry ? { RETRY: 'true' } : {}),
  });
  return token;
}

/** Display credential provenance without echoing paths, query strings, or userinfo. */
function displayServiceOrigin(api: string | undefined): string | undefined {
  if (!api) return undefined;
  try {
    const url = new URL(api);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

async function provisionDirect(
  core: ProvisioningCore,
  managerToken: string,
  name: string,
  clientVersion: string | undefined,
): Promise<Record<string, string> | undefined> {
  const s = p.spinner();
  const start = Date.now();
  s.start(`Creating ${name} in Slack… (~30s — generating its avatar first)`);
  try {
    const app = await core.provisionManagedApp(managerToken, {
      name,
      ...(clientVersion ? { client_version: clientVersion } : {}),
    });
    // No `install` argument: finishing an install is a read against the
    // broker, and a manager-token install has no credential there.
    return await finishProvisioned(app, name, s, start, 'slack-provision');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop("Couldn't create the Slack app.", 1);
    setupLog.step('slack-provision', 'failed', Date.now() - start, { ERROR: message });
    p.log.warn(`Slack said: ${message}. Walking through manual app creation instead.`);
    return undefined;
  }
}

/** An auth refusal, which no amount of retrying the same token can fix. */
function isCredentialRefusal(core: ProvisioningCore, err: unknown): boolean {
  return err instanceof core.BrokerHttpError && (err.status === 401 || err.status === 403);
}

/**
 * Which two services are involved, for the message a refusal deserves. The
 * credential comes from the account service; the call goes to the Slack
 * service; naming only the second one describes a refusal the operator can do
 * nothing about as an outage of a service that is in fact answering fine.
 */
function servicePairing(core: ProvisioningCore): string {
  const credential = displayServiceOrigin(readRegistryAccount()?.api);
  const service = displayServiceOrigin(core.readServiceBase()) ?? core.readServiceBase();
  return `Credentials from ${credential ?? 'an unrecorded service'}; Slack service is ${service}.`;
}

async function provisionViaBroker(
  core: ProvisioningCore,
  installToken: string,
  name: string,
  clientVersion: string | undefined,
): Promise<Record<string, string> | undefined> {
  let token = installToken;
  let workspaces: BrokerWorkspace[];
  const s = p.spinner();
  let start = Date.now();
  s.start('Checking your connected Slack workspaces…');
  try {
    workspaces = (await core.brokerListWorkspaces(token)).filter((w) => w.status === 'active');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A refusal means the token on disk is not one this service knows — the
    // account service verifying it says nothing about that, since the two are
    // separate deployments. One re-authentication is the only move that can
    // change the answer; a second refusal is the operator's to resolve.
    if (!isCredentialRefusal(core, err)) {
      s.stop("Couldn't reach the Slack service.", 1);
      setupLog.step('slack-broker-workspaces', 'failed', Date.now() - start, { ERROR: message });
      p.log.warn(`The service said: ${message}. Walking through manual app creation instead.`);
      return undefined;
    }
    s.stop("The Slack service didn't accept this install's credentials.", 1);
    setupLog.step('slack-broker-workspaces', 'failed', Date.now() - start, { ERROR: message, REAUTH: 'offered' });
    const refreshed = await signInForBroker(core, { retry: true });
    if (!refreshed) {
      p.log.warn(`${servicePairing(core)} Walking through manual app creation instead.`);
      return undefined;
    }
    token = refreshed;
    start = Date.now();
    s.start('Checking your connected Slack workspaces…');
    try {
      workspaces = (await core.brokerListWorkspaces(token)).filter((w) => w.status === 'active');
    } catch (retryErr) {
      const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
      s.stop("The Slack service didn't accept this install's credentials.", 1);
      setupLog.step('slack-broker-workspaces', 'failed', Date.now() - start, {
        ERROR: retryMessage,
        REAUTH: 'exhausted',
      });
      p.log.warn(
        `The service said: ${retryMessage}. ${servicePairing(core)} Walking through manual app creation instead.`,
      );
      return undefined;
    }
  }
  if (workspaces.length > 0) {
    s.stop(
      workspaces.length === 1
        ? `Found your workspace: ${workspaces[0].team_name}.`
        : `Found ${workspaces.length} connected workspaces.`,
    );
  } else {
    s.stop('No Slack workspace is connected yet.');
    workspaces = await connectWorkspace(core, token);
    if (workspaces.length === 0) return undefined;
  }

  let workspace: BrokerWorkspace | undefined;
  while (!workspace) {
    const choice = await pickWorkspace(workspaces);
    if (choice === 'manual') {
      setupLog.userInput('slack_broker_workspace', 'manual');
      p.log.info('Okay — walking through manual app creation instead.');
      return undefined;
    }
    if (choice === 'connect') {
      setupLog.userInput('slack_broker_workspace', 'connect');
      const connected = await connectWorkspace(core, token, workspaces);
      if (connected.length === 0) return undefined;
      // Slack already asked the operator which workspace to connect. Use the
      // single confirmed choice directly; only re-prompt if several changed.
      if (connected.length === 1) workspace = connected[0];
      else workspaces = connected;
      continue;
    }
    workspace = choice;
  }
  setupLog.userInput('slack_broker_workspace', workspace.team_id);
  const s2 = p.spinner();
  start = Date.now();
  s2.start(`Creating ${name} in ${workspace.team_name}… (~30s — generating its avatar first)`);
  try {
    // Optional request metadata: the service already records connected_as
    // (it recorded who connected the workspace), so sending it as
    // requested_by adds nothing sensitive — it names who asked for this app.
    // Passed verbatim (Enterprise Grid W-ids included); absent when unknown.
    const app = await core.brokerProvision(token, {
      team_id: workspace.team_id,
      name,
      ...(workspace.connected_as ? { requested_by: workspace.connected_as } : {}),
      ...(clientVersion ? { client_version: clientVersion } : {}),
    });
    const inputs = await finishProvisioned(app, name, s2, start, 'slack-broker-provision', { core, token });
    // The broker knows who connected the workspace — pre-fill the member-ID
    // prompt too (only when it matches the skill's validator; Enterprise Grid
    // W-ids fall back to the prompt like before).
    if (workspace.connected_as && /^U[A-Z0-9]{8,}$/.test(workspace.connected_as)) {
      inputs.owner_handle = workspace.connected_as;
    }
    return inputs;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s2.stop("Couldn't create the Slack app.", 1);
    setupLog.step('slack-broker-provision', 'failed', Date.now() - start, { ERROR: message });
    p.log.warn(`The service said: ${message}. Walking through manual app creation instead.`);
    return undefined;
  }
}

/**
 * Map a provisioned app onto the skill's inputs.
 *
 * A refused auto-install (admin-approval policy) is not a dead end: the app
 * exists and its install URL stays valid, so when the caller can finish the
 * install — the broker path, against a core that ships the status read — the
 * operator approves it in the browser and this waits for the bot token.
 * Everything else, and every way that wait can end without a token, falls
 * back to today's behavior: return the app token and let the skill's own
 * bot_token prompt collect the xoxb after a hand-finished install.
 */
async function finishProvisioned(
  app: ProvisionedApp,
  name: string,
  s: ReturnType<typeof p.spinner>,
  start: number,
  step: string,
  install?: { core: ProvisioningCore; token: string },
): Promise<Record<string, string>> {
  if (app.botToken) {
    s.stop(`Created and installed ${name}. ${k.dim(`(${Math.round((Date.now() - start) / 1000)}s)`)}`);
    setupLog.step(step, 'success', Date.now() - start, { APP_ID: app.appId, AUTO_INSTALL: 'true' });
    return { connection: 'provisioned', bot_token: app.botToken, app_token: app.appToken };
  }
  s.stop(`Created ${name}, but your workspace has to approve the install (${app.installError}).`, 1);
  setupLog.step(step, 'success', Date.now() - start, {
    APP_ID: app.appId,
    AUTO_INSTALL: 'false',
    INSTALL_ERROR: app.installError ?? '',
  });

  const botToken =
    install && app.installUrl ? await completeInstall(install.core, install.token, app, name) : undefined;
  if (botToken) return { connection: 'provisioned', bot_token: botToken, app_token: app.appToken };

  p.note(
    wrapForGutter(
      [
        'Install the app in the browser, then paste the "Bot User OAuth',
        'Token" (xoxb-…) from its OAuth & Permissions page at the next',
        'prompt. The app itself is created — this is the last step it needs.',
        '',
        k.dim(app.installUrl || 'https://api.slack.com/apps'),
      ].join('\n'),
      6,
    ),
    'Finish installing in Slack',
  );
  return { connection: 'provisioned', app_token: app.appToken };
}

/**
 * Walk the operator through approving the install, then wait for the bot
 * token the completed install releases. Undefined means "walk the manual
 * path" — an older core, a refusal, or an approval that has not landed yet.
 */
async function completeInstall(
  core: ProvisioningCore,
  token: string,
  app: ProvisionedApp,
  name: string,
): Promise<string | undefined> {
  if (!core.waitForInstall || !core.brokerAppStatus) {
    p.log.warn("This copy's Slack provisioning module can't finish the install for you — doing it by hand instead.");
    setupLog.step('slack-install-wait', 'skipped', 0, { REASON: 'core-predates-status-read' });
    return undefined;
  }
  p.note(
    wrapForGutter(
      [
        'Your workspace asks an admin to approve every app install, so',
        `${name} is created but not installed yet. Approve it in the`,
        "browser and come back — I'll pick it up from there, no token",
        'pasting needed.',
      ].join('\n'),
      6,
    ),
    'Approve the install',
  );
  await confirmThenOpen(app.installUrl, 'Press Enter to open Slack and approve the install');

  const s = p.spinner();
  const start = Date.now();
  s.start('Waiting for the install to be approved…');
  let installed: { botToken: string } | null;
  try {
    installed = await core.waitForInstall(token, app.appId, {
      intervalMs: OAUTH_POLL_INTERVAL_MS,
      timeoutMs: OAUTH_POLL_TIMEOUT_MS,
    });
  } catch (err) {
    // The core rethrows only what polling cannot fix — a credential this
    // service will not accept, whatever the workspace does next.
    const message = err instanceof Error ? err.message : String(err);
    s.stop("The Slack service didn't accept this install's credentials.", 1);
    setupLog.step('slack-install-wait', 'failed', Date.now() - start, { ERROR: message });
    p.log.warn(`The service said: ${message}.`);
    return undefined;
  }
  if (installed) {
    s.stop(`Installed ${name}. ${k.dim(`(${Math.round((Date.now() - start) / 1000)}s)`)}`);
    setupLog.step('slack-install-wait', 'success', Date.now() - start, { APP_ID: app.appId });
    return installed.botToken;
  }
  s.stop("The install hasn't been approved yet.", 1);
  setupLog.step('slack-install-wait', 'failed', Date.now() - start, { ERROR: 'timeout', APP_ID: app.appId });
  p.log.warn(
    `Approvals often take longer than this. ${name} is created and its app-level token is saved, so nothing needs ` +
      'creating again — once the install goes through, paste the bot token below to finish.',
  );
  return undefined;
}

/**
 * The prior workspace snapshot makes OAuth waitable: a new team id or a
 * changed `connected_at` proves the callback completed, while the unchanged
 * list present before the browser opened does not.
 */
async function connectWorkspace(
  core: ProvisioningCore,
  installToken: string,
  alreadyKnownWorkspaces: readonly BrokerWorkspace[] = [],
): Promise<BrokerWorkspace[]> {
  let url: string;
  try {
    ({ url } = await core.brokerOauthUrl(installToken));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('slack-broker-oauth', 'failed', 0, { ERROR: message });
    p.log.warn(`Couldn't start the workspace connection (${message}).`);
    return [];
  }
  p.note(
    wrapForGutter(
      [
        "You'll connect your Slack workspace so NanoClaw can create the",
        "agent's app in it. Slack will ask you to pick a workspace and",
        'approve the connection — then come back here.',
      ].join('\n'),
      6,
    ),
    'Connect your Slack workspace',
  );
  await confirmThenOpen(url, 'Press Enter to open Slack and connect your workspace');

  const s = p.spinner();
  const start = Date.now();
  const knownConnections = new Map(
    alreadyKnownWorkspaces.map((workspace) => [workspace.team_id, workspace.connected_at]),
  );
  s.start('Waiting for Slack to confirm the connection…');
  const deadline = start + OAUTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(OAUTH_POLL_INTERVAL_MS);
    let found: BrokerWorkspace[];
    try {
      found = (await core.brokerListWorkspaces(installToken)).filter((w) => w.status === 'active');
    } catch (err) {
      // An auth failure is not transient — the install token is dead and no
      // amount of polling fixes it. Everything else: keep polling.
      if (err instanceof core.BrokerHttpError && (err.status === 401 || err.status === 403)) {
        s.stop("The Slack service rejected this install's credentials.", 1);
        setupLog.step('slack-broker-oauth', 'failed', Date.now() - start, { ERROR: err.message });
        p.log.warn(`${err.message}. Re-run nanoclaw login, then retry.`);
        return [];
      }
      continue;
    }
    const confirmed = found.filter(
      (workspace) =>
        !knownConnections.has(workspace.team_id) ||
        (workspace.connected_at !== undefined && workspace.connected_at !== knownConnections.get(workspace.team_id)),
    );
    if (confirmed.length > 0) {
      const elapsedS = Math.round((Date.now() - start) / 1000);
      s.stop(`Connected to ${confirmed[0].team_name}. ${k.dim(`(${elapsedS}s)`)}`);
      setupLog.step('slack-broker-oauth', 'success', Date.now() - start, {
        TEAM_ID: confirmed[0].team_id,
        TEAM_NAME: confirmed[0].team_name,
      });
      return confirmed;
    }
  }
  s.stop("Slack didn't confirm the connection in time.", 1);
  setupLog.step('slack-broker-oauth', 'failed', Date.now() - start, { ERROR: 'timeout' });
  p.log.warn('Finish approving the connection in the browser, then retry.');
  return [];
}

type WorkspaceChoice = BrokerWorkspace | 'connect' | 'manual';

async function pickWorkspace(workspaces: BrokerWorkspace[]): Promise<WorkspaceChoice> {
  return ensureAnswer(
    await brightSelect<WorkspaceChoice>({
      message: workspaces.length === 1 ? 'Use this Slack workspace?' : 'Which workspace should the agent live in?',
      options: [
        ...workspaces.map((workspace) => ({
          value: workspace,
          label: workspaces.length === 1 ? `Use ${workspace.team_name}` : workspace.team_name,
          hint: workspace.connected_as ? `connected as ${workspace.connected_as}` : workspace.team_id,
        })),
        {
          value: 'connect',
          label: 'Connect a different workspace',
          hint: 'open Slack to connect another workspace',
        },
        {
          value: 'manual',
          label: 'Set up manually instead',
          hint: 'walk through api.slack.com/apps by hand',
        },
      ],
    }),
  );
}
