/**
 * Non-interactive setup driver — the step sequencer for `pnpm run setup:auto`.
 *
 * Responsibility: orchestrate the sequence of steps end-to-end and route
 * between them. The runner, spawning, status parsing, spinner, abort, and
 * prompt primitives live in `setup/lib/runner.ts`; theming in
 * `setup/lib/theme.ts`; Telegram's full flow in `setup/channels/telegram.ts`.
 *
 * Config via env:
 *   NANOCLAW_DISPLAY_NAME  how the agents address the operator — skips the
 *                          prompt. Defaults to $USER.
 *   NANOCLAW_AGENT_NAME    messaging-channel agent name (consumed by the
 *                          channel flow). The CLI scratch agent is always
 *                          "Terminal Agent".
 *   NANOCLAW_AGENT_PROVIDER preselect the setup provider and skip the picker
 *                          (for packaged flows). Example: claude.
 *   NANOCLAW_SKIP          comma-separated step names to skip
 *                          (environment|container|onecli|auth|mounts|
 *                           service|cli-agent|timezone|channel|
 *                           verify|first-chat)
 *
 * Timezone is auto-detected after the CLI agent step. UTC resolves are
 * confirmed with the user, and free-text replies fall through to a
 * headless `claude -p` call for IANA-zone resolution.
 */
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import * as os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import * as p from '@clack/prompts';
import k from 'kleur';

import { BACK_TO_CHANNEL_SELECTION } from './lib/back-nav.js';
// The pre-step-aware entry point consults each channel's registered wizard
// extensions (setup/channels/companions.ts) before running its install skill
// — the wizard itself stays free of channel-specific imports.
import { runChannelSkillWithPreStep } from './channels/run-channel-skill.js';
import { runInheritScript } from './lib/inherit-script.js';
import { pingCliAgent, PING_AGENT_FOLDER, type PingResult } from './lib/agent-ping.js';
import { getSetupProvider, listSetupProviderChoices, runSetupProviderAuth } from './providers/registry.js';
import { applyProviderSkill } from './providers/install.js';
// Provider payloads self-register their picker entry + auth on import.
import './providers/index.js';
import { buildContainerImage } from './lib/container-build.js';
import { offerClaudeOnFailure } from './lib/claude-handoff.js';
import { setPickedProvider } from './lib/picked-provider.js';
import {
  AGENT_IMAGE_PIN,
  AGENT_IMAGE_REF_ENV_KEY,
  imageSourceDecided,
  readAgentImagePin,
  readImageSource,
  writeImageSource,
  type ImageSource,
} from './lib/registry-state.js';
import { upsertEnvVar } from './set-env.js';
import { applyToEnv, parseFlags, printHelp, readFromEnv } from './lib/setup-config-parse.js';
import { runAdvancedScreen } from './lib/setup-config-screen.js';
import { CONFIG, envVarFor, validateHttpUrl } from './lib/setup-config.js';
import { runWindowedStep } from './lib/windowed-runner.js';
import { runUninstallFlow } from './uninstall/flow.js';
import {
  createSetupDriver,
  DriverCancelled,
  DriverTerminalError,
  type DriverPrompt,
  type SetupReceipt,
  type SetupDriver,
} from './lib/setup-driver.js';
import { buildSetupReceipt, inspectService, queryHostHealth } from './lib/service-health.js';
import { detectExistingInstall } from './uninstall/scan.js';
import { detectRegisteredGroups, detectExistingDisplayName, readEnvKey } from './environment.js';
import { pollHealth } from './onecli.js';
import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import type { AgentGroup } from '../src/types.js';
import { claudeCliAvailable, resolveTimezoneViaClaude } from './lib/tz-from-claude.js';
import * as setupLog from './logs.js';
import { fail, runQuietChild, runQuietStep, spawnQuiet } from './lib/runner.js';
import { emit as phEmit } from './lib/diagnostics.js';
import {
  accentGreen,
  brandBody,
  brandBold,
  brandChip,
  dimWrap,
  fitToWidth,
  fmtDuration,
  wrapForGutter,
} from './lib/theme.js';
import { isValidTimezone } from '../src/timezone.js';
import { DEFAULT_AGENT_PROVIDER, TEMPLATES_DIR } from '../src/config.js';
import { SocketTransport } from '../src/cli/socket-client.js';
import { registerSensitiveValue } from './lib/redaction.js';
import { childEnvWithoutSetupSecrets, withSecretFile } from './lib/secret-file.js';
import { runClaudeSubscriptionMachineAuth } from './lib/claude-subscription-auth.js';
import { runRegistryLoginWithDriver } from './registry-login.js';
import {
  applyTemplatePick,
  clearTemplatePick,
  cloneRegistry,
  copyTemplate,
  installTemplateAgent,
  listTemplateAgents,
  listTemplatesFromDir,
  validateNewTemplateAgentName,
  type ClonedRegistry,
  type SetupTemplateAgent,
  type TemplateEntry,
  type TemplateOperation,
} from './templates.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_AGENT_NAME = 'Terminal Agent';
const RUN_START = Date.now();
const MAX_MACHINE_CHAT_OUTPUT_BYTES = 64 * 1024;

/** How an operator reaches the registry step again once setup has finished. */
const REGISTRY_STEP = 'pnpm exec tsx setup/index.ts --step registry';

/** Metric-compatible code for "nothing was signed in, and that is fine". */
const LOGIN_EXIT_SKIPPED = 2;

type ChannelChoice =
  | 'telegram'
  | 'discord'
  | 'whatsapp'
  | 'signal'
  | 'teams'
  | 'slack'
  | 'imessage'
  | 'dial'
  | 'other'
  | 'skip';

async function selectPrompt<T extends string>(
  driver: SetupDriver,
  id: string,
  opts: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  },
): Promise<T> {
  return driver.prompt({
    id,
    kind: 'singleChoice',
    message: opts.message,
    choices: opts.options.map(({ value, label, hint }) => ({ id: value, label, hint })),
    ...(opts.initialValue !== undefined ? { default: opts.initialValue } : {}),
  }) as Promise<T>;
}

async function confirmPrompt(driver: SetupDriver, id: string, message: string, initialValue = false): Promise<boolean> {
  return driver.prompt({ id, kind: 'confirm', message, default: initialValue }) as Promise<boolean>;
}

async function textPrompt(
  driver: SetupDriver,
  id: string,
  spec: Omit<DriverPrompt, 'id' | 'kind' | 'sensitive'>,
): Promise<string> {
  return driver.prompt({ ...spec, id, kind: 'text', sensitive: false }) as Promise<string>;
}

async function secretPrompt(
  driver: SetupDriver,
  id: string,
  spec: Omit<DriverPrompt, 'id' | 'kind' | 'sensitive'>,
): Promise<string> {
  return driver.prompt({ ...spec, id, kind: 'secret', sensitive: true }) as Promise<string>;
}

async function main(driver: SetupDriver): Promise<void> {
  // Make sure ~/.local/bin is on PATH for every child process we spawn.
  // Installers we run mid-setup (OneCLI, claude) drop binaries there and
  // append a PATH line to the user's shell rc, but rc updates don't reach
  // an already-running Node process — so without this patch a freshly
  // installed `onecli` is invisible to a subsequent `runInheritScript`.
  ensureLocalBinOnPath();

  // Parse CLI flags first — `--help` short-circuits before we render anything,
  // and flag values get folded into process.env so existing step code reading
  // NANOCLAW_* sees them unchanged.
  const flagResult = parseFlags(process.argv.slice(2));
  if (flagResult.help) {
    if (driver.mode === 'ndjson') {
      driver.error('help_requested', 'Machine mode does not render terminal help.', [
        { kind: 'rerun', args: ['--help'] },
      ]);
    }
    printHelp();
    return;
  }
  if (flagResult.errors.length > 0) {
    if (driver.mode === 'ndjson') {
      driver.error('invalid_arguments', flagResult.errors.join('; '));
    }
    for (const err of flagResult.errors) console.error(`error: ${err}`);
    console.error('');
    console.error('Run with --help for the full list of supported flags.');
    process.exit(1);
  }
  let configValues = { ...readFromEnv(), ...flagResult.values };
  if (driver.mode === 'ndjson') {
    const secretEntries = CONFIG.filter((entry) => entry.secret);
    const secretLaunch =
      secretEntries.some((entry) => process.env[envVarFor(entry)] !== undefined) ||
      process.env.NANOCLAW_REGISTRY_ENROLL_CODE !== undefined ||
      process.env.NANOCLAW_REGISTRY_TOKEN !== undefined;
    const secretFlag = secretEntries.some((entry) => entry.key in flagResult.values);
    if (secretLaunch || secretFlag) {
      driver.error(
        'secret_transport_forbidden',
        'Machine setup does not accept secrets through flags or environment. Use the structured authentication prompts instead.',
      );
    }
    if (configValues.anthropicBaseUrl !== undefined) {
      driver.error(
        'custom_endpoint_unsupported',
        'Machine setup does not accept custom Anthropic endpoints through advanced configuration.',
      );
    }
  }
  for (const value of [configValues.onecliApiToken, configValues.anthropicAuthToken]) {
    if (typeof value === 'string') registerSensitiveValue(value);
  }
  applyToEnv(configValues);

  // --uninstall routes to the uninstall flow before any setup side effects —
  // in particular before initProgressionLog(), so an uninstall never resets
  // logs/setup.log on its way to (possibly) deleting logs/ entirely.
  if (configValues.uninstall === true) {
    await runUninstallFlow(
      {
        dryRun: configValues.dryRun === true,
        yes: configValues.yes === true,
        invokedFrom: 'flag',
      },
      driver,
    );
  }

  printIntro(driver);
  initProgressionLog();
  phEmit('auto_started');

  // Welcome menu — default path or open advanced overrides before any setup
  // work begins. Default lands on standard so Enter is the happy path.
  // On sg re-exec, the user already chose — skip straight to standard.
  let startChoice: 'default' | 'advanced' = 'default';
  if (process.env.NANOCLAW_REEXEC_SG !== '1') {
    startChoice = await selectPrompt(driver, 'setup-start-choice', {
      message: 'How would you like to begin?',
      options: [
        { value: 'default', label: 'Standard setup' },
        { value: 'advanced', label: 'Advanced', hint: 'override defaults' },
      ],
      initialValue: 'default',
    });
    setupLog.userInput('start_choice', startChoice);
  }
  if (startChoice === 'advanced') {
    configValues = await runAdvancedScreen(configValues, driver);
    if (driver.mode === 'ndjson' && configValues.anthropicBaseUrl !== undefined) {
      driver.error(
        'custom_endpoint_unsupported',
        'Machine setup does not accept custom Anthropic endpoints through advanced configuration.',
      );
    }
    applyToEnv(configValues);
  }

  const skip = new Set(
    (process.env.NANOCLAW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (driver.mode === 'ndjson' && skip.has('verify')) {
    driver.error('verify_cannot_be_skipped', 'Machine setup must run the existing verification step.');
  }

  // Offer removal when setup lands on an existing install. Skipped on every
  // resume path — both the fail() retry and the sg-docker re-exec pass
  // NANOCLAW_SKIP (and the latter sets NANOCLAW_REEXEC_SG) — so the prompt
  // appears at most once per fresh run.
  const isResume = process.env.NANOCLAW_REEXEC_SG === '1' || skip.size > 0;
  if (!isResume && detectExistingInstall(PROJECT_ROOT)) {
    const action = await selectPrompt(driver, 'existing-install-action', {
      message: 'NanoClaw is already installed in this folder. What would you like to do?',
      options: [
        {
          value: 'keep',
          label: 'Keep it & continue setup',
          hint: 'recommended - re-running setup is safe',
        },
        {
          value: 'uninstall',
          label: 'Uninstall NanoClaw & exit',
          hint: 'removes service, data, and agent files - asks before each step',
        },
      ],
      initialValue: 'keep',
    });
    setupLog.userInput('existing_install', action);
    phEmit('existing_install_detected', { action });
    if (action === 'uninstall') {
      if (driver.mode === 'ndjson') {
        driver.error(
          'uninstall_requires_fresh_run',
          'Start a fresh uninstall operation so its plan and receipt use the uninstall envelope.',
          [{ kind: 'rerun', args: ['--uninstall', '--protocol', 'nanoclaw.driver.v1'] }],
        );
      }
      await runUninstallFlow({ dryRun: false, yes: false, invokedFrom: 'setup-detection' }, driver);
    }
  }

  if (!skip.has('environment')) {
    const res = await runQuietStep(
      'environment',
      {
        running: 'Checking your system…',
        done: 'Your system looks good.',
      },
      [],
      driver,
    );
    if (!res.ok) {
      await fail(
        'environment',
        "Your system doesn't look quite right.",
        'See logs/setup-steps/ for details, then retry.',
        undefined,
        driver,
      );
    }
  }

  // Nothing loads .env into the wizard process — bridge the persisted pick so
  // it survives not just self re-execs (`sg docker`, fail-retry) but full
  // process restarts. Without this, a run that aborted after the pick silently
  // loses that choice on a full rerun.
  let savedPickBridged = false;
  if (!process.env.NANOCLAW_TEMPLATE_PATH?.trim()) {
    const savedPick = readEnvKey('NANOCLAW_TEMPLATE_PATH', PROJECT_ROOT)?.trim();
    if (savedPick) {
      process.env.NANOCLAW_TEMPLATE_PATH = savedPick;
      savedPickBridged = true;
    }
  }
  if (!isResume) {
    await runTemplateSetup(driver, savedPickBridged, await detectRegisteredGroups(PROJECT_ROOT));
  }

  if (!skip.has('container')) {
    await ensureMachineContainerRuntime(driver);
    driver.log(
      'message',
      brandBody(dimWrap('Your assistant lives in its own sandbox. It can only see what you explicitly share.', 4)),
    );
    // Asked before the step runs, because the step is what acts on the answer.
    await chooseImageSource(driver);
    driver.log(
      'message',
      brandBody(
        dimWrap(
          readImageSource() === 'hardened'
            ? 'Fetching the hardened image now. It is a large download, so this step takes a few minutes.'
            : 'The first build pulls a base image and installs a few tools. On a fresh machine this usually takes 3–10 minutes.',
          4,
        ),
      ),
    );
    const res = await runWindowedStep(
      'container',
      {
        running: "Preparing your assistant's sandbox…",
        done: 'Sandbox ready.',
        failed: "Couldn't prepare the sandbox.",
      },
      [],
      driver,
    );
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'runtime_not_available') {
        await fail(
          'container',
          "Docker isn't available.",
          'Install Docker Desktop (or start it if already installed), then retry.',
          undefined,
          driver,
        );
      }
      if (err === 'docker_group_not_active') {
        await fail(
          'container',
          "Docker was just installed but your shell doesn't know yet.",
          'Log out and back in (or run `newgrp docker` in a new shell), then retry.',
          undefined,
          driver,
        );
      }
      // The pull path fails for reasons a build never has, and "prune the build
      // cache" is useless advice for both of them.
      if (err === 'image_ref_not_configured') {
        await fail(
          'container',
          'This install is set to fetch a pre-built sandbox image, but nothing says which one.',
          `Set ${AGENT_IMAGE_REF_ENV_KEY} in .env (or add an "${AGENT_IMAGE_PIN}" pin to versions.json), or run \`${REGISTRY_STEP} -- --opt-out\` to build it here instead.`,
          undefined,
          driver,
        );
      }
      if (err === 'image_pull_failed') {
        await fail(
          'container',
          "Couldn't fetch the sandbox image.",
          `Check your connection and that authentication finished, then retry — or run \`${REGISTRY_STEP} -- --opt-out\` to build it here instead.`,
          undefined,
          driver,
        );
      }
      await fail(
        'container',
        "Couldn't build the sandbox.",
        'If Docker has a stale cache, try: `docker builder prune -f`, then retry.',
        undefined,
        driver,
      );
    }
    maybeReexecUnderSg(driver);
  }

  if (!skip.has('onecli')) {
    driver.log(
      'message',
      brandBody(
        dimWrap(
          'Your assistant never gets your API keys directly. The vault adds them to approved requests as they leave the sandbox.',
          4,
        ),
      ),
    );

    const remoteHost = process.env.NANOCLAW_ONECLI_API_HOST?.trim();

    if (remoteHost) {
      // Advanced-settings override: user has already named a remote vault,
      // so skip the local-vs-fresh prompt entirely. Health-check it here
      // rather than letting the step fail silently — a typo in the URL is a
      // common mistake and the answer is human-fixable.
      const remoteSpinner = driver.mode === 'terminal' ? p.spinner() : null;
      if (remoteSpinner) remoteSpinner.start(`Checking remote OneCLI at ${remoteHost}…`);
      else driver.progress('onecli-remote-check', 'running', `Checking remote OneCLI at ${remoteHost}`);
      const healthy = await pollHealth(remoteHost, 5000);
      driver.throwIfCancelled();
      if (!healthy) {
        if (remoteSpinner) remoteSpinner.error(`Couldn't reach OneCLI at ${remoteHost}.`);
        else driver.progress('onecli-remote-check', 'failed');
        await fail(
          'onecli',
          `Couldn't reach OneCLI at ${remoteHost}.`,
          'Check the URL and that OneCLI is running on the remote machine, then retry.',
          undefined,
          driver,
        );
      }
      if (remoteSpinner) remoteSpinner.stop('Remote OneCLI is reachable.');
      else driver.progress('onecli-remote-check', 'succeeded');

      const res = await runQuietStep(
        'onecli',
        {
          running: `Connecting to remote OneCLI at ${remoteHost}…`,
          done: 'OneCLI vault ready.',
        },
        ['--remote-url', remoteHost],
        driver,
      );
      if (!res.ok) {
        const err = res.terminal?.fields.ERROR;
        await fail(
          'onecli',
          `Couldn't connect to remote OneCLI (${err ?? 'unknown error'}).`,
          'Check the URL and that OneCLI is running on the remote machine, then retry.',
          undefined,
          driver,
        );
      }
    } else {
      // Respect an existing OneCLI install. Re-running the installer would
      // rebind the listener and knock any other app using that gateway
      // offline — confirm with the user before doing that.
      const existing = detectExistingOnecli();
      let reuse = false;
      if (existing) {
        const choice = await selectPrompt(driver, 'onecli-existing-choice', {
          message: `Found an existing OneCLI at ${existing.apiHost}. What would you like to do?`,
          options: [
            {
              value: 'reuse',
              label: 'Use the existing instance',
              hint: 'recommended - keeps other apps bound to this vault working',
            },
            {
              value: 'fresh',
              label: 'Install a fresh instance for NanoClaw',
              hint: 'reinstalls onecli; other apps may need to reconnect',
            },
          ],
        });
        setupLog.userInput('onecli_choice', choice);
        reuse = choice === 'reuse';
      }

      const res = await runQuietStep(
        'onecli',
        {
          running: reuse ? 'Hooking up to your existing OneCLI…' : "Setting up OneCLI, your agent's vault…",
          done: 'OneCLI vault ready.',
        },
        reuse ? ['--reuse'] : [],
        driver,
      );
      if (!res.ok) {
        const err = res.terminal?.fields.ERROR;
        if (err === 'onecli_not_on_path_after_install') {
          await fail(
            'onecli',
            'OneCLI was installed but your shell needs to refresh to see it.',
            'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"`, then retry.',
            undefined,
            driver,
          );
        }
        await fail(
          'onecli',
          `Couldn't set up OneCLI (${err ?? 'unknown error'}).`,
          'Make sure curl is installed and ~/.local/bin is writable, then retry.',
          undefined,
          driver,
        );
      }
    }
  }

  let agentProvider: string | undefined;
  if (!skip.has('auth')) {
    // Agent runtime pick. Claude is the default and a no-op — choosing it
    // runs the existing Claude auth flow unchanged. A branch provider walks
    // its own auth (e.g. Codex: ChatGPT subscription or API key, vault-only)
    // and verifies its payload is wired. The pick installs and authenticates
    // the runtime; it is NOT an install-wide default — and it is NOT a
    // creation flag. Provider is a DB property of a group: the creation flows
    // create provider-agnostic groups, and setup sets the picked provider on
    // each via `ncl groups config update --provider` right after creating it
    // (the creation scripts inherit it and apply at create — see picked-provider). Existing groups switch the
    // same way (docs/provider-migration.md).
    agentProvider = await askAgentProviderChoice(driver);
    setPickedProvider(agentProvider);

    // A pulled image bakes /app/node_modules and the CLI manifest, and every
    // non-claude runtime changes one of them — so it needs an image this
    // machine builds. Settle it here: buildContainerImage() below refuses on a
    // pinned install, and reaching that refusal aborts setup with no way out
    // short of re-running it.
    if (agentProvider !== 'claude' && readImageSource() === 'hardened') {
      const leave = await confirmPrompt(
        driver,
        'provider-leave-hardened-image',
        `${agentProvider} needs a sandbox image built on this machine. Stop using the pre-built one?`,
        true,
      );
      if (!leave) {
        await fail(
          'auth',
          `${agentProvider} can't run on the pre-built sandbox image.`,
          'Re-run setup and choose Claude to keep the pre-built image.',
          undefined,
          driver,
        );
      }
      writeImageSource('local');
      setupLog.userInput('image_source', 'local');
      driver.log('info', brandBody('Switched back to a locally built sandbox image.'));
    }

    let providerEntry = getSetupProvider(agentProvider);
    if (agentProvider !== 'claude' && !providerEntry) {
      // A non-claude provider picked from the hard-wired list isn't wired in
      // this install yet — install it by applying its `/add-<name>` SKILL.md
      // in-process via the directive engine (channel style, idempotent:
      // self-skips if already installed), rebuild the image (the container step
      // already ran, the CLI manifest just changed), then load the payload's
      // setup module so it self-registers.
      const skillDir = `.claude/skills/add-${agentProvider}`;
      const providerSpinner = driver.mode === 'terminal' ? p.spinner() : null;
      if (providerSpinner) providerSpinner.start(`Installing ${agentProvider}…`);
      else driver.progress(`add-${agentProvider}`, 'running', `Installing ${agentProvider}`);
      let blockers: string[];
      try {
        ({ blockers } = await applyProviderSkill(skillDir, PROJECT_ROOT));
      } catch (err) {
        if (providerSpinner) providerSpinner.error(`Couldn't install ${agentProvider}.`);
        else driver.progress(`add-${agentProvider}`, 'failed');
        const message = err instanceof Error ? err.message : String(err);
        await fail(`add-${agentProvider}`, `Couldn't install ${agentProvider}.`, message, undefined, driver);
        return; // unreachable — fail() exits — but narrows blockers for TS
      }
      if (blockers.length) {
        if (providerSpinner) providerSpinner.error(`Couldn't install ${agentProvider}.`);
        else driver.progress(`add-${agentProvider}`, 'failed');
        await fail(
          `add-${agentProvider}`,
          `Couldn't install ${agentProvider}.`,
          blockers.join('; '),
          undefined,
          driver,
        );
      }
      if (providerSpinner) providerSpinner.stop(`${agentProvider} installed.`);
      else driver.progress(`add-${agentProvider}`, 'succeeded');
      driver.log('info', brandBody('Rebuilding the container image with the new provider…'));
      // The rebuild is not optional here: the provider's CLI manifest is baked
      // into the image, so continuing past a failed build would authenticate a
      // runtime the container cannot actually start.
      const rebuild = driver.mode === 'ndjson' ? await rebuildProviderImage(driver) : buildContainerImage();
      if (!rebuild.ok) {
        await fail(
          `add-${agentProvider}`,
          `Couldn't rebuild the container image for ${agentProvider}. ${rebuild.message}`,
          rebuild.hint,
          undefined,
          driver,
        );
      }
      await import(`./providers/${agentProvider}.js`);
      providerEntry = getSetupProvider(agentProvider);
    }
    if (providerEntry?.runAuth) {
      await runSetupProviderAuth(providerEntry, driver);
    } else {
      await runAuthStep(driver);
    }
    // Persist the pick as the instance-wide default so every future group
    // (channel-approved, ncl-created) is created on this provider. Read from
    // .env at host start; per-group `ncl groups config update --provider` wins.
    // Only after install + auth succeeded — a failed setup must not leave new
    // groups defaulting to an unauthenticated runtime.
    upsertEnvVar('DEFAULT_AGENT_PROVIDER', agentProvider);
  }

  if (!skip.has('mounts')) {
    const res = await runQuietStep(
      'mounts',
      {
        running: "Setting your assistant's access rules…",
        done: 'Access rules set.',
        skipped: 'Access rules already set.',
      },
      ['--empty'],
      driver,
    );
    if (!res.ok) {
      await fail('mounts', "Couldn't write access rules.", undefined, undefined, driver);
    }
  }

  if (!skip.has('service')) {
    await ensureMachineServicePermissions(driver);
    const res = await runQuietStep(
      'service',
      {
        running: 'Starting NanoClaw in the background…',
        done: 'NanoClaw is running.',
      },
      [],
      driver,
    );
    if (!res.ok) {
      await fail('service', "Couldn't start NanoClaw.", 'See logs/nanoclaw.error.log for details.', undefined, driver);
    }
    if (res.terminal?.fields.DOCKER_GROUP_STALE === 'true') {
      driver.log('warn', brandBody("NanoClaw's permissions need a tweak before it can reach Docker."));
      driver.log(
        'message',
        brandBody(
          '  sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' + `  systemctl --user restart ${getSystemdUnit()}`,
        ),
      );
    }
  }

  let displayName: string | undefined;
  async function resolveDisplayName(): Promise<string> {
    if (displayName) return displayName;
    const preset = process.env.NANOCLAW_DISPLAY_NAME?.trim();
    const existing = await detectExistingDisplayName(PROJECT_ROOT);
    const fallback = process.env.USER?.trim() || 'Operator';
    displayName = preset || existing || (await askDisplayName(driver, fallback));
    return displayName;
  }

  if (!skip.has('cli-agent') && (await detectRegisteredGroups(PROJECT_ROOT))) {
    skip.add('cli-agent');
    skip.add('first-chat');
  }

  if (!skip.has('cli-agent')) {
    await resolveDisplayName();
    const res = await runQuietStep(
      'cli-agent',
      {
        running: 'Bringing your assistant online…',
        done: 'Assistant wired up.',
      },
      ['--display-name', displayName!, '--agent-name', CLI_AGENT_NAME, '--folder', PING_AGENT_FOLDER],
      driver,
    );
    if (!res.ok) {
      await fail(
        'cli-agent',
        "Couldn't bring your assistant online.",
        `You can retry later with \`pnpm exec tsx scripts/init-cli-agent.ts --display-name "${displayName!}" --agent-name "${CLI_AGENT_NAME}"\`.`,
        undefined,
        driver,
      );
    }
    if (!skip.has('first-chat')) {
      driver.log(
        'message',
        brandBody(
          dimWrap(
            "Your assistant runs in an isolated sandbox. I'm going to send it a quick test message (ping) and wait for a reply (pong) to confirm it's responding. First startup typically takes 30–60 seconds while the sandbox warms up.",
            4,
          ),
        ),
      );
      const ping = await confirmAssistantResponds(driver);
      if (ping === 'ok') {
        phEmit('first_chat_ready');
        const cleanupRawLog = setupLog.stepRawLog('cleanup-cli-agent');
        const cleanupStart = Date.now();
        const cleanup = await spawnQuiet(
          'pnpm',
          ['exec', 'tsx', 'scripts/delete-cli-agent.ts', '--folder', PING_AGENT_FOLDER],
          cleanupRawLog,
          undefined,
          driver,
        );
        setupLog.step(
          'cleanup-cli-agent',
          cleanup.ok ? 'success' : 'failed',
          Date.now() - cleanupStart,
          { exit_code: cleanup.exitCode },
          cleanupRawLog,
        );
        if (!cleanup.ok) {
          driver.log(
            'warn',
            brandBody(
              `Couldn't clean up the test agent — it may still appear in your agent list. See ${cleanupRawLog} for details.`,
            ),
          );
        }
        const next = await selectPrompt(driver, 'first-chat-next', {
          message: 'What next?',
          options: [
            {
              value: 'continue',
              label: 'Continue with setup',
              hint: 'recommended',
            },
            {
              value: 'chat',
              label: 'Pause here and chat with your agent from the terminal',
            },
          ],
        });
        setupLog.userInput('first_chat_choice', next);
        if (next === 'chat') {
          const terminalAgentName = `${displayName!}'s Terminal`;
          const createRes = await runQuietChild(
            'create-terminal-agent',
            'pnpm',
            [
              'exec',
              'tsx',
              'scripts/init-cli-agent.ts',
              '--display-name',
              displayName!,
              '--agent-name',
              terminalAgentName,
            ],
            { running: `Creating ${terminalAgentName}…`, done: `${terminalAgentName} is ready.` },
            undefined,
            driver,
          );
          if (!createRes.ok) {
            await fail(
              'create-terminal-agent',
              `Couldn't create ${terminalAgentName}.`,
              'You can retry later with `pnpm exec tsx scripts/init-cli-agent.ts`.',
              undefined,
              driver,
            );
          }
          await runFirstChat(driver);
        }
      } else {
        phEmit('first_chat_failed', { reason: ping });
        renderPingFailureNote(driver, ping);
        if (driver.mode === 'terminal') {
          await offerClaudeOnFailure({
            stepName: 'cli-agent',
            msg:
              ping === 'socket_error'
                ? "NanoClaw service isn't listening on its CLI socket."
                : ping === 'output_limit'
                  ? 'The assistant returned more output than setup can safely display.'
                  : 'No reply from the assistant within 30 seconds.',
            hint:
              ping === 'socket_error'
                ? 'Socket at data/cli.sock did not accept a connection.'
                : ping === 'output_limit'
                  ? 'Inspect logs/nanoclaw.log for a runaway response.'
                  : 'Agent container may be failing to start or authenticate.',
          });
        }
      }
    }
  }

  if (!skip.has('timezone')) {
    await runTimezoneStep(driver);
  }

  const templateAgentOutcome = await installSelectedTemplateAgent(driver, agentProvider);

  // v1 → v2 migration is handled by `bash migrate-v2.sh`, not the setup flow.
  // Users migrating from v1 run that script before (or instead of) setup.

  let channelChoice: ChannelChoice = 'skip';

  if (!skip.has('channel') && templateAgentOutcome !== 'restamped') {
    // Loop so a channel sub-flow can return BACK_TO_CHANNEL_SELECTION on
    // its first prompt and bounce the user back to the chooser without
    // restarting setup. Channels not yet wired with the back option just
    // return void and the loop exits after one pass.
    let backed = true;
    while (backed) {
      backed = false;
      channelChoice = await askChannelChoice(driver);
      if (channelChoice !== 'skip' && channelChoice !== 'other') {
        await resolveDisplayName();
      }
      let result: void | typeof BACK_TO_CHANNEL_SELECTION = undefined;
      // Every channel now runs through the SKILL.md-driven flow — the whole
      // connect+wire procedure lives in each add-<channel>/SKILL.md.
      if (channelChoice === 'telegram') {
        result = await runChannelSkillWithPreStep('telegram', displayName!, { offerBack: true, driver });
      } else if (channelChoice === 'discord') {
        result = await runChannelSkillWithPreStep('discord', displayName!, { offerBack: true, driver });
      } else if (channelChoice === 'whatsapp') {
        result = await runChannelSkillWithPreStep('whatsapp', displayName!, { offerBack: true, driver });
      } else if (channelChoice === 'signal') {
        result = await runChannelSkillWithPreStep('signal', displayName!, { offerBack: true, driver });
      } else if (channelChoice === 'teams') {
        // Fresh create resolves the owner DM proactively and wires inline (the
        // welcome message reaches the human first); a drop-through re-run
        // resolves nothing and falls back to the deferred-wire ending.
        result = await runChannelSkillWithPreStep('teams', displayName!, {
          wireIfResolved: true,
          offerBack: true,
          driver,
        });
      } else if (channelChoice === 'slack') {
        result = await runChannelSkillWithPreStep('slack', displayName!, { offerBack: true, driver });
      } else if (channelChoice === 'imessage') {
        result = await runChannelSkillWithPreStep('imessage', displayName!, { offerBack: true, driver });
      } else if (channelChoice === 'dial') {
        result = await runChannelSkillWithPreStep('dial', displayName!, { offerBack: true, driver });
      } else if (channelChoice === 'other') {
        result = await askOtherChannelName(driver);
      } else {
        driver.log(
          'info',
          brandBody(
            wrapForGutter(
              'No messaging app for now. You can add one later (like Telegram, Discord, WhatsApp, Teams, Slack, or iMessage).',
              4,
            ),
          ),
        );
      }
      if (result === BACK_TO_CHANNEL_SELECTION) backed = true;
    }
  }
  // Setup-selected targets are one-run-only. A later setup derives connect
  // choices from current wirings instead of inheriting an old agent id.
  delete process.env.NANOCLAW_TEMPLATE_AGENT_ID;

  // Deferred wire (Teams): verify passes with zero groups because the
  // platform id only exists after the first DM. Tracked here so the ENDING
  // changes too — the last box must be the one remaining action, not a
  // premature "your assistant is saying hi" (no welcome DM exists yet).
  let wiringPending = false;

  let verified = false;
  if (!skip.has('verify')) {
    const res = await runQuietStep(
      'verify',
      {
        running: 'Making sure everything works together…',
        done: "Everything's connected.",
        failed: 'A few things still need your attention.',
      },
      [],
      driver,
    );
    if (!res.ok || (driver.mode === 'ndjson' && res.terminal?.fields.STATUS !== 'success')) {
      const notes: string[] = [];
      if (res.terminal?.fields.CREDENTIALS !== 'configured') {
        notes.push("• Your Claude account isn't connected. Re-run setup and try again.");
      }
      const service = res.terminal?.fields.SERVICE;
      if (service === 'running_other_checkout') {
        const label = getLaunchdLabel();
        notes.push(
          wrapForGutter(
            [
              '• Your NanoClaw service is running from a different folder on this machine.',
              '  Point it at this checkout with:',
              `    launchctl bootout gui/$(id -u)/${label}`,
              `    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`,
            ].join('\n'),
            6,
          ),
        );
      }
      if (!res.terminal?.fields.CONFIGURED_CHANNELS) {
        notes.push(
          '• Want to chat from your phone? Add a messaging app with `/add-telegram`, `/add-slack`, or `/add-discord`.',
        );
      }
      if (notes.length > 0) {
        driver.note(notes.join('\n'), "What's left");
      }
      // "What's left" is a soft failure — we don't abort like fail(), but the
      // user is still stuck and a fix is exactly what claude-assist is for.
      const summary = notes
        .map((n) => n.replace(/^•\s*/, '').split('\n')[0].trim())
        .filter(Boolean)
        .join(' · ');
      phEmit('setup_incomplete', {
        unresolved_count: notes.length,
        service_running: res.terminal?.fields.SERVICE === 'running',
        has_credentials: res.terminal?.fields.CREDENTIALS === 'configured',
      });
      if (driver.mode === 'terminal') {
        await offerClaudeOnFailure({
          stepName: 'verify',
          msg: summary || 'Verification completed with unresolved issues.',
          hint: `Terminal block: ${JSON.stringify(res.terminal?.fields ?? {})}`,
          rawLogPath: res.rawLog,
        });
        driver.outro(k.yellow('Almost there. A few things still need your attention.'));
        return;
      }
      driver.error(
        'verification_failed',
        summary || 'Verification completed with unresolved issues.',
        [
          {
            kind: 'manual',
            title: 'Resolve verification issues',
            instructions: notes.length ? notes : ['Inspect the verify raw log, fix the issue, and rerun setup.'],
          },
        ],
        'verify',
      );
    }
    verified = res.terminal?.fields.STATUS === 'success';
    wiringPending = res.terminal?.fields.WIRING === 'pending_first_dm';
  }

  if (driver.mode === 'ndjson' && !verified) {
    driver.error(
      'verification_required',
      'Setup cannot complete until verification reports STATUS: success.',
      [],
      'verify',
    );
  }

  const setupReceipt = await completionReceipt(driver);

  const rows: [string, string][] = [
    ['Chat in the terminal:', 'pnpm run chat hi'],
    ["See what's happening:", 'tail -f logs/nanoclaw.log'],
    ['Open Claude Code:', 'claude'],
  ];
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const nextSteps = rows.map(([l, c]) => `${k.cyan(l.padEnd(labelWidth))}  ${c}`).join('\n');
  driver.note(nextSteps, 'Try these');

  // Always-on warning goes before the "check your DMs" directive so the
  // caveat doesn't land after the user's already looked away at their phone.
  driver.note(
    wrapForGutter(
      "NanoClaw runs on this machine. It's only reachable while this computer is on and connected to the internet. For always-on availability, run it on a cloud VM — or keep this machine awake.",
      6,
    ),
    'Heads up',
  );

  driver.throwIfCancelled();
  setupLog.complete(Date.now() - RUN_START);
  phEmit('setup_completed', { duration_ms: Date.now() - RUN_START });

  const dmTarget = channelDmLabel(channelChoice);
  if (wiringPending) {
    // No welcome DM exists yet — the one remaining action is the last thing
    // on screen, in the same bright framed style as the "go say hi" banner.
    driver.note(
      `${brandBold('→')} ${k.bold(`Have the person you want wired DM the bot once in ${dmTarget ?? 'your chat app'} ("hi" works).`)}\nNanoClaw registers their identity and chat from that first message; then run /init-first-agent with your coding agent and pick them.`,
      "What's left",
    );
    driver.outro(k.green("You're set - one DM to go."));
  } else if (dmTarget) {
    // Bright framed banner (not dim) — the whole point of the feedback was
    // that the welcome-message signal was too easy to miss. Use p.note so it
    // renders with a visible box, cyan-bold the directive line, and put it
    // as the last thing before outro.
    driver.note(`${brandBold('→')} ${k.bold(`Check your ${dmTarget} - your assistant is saying hi.`)}`, 'Go say hi');
    driver.outro(k.green("You're set."));
  } else {
    driver.outro(k.green("You're ready! Chat with `pnpm run chat hi`."));
  }
  driver.throwIfCancelled();
  driver.completeSetup(setupReceipt);
}

async function completionReceipt(driver: SetupDriver): Promise<SetupReceipt> {
  if (driver.mode === 'terminal') {
    return {
      version: 1,
      service: { state: 'running', manager: 'pidfile', checkoutRoot: PROJECT_ROOT },
      health: { status: 'healthy' },
      resources: {
        groups: { state: 'empty', count: 0 },
        policies: { state: 'empty', count: 0 },
        skills: { state: 'empty', count: 0 },
      },
      completedAt: new Date().toISOString(),
    };
  }
  driver.throwIfCancelled();
  const service = inspectService(PROJECT_ROOT);
  let health = await queryHostHealth(PROJECT_ROOT, { signal: driver.cancellationSignal });
  for (let attempt = 0; !health && attempt < 20; attempt++) {
    driver.throwIfCancelled();
    await new Promise((resolve) => setTimeout(resolve, 250));
    driver.throwIfCancelled();
    health = await queryHostHealth(PROJECT_ROOT, { signal: driver.cancellationSignal });
  }
  driver.throwIfCancelled();
  const result = buildSetupReceipt(PROJECT_ROOT, service, health);
  if (!result.ok) {
    driver.error(
      result.code,
      result.message,
      [
        {
          kind: 'manual',
          title: 'Inspect the running service',
          instructions: ['Confirm the service points at this checkout and rerun machine setup.'],
        },
      ],
      'verify',
    );
  }
  return result.receipt;
}

function channelDmLabel(choice: ChannelChoice): string | null {
  switch (choice) {
    case 'telegram':
      return 'Telegram';
    case 'discord':
      return 'Discord DMs';
    case 'whatsapp':
      return 'WhatsApp';
    case 'signal':
      return 'Signal';
    case 'teams':
      return 'Teams';
    case 'imessage':
      return 'iMessage';
    case 'slack':
      return 'Slack DMs';
    case 'dial':
      return 'phone';
    default:
      return null;
  }
}

// ─── first-chat step ───────────────────────────────────────────────────

/**
 * Round-trip ping against the CLI socket before we ask the user to chat.
 * Renders its own spinner with elapsed time because a cold-start container
 * boot can take 30–60s — the elapsed counter is the difference between
 * "patient" and "is this hung?". Returns the raw result so the caller can
 * branch between the chat loop (ok) and a diagnostic note (anything else).
 */
async function confirmAssistantResponds(driver: SetupDriver): Promise<PingResult> {
  if (driver.mode === 'ndjson') {
    driver.progress('first-chat-ping', 'running', 'Waking your assistant');
    const result = await pingCliAgent(30_000, driver);
    driver.throwIfCancelled();
    driver.progress('first-chat-ping', result === 'ok' ? 'succeeded' : 'failed');
    return result;
  }
  const s = p.spinner();
  const start = Date.now();
  const label = 'Waking your assistant…';
  s.start(fitToWidth(label, ' (99m 59s)'));
  const tick = setInterval(() => {
    const suffix = ` (${fmtDuration(Date.now() - start)})`;
    s.message(`${fitToWidth(label, suffix)}${k.dim(suffix)}`);
  }, 1000);

  const result = await pingCliAgent();

  clearInterval(tick);
  const suffix = ` (${fmtDuration(Date.now() - start)})`;
  if (result === 'ok') {
    s.stop(`${k.bold(fitToWidth('Your assistant is ready.', suffix))}${k.dim(suffix)}`);
  } else {
    const msg =
      result === 'socket_error'
        ? "Couldn't reach the NanoClaw service."
        : result === 'output_limit'
          ? 'Your assistant returned too much output.'
          : "Your assistant didn't reply in time.";
    s.error(`${k.bold(fitToWidth(msg, suffix))}${k.dim(suffix)}`);
  }
  return result;
}

function renderPingFailureNote(driver: SetupDriver, result: PingResult): void {
  const body =
    result === 'socket_error'
      ? [
          wrapForGutter(
            "The NanoClaw service isn't listening on its local socket. Try restarting it, then chat with `pnpm run chat hi`:",
            6,
          ),
          '',
          `  macOS:  launchctl kickstart -k gui/$(id -u)/${getLaunchdLabel()}`,
          `  Linux:  systemctl --user restart ${getSystemdUnit()}`,
        ].join('\n')
      : result === 'output_limit'
        ? wrapForGutter(
            'The assistant returned more output than setup can safely display. Check `logs/nanoclaw.log`, then try `pnpm run chat hi`.',
            6,
          )
        : wrapForGutter(
            'No reply from your assistant within 30 seconds. Check `logs/nanoclaw.log` for clues, then try `pnpm run chat hi`.',
            6,
          );
  driver.note(body, 'Skipping the first chat');
}

/**
 * Chat loop. Each message is piped through `pnpm run chat`, which uses
 * the same Unix-socket path the ping just exercised, so output streams
 * back inline as the agent replies. An empty input ends the loop.
 *
 * The intro note teaches the sandbox mental model — users reported being
 * confused about what the terminal chat *is* (vs the phone channel they'd
 * set up next) and what happens to the agent when they walk away. We
 * explain once, then offer "message or Enter to continue" so the chat is
 * clearly optional.
 */
async function runFirstChat(driver: SetupDriver): Promise<void> {
  driver.note(
    wrapForGutter(
      [
        'Your assistant runs in a sandbox on this machine.',
        'It wakes up when you send a message and goes back to sleep when',
        "you're not talking — so it isn't burning resources in the background.",
        'Its memory and environment persist between conversations.',
      ].join(' '),
      6,
    ),
    'How this works',
  );
  let first = true;
  try {
    while (true) {
      const answer = await textPrompt(driver, first ? 'first-chat-message' : 'first-chat-another', {
        message: first
          ? 'Try a quick hello — or press Enter to continue setup'
          : 'Another message? Press Enter to continue setup',
        placeholder: first ? 'e.g. "hi, what can you do?"' : 'press Enter to continue',
      });
      first = false;
      const text = answer.trim();
      if (!text) return;
      await sendChatMessage(driver, text);
    }
  } finally {
    if (driver.mode === 'ndjson') driver.clearDisplay('first-chat-response');
  }
}

function sendChatMessage(driver: SetupDriver, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `pnpm --silent` suppresses the `> nanoclaw@… chat` preamble so the
    // agent's reply reads as a clean block under the prompt. Splitting on
    // whitespace mirrors `pnpm run chat hello world` — chat.ts joins argv
    // with spaces on the far side.
    const child = spawn(
      'pnpm',
      ['--silent', 'run', 'chat', ...message.split(/\s+/)],
      driver.mode === 'ndjson'
        ? { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: childEnvWithoutSetupSecrets() }
        : { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const stopGroup = (): void => {
      if (driver.mode !== 'ndjson' || !child.pid) return;
      const processGroupId = child.pid;
      try {
        process.kill(-processGroupId, 'SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          process.kill(-processGroupId, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 250);
    };
    driver.cancellationSignal?.addEventListener('abort', stopGroup, { once: true });
    if (driver.cancellationSignal?.aborted) stopGroup();
    if (driver.mode === 'ndjson') {
      let response = '';
      let responseBytes = 0;
      let outputLimitExceeded = false;
      let settled = false;
      const append = (chunk: Buffer): void => {
        if (outputLimitExceeded) return;
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_MACHINE_CHAT_OUTPUT_BYTES) {
          outputLimitExceeded = true;
          stopGroup();
          return;
        }
        response += chunk.toString('utf8');
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        append(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        append(chunk);
      });
      child.on('close', () => {
        if (settled) return;
        settled = true;
        driver.cancellationSignal?.removeEventListener('abort', stopGroup);
        if (outputLimitExceeded) {
          try {
            driver.error('first_chat_output_limit', 'The terminal chat returned more than 64 KiB of output.');
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (response.trim()) {
          driver.display({
            id: 'first-chat-response',
            kind: 'text',
            content: response.trim(),
            sensitive: false,
            label: 'Assistant',
          });
        }
        resolve();
      });
      child.on('error', () => {
        if (settled) return;
        settled = true;
        driver.cancellationSignal?.removeEventListener('abort', stopGroup);
        resolve();
      });
      return;
    }
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

// ─── auth step (select → branch) ────────────────────────────────────────

// `pickSavedByPreviousRun`: the .env bridge promoted a pick persisted by a
// PREVIOUS run. That pick is a default to confirm, not a decision to replay:
// the operator may be rerunning precisely to change it. In-process presets
// (--template-path, the Advanced screen, self re-execs, an exported env var)
// keep the silent skip.
export async function runTemplateSetup(
  driver: SetupDriver,
  pickSavedByPreviousRun: boolean,
  hasRegisteredAgents: boolean,
): Promise<void> {
  const preset = process.env.NANOCLAW_TEMPLATE_PATH?.trim();
  if (preset) {
    if (listLocalTemplates(driver).some((template) => template.ref === preset)) {
      if (!pickSavedByPreviousRun) {
        applyTemplatePick(preset);
        driver.log('success', `Using template "${preset}".`);
        return;
      }
      const resume = await confirmPrompt(
        driver,
        'template-resume',
        `Continue with template "${preset}" from the previous run?`,
        true,
      );
      setupLog.userInput('template_resume', String(resume));
      if (resume) {
        applyTemplatePick(preset);
        driver.log('success', `Using template "${preset}".`);
        return;
      }
      clearTemplatePick();
      driver.log(
        'info',
        `If that run already stamped an agent from "${preset}", it is kept. Pick it again anytime, or wire it later with /init-first-agent.`,
      );
    } else {
      clearTemplatePick();
      driver.log('warn', `Template "${preset}" not found under ${TEMPLATES_DIR}. Pick one below.`);
      driver.log(
        'info',
        `If a previous run already stamped an agent from "${preset}", it is kept. Wire it later with /init-first-agent.`,
      );
    }
  }

  for (;;) {
    const source = await selectPrompt(driver, 'template-source', {
      message: hasRegisteredAgents
        ? 'Would you like to add or update an agent from a template?'
        : 'How should we create your first agent?',
      options: [
        hasRegisteredAgents
          ? { value: 'none', label: 'No template changes', hint: 'recommended' }
          : { value: 'none', label: 'Fresh agent', hint: 'recommended - shape it by chatting' },
        { value: 'library', label: 'From the NanoClaw template library', hint: 'prebuilt agents' },
        { value: 'local', label: 'From local templates', hint: 'templates/ in this install' },
      ],
      initialValue: 'none',
    });
    setupLog.userInput('template_source', source);
    if (source === 'none') return;

    const ref = source === 'library' ? await pickLibraryTemplate(driver) : await pickLocalTemplate(driver);
    if (!ref) continue;
    applyTemplatePick(ref);
    setupLog.userInput('template_ref', ref);
    driver.log('success', `Template "${ref}" selected.`);
    return;
  }
}

function listLocalTemplates(driver: SetupDriver): TemplateEntry[] {
  try {
    return listTemplatesFromDir(TEMPLATES_DIR);
  } catch (error) {
    driver.log('warn', error instanceof Error ? error.message : String(error));
    return [];
  }
}

async function pickLibraryTemplate(driver: SetupDriver): Promise<string | undefined> {
  const spinner = driver.mode === 'terminal' ? p.spinner() : null;
  if (spinner) spinner.start('Fetching the template library…');
  else driver.progress('template-source', 'running', 'Fetching the template library');
  let registry: ClonedRegistry;
  try {
    registry = cloneRegistry();
  } catch (error) {
    if (spinner) spinner.stop('Could not reach the template library.');
    else driver.progress('template-source', 'failed');
    const message = error instanceof Error ? error.message : String(error);
    setupLog.step('template-source', 'interactive', 0, { source: 'library', error: message });
    driver.log('warn', message);
    return undefined;
  }

  try {
    const templates = listTemplatesFromDir(registry.dir).filter((template) => template.ref !== '.');
    if (templates.length === 0) {
      if (spinner) spinner.stop('The template library is empty.');
      else driver.progress('template-source', 'succeeded', 'The template library is empty');
      return undefined;
    }
    if (spinner) spinner.stop(`Found ${templates.length} template${templates.length === 1 ? '' : 's'}.`);
    else
      driver.progress(
        'template-source',
        'succeeded',
        `Found ${templates.length} template${templates.length === 1 ? '' : 's'}`,
      );
    const ref = await chooseTemplate(driver, templates);
    if (!ref) return undefined;

    const destination = path.join(TEMPLATES_DIR, ref);
    if (fs.existsSync(destination)) {
      if (!listLocalTemplates(driver).some((template) => template.ref === ref)) {
        driver.log('warn', `Can't install "${ref}": that path already exists but is not a valid template.`);
        return undefined;
      }
      driver.log('info', `Keeping your existing local copy of "${ref}".`);
    } else {
      try {
        copyTemplate(registry.dir, ref, TEMPLATES_DIR);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setupLog.step('template-copy', 'interactive', 0, { ref, error: message });
        driver.log('warn', `Couldn't copy "${ref}" into templates/: ${message}`);
        return undefined;
      }
    }
    return ref;
  } finally {
    registry.cleanup();
  }
}

async function pickLocalTemplate(driver: SetupDriver): Promise<string | undefined> {
  const templates = listLocalTemplates(driver).filter((template) => template.ref !== '.');
  if (templates.length === 0) {
    driver.log('info', `No local templates in ${TEMPLATES_DIR}.`);
    return undefined;
  }
  return chooseTemplate(driver, templates);
}

const BACK_TO_TEMPLATE_SOURCE = '\0back';

async function chooseTemplate(driver: SetupDriver, templates: TemplateEntry[]): Promise<string | undefined> {
  const ref = await driver.prompt({
    id: 'template-choice',
    kind: 'singleChoice',
    message: 'Choose a template',
    choices: [
      ...templates.map((template) => ({
        id: template.ref,
        label: template.name,
        ...(template.ref.includes('/') ? { hint: template.ref } : {}),
      })),
      { id: BACK_TO_TEMPLATE_SOURCE, label: '← Back' },
    ],
    searchable: true,
    placeholder: 'type to search',
  });
  return ref === BACK_TO_TEMPLATE_SOURCE ? undefined : String(ref);
}

type TemplateAgentOutcome = 'none' | 'channel-target' | 'restamped';
type TemplateSetupOperation = TemplateOperation | { kind: 'connect'; agentGroupId: string };

export async function installSelectedTemplateAgent(
  driver: SetupDriver,
  provider?: string,
): Promise<TemplateAgentOutcome> {
  const ref = process.env.NANOCLAW_TEMPLATE_PATH?.trim();
  if (!ref) return 'none';
  if (process.env.NANOCLAW_TEMPLATE_AGENT_ID?.trim()) return 'channel-target';

  // Only an explicit operator name overrides the template: the CLI's own
  // fallback chain (--name → the manifest's agentName → the folder leaf) must
  // stay reachable through the wizard, or a template's agentName is dead.
  const presetName = process.env.NANOCLAW_AGENT_NAME?.trim() || undefined;
  const transport = new SocketTransport();
  const runNcl = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    const response = await transport.sendFrame(
      { id: randomUUID(), command, args },
      { signal: driver.cancellationSignal },
    );
    if (!response.ok) throw new Error(response.error.message);
    return response.data;
  };

  const start = Date.now();
  phEmit('step_started', { step: 'template-agent' });
  driver.progress('template-agent', 'running', `Preparing the "${ref}" template`);
  try {
    const agents = await listTemplateAgents(ref, runNcl);
    const operation = await chooseTemplateOperation(driver, ref, agents);
    if (!operation) {
      clearTemplatePick();
      setupLog.step('template-agent', 'success', Date.now() - start, { ref, cancelled: true });
      phEmit('step_completed', { step: 'template-agent', status: 'success' });
      driver.progress('template-agent', 'succeeded');
      driver.log('info', 'No template changes made.');
      return 'none';
    }

    if (operation.kind === 'connect') {
      const group = agents.find((agent) => agent.id === operation.agentGroupId);
      if (!group) throw new Error('Selected template agent no longer exists');
      clearTemplatePick();
      process.env.NANOCLAW_TEMPLATE_AGENT_ID = group.id;
      process.env.NANOCLAW_AGENT_NAME = group.name;
      setupLog.step('template-agent', 'success', Date.now() - start, {
        ref,
        agent_group_id: group.id,
        operation: 'connect',
      });
      phEmit('step_completed', { step: 'template-agent', status: 'success' });
      driver.progress('template-agent', 'succeeded');
      driver.log('success', `Ready to connect agent "${group.name}".`);
      return 'channel-target';
    }

    const name =
      operation.kind === 'create' && agents.length > 0
        ? await askNewTemplateAgentName(driver, agents, presetName)
        : presetName;

    driver.progress(
      'template-agent',
      'running',
      operation.kind === 'create' ? `Installing the "${ref}" template` : `Preparing the "${ref}" template update`,
    );
    const result = await installTemplateAgent({
      ref,
      operation,
      name,
      timezone: readEnvKey('TZ', PROJECT_ROOT) ?? undefined,
      provider,
      runNcl,
      confirmReplace: async (plan) => {
        const resets = plan.changes.filter((change) => change.action !== 'unchanged' && change.action !== 'skip');
        const customized = resets.filter((change) => change.customized).length;
        const replace = await confirmPrompt(
          driver,
          'template-replace',
          `Agent "${plan.group.name}" is already stamped from this template. Update it in place? ` +
            `${resets.length} plugin-owned surface${resets.length === 1 ? '' : 's'} will be reset` +
            (customized > 0 ? ` (${customized} with local edits that will be lost)` : '') +
            '. Provider, memory, chats, and wiring are kept.',
          customized === 0,
        );
        setupLog.userInput('template_replace', String(replace));
        return replace;
      },
    });

    if (result.status === 'cancelled') {
      clearTemplatePick();
      setupLog.step('template-agent', 'success', Date.now() - start, {
        ref,
        cancelled: true,
      });
      phEmit('step_completed', { step: 'template-agent', status: 'success' });
      driver.progress('template-agent', 'succeeded');
      driver.log('info', 'Template update cancelled. The agent was left unchanged.');
      return 'none';
    }

    setupLog.step('template-agent', 'success', Date.now() - start, {
      ref,
      agent_group_id: result.group.id,
    });
    phEmit('step_completed', { step: 'template-agent', status: 'success' });
    driver.progress('template-agent', 'succeeded');
    if (result.status === 'updated') {
      // Restamping preserves wiring, so it has no deferred channel work and
      // must not make the channel step consume this existing agent as "new".
      clearTemplatePick();
      driver.log('success', `Template agent "${result.group.name}" updated in place.`);
      return 'restamped';
    }

    // The id is intentionally one-run-only. A later setup derives unwired
    // agents from ncl and offers an explicit Connect action instead of silently
    // targeting whatever id a previous run left behind.
    clearTemplatePick();
    process.env.NANOCLAW_TEMPLATE_AGENT_ID = result.group.id;
    process.env.NANOCLAW_AGENT_NAME = result.group.name;
    driver.log('success', `Template agent "${result.group.name}" created.`);
    return 'channel-target';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setupLog.step('template-agent', 'failed', Date.now() - start, { ref, error: message });
    phEmit('step_completed', { step: 'template-agent', status: 'failed' });
    driver.progress('template-agent', 'failed');
    // Warn-and-continue (the ping-skip pattern): a template failure must not
    // abort an otherwise-working install. The pick stays in .env so a rerun
    // retries this template.
    driver.log('warn', `Couldn't install the "${ref}" template: ${message}`);
    driver.note(
      [
        wrapForGutter('Setup continues without it; you still get a fresh default agent. To retry the template:', 6),
        '',
        "  1. If the service isn't running:",
        `     macOS:  launchctl kickstart -k gui/$(id -u)/${getLaunchdLabel()}`,
        `     Linux:  systemctl --user restart ${getSystemdUnit()}`,
        '  2. Rerun: bash nanoclaw.sh',
      ].join('\n'),
      'Skipping the template',
    );
    return 'none';
  }
}

async function chooseTemplateOperation(
  driver: SetupDriver,
  ref: string,
  agents: readonly SetupTemplateAgent[],
): Promise<TemplateSetupOperation | undefined> {
  if (agents.length === 0) return { kind: 'create' };

  // Choice ids are `<kind>:<agentGroupId>` so the same wire shape serves the
  // terminal renderer and the machine protocol (which carries string ids only).
  const options = agents.flatMap((agent) => [
    ...(agent.isWired
      ? []
      : [
          {
            value: `connect:${agent.id}`,
            label: `Connect "${agent.name}" to a channel`,
            hint: `groups/${agent.folder} · not connected`,
          },
        ]),
    {
      value: `restamp:${agent.id}`,
      label: `Update "${agent.name}" in place`,
      hint: `groups/${agent.folder} · keeps provider, memory, chats, and wiring`,
    },
  ]);
  const choice = await selectPrompt(driver, 'template-operation', {
    message: `The "${ref}" template is already in use. What would you like to do?`,
    options: [...options, { value: 'create', label: 'Create another agent' }, { value: 'cancel', label: 'Cancel' }],
    initialValue: options[0].value,
  });
  setupLog.userInput('template_operation', choice);
  if (choice === 'cancel') return undefined;
  if (choice === 'create') return { kind: 'create' };
  const separator = choice.indexOf(':');
  const kind = choice.slice(0, separator);
  const agentGroupId = choice.slice(separator + 1);
  if (kind === 'connect') return { kind: 'connect', agentGroupId };
  if (kind === 'restamp') return { kind: 'restamp', agentGroupId };
  throw new Error(`Unknown template operation: ${choice}`);
}

async function askNewTemplateAgentName(
  driver: SetupDriver,
  agents: readonly AgentGroup[],
  initialValue?: string,
): Promise<string> {
  const preset = initialValue?.trim() || undefined;
  const answer = await textPrompt(driver, 'template-agent-name', {
    message: 'Name the new agent',
    placeholder: 'e.g. EMEA Sales',
    ...(preset ? { default: preset } : {}),
    // An empty answer accepts the default; anything typed must be unique.
    validateValue: (value) => validateNewTemplateAgentName(String(value).trim() || preset, agents),
  });
  const name = answer.trim() || preset || '';
  setupLog.userInput('template_agent_name', name);
  return name;
}

/**
 * Where the sandbox image comes from — build it here, or pull a pre-built one.
 *
 * Asked once, ahead of the container step, and persisted to `.env` *before* the
 * sign-in runs. Both resume paths (fail()'s retry re-exec and
 * maybeReexecUnderSg) rebuild NANOCLAW_SKIP from the steps that completed, and
 * the sign-in is deliberately not a step — so an answer that lived only in this
 * process would be gone by the time the resumed run reached here, and the
 * operator would be asked again after already signing in.
 *
 * Returns having done nothing when the question is already settled, which also
 * covers `NANOCLAW_HARDENED_IMAGE=true` passed in by a packaged flow.
 */
async function chooseImageSource(driver: SetupDriver): Promise<void> {
  if (imageSourceDecided()) return;

  // The runtime pick happens later (the auth step), so this is the best signal
  // available: an explicit preset, else the persisted install-wide default.
  // Getting it wrong in the permissive direction is caught at that pick.
  const plannedProvider = (
    process.env.NANOCLAW_AGENT_PROVIDER?.trim() ||
    DEFAULT_AGENT_PROVIDER ||
    'claude'
  ).toLowerCase();
  if (plannedProvider !== 'claude') {
    driver.log(
      'info',
      brandBody(
        `Building the sandbox here — the pre-built image is Claude-only, and ${plannedProvider} needs an image of its own.`,
      ),
    );
    return;
  }

  // Nothing to fetch unless this copy ships a pinned image reference. Offering
  // the choice anyway would take an account, a sign-in and a token from someone
  // whose install then has no image to pull — so don't ask a question whose
  // good answer cannot be honoured.
  if (!readAgentImagePin()) return;

  driver.log(
    'message',
    brandBody(
      dimWrap(
        "Your assistant's sandbox contains a browser and a language runtime — Chromium, Node, Bun and a handful of tools. Isolation keeps a misbehaving agent away from your machine, but it does nothing about known vulnerabilities in that software itself.",
        4,
      ),
    ),
  );
  driver.log(
    'message',
    brandBody(
      dimWrap(
        'Our partner Echo (echo.ai) rebuilds those components from scratch with only the essentials and patches what remains, which takes the known-vulnerability count from thousands to near zero. Building here instead gives you the same software, straight from its public base image.',
        4,
      ),
    ),
  );
  driver.log(
    'message',
    brandBody(
      dimWrap(
        'Fetching it means authenticating with NanoClaw: we record your email address and that you fetched an image, nothing else. Building sends nothing at all.',
        4,
      ),
    ),
  );

  const choice = await selectPrompt(driver, 'image-source', {
    message: "Where should your assistant's sandbox image come from?",
    options: [
      {
        value: 'hardened',
        label: 'Fetch the hardened image, built by Echo',
        hint: 'recommended - patched components; needs authentication',
      },
      {
        value: 'local',
        label: 'Build it here',
        hint: 'no account, nothing recorded; takes 3-10 min',
      },
    ],
    initialValue: 'hardened',
  });
  setupLog.userInput('image_source', choice);
  phEmit('image_source_chosen', { source: choice });

  writeImageSource(choice);
  if (choice === 'local') return;

  driver.log('step', brandBody('Authenticating with NanoClaw…'));
  const start = Date.now();
  const result = await runRegistryLoginWithDriver(driver);
  const durationMs = Date.now() - start;
  if (result.kind !== 'ready') {
    useLocalImageAfterRegistryLogin(
      driver,
      result.kind === 'skipped',
      result.kind === 'skipped' ? LOGIN_EXIT_SKIPPED : 1,
      durationMs,
      { REASON: result.reason },
    );
    return;
  }
  finishRegistryLogin(driver, durationMs, result.method);
}

function useLocalImageAfterRegistryLogin(
  driver: SetupDriver,
  skipped: boolean,
  exitCode: number,
  durationMs: number,
  fields: Record<string, string | number>,
): void {
  // A local build is a complete supported install, so a declined or failed
  // registry sign-in never strands setup.
  setupLog.step('registry-login', skipped ? 'skipped' : 'failed', durationMs, fields);
  phEmit('registry_login_declined', { exit_code: exitCode, skipped });
  writeImageSource('local');
  driver.log(
    'warn',
    brandBody(
      skipped
        ? 'Not authenticated - building the sandbox here instead.'
        : "Authentication didn't finish - building the sandbox here instead.",
    ),
  );
  driver.log('message', k.dim(`Re-run setup to try again, or check with \`${REGISTRY_STEP} -- --status\`.`));
}

function finishRegistryLogin(driver: SetupDriver, durationMs: number, method?: string): void {
  setupLog.step('registry-login', 'interactive', durationMs, method ? { METHOD: method } : {});
  driver.log('success', brandBody("Authenticated. Your assistant's sandbox will be fetched, not built."));
}

async function askAgentProviderChoice(driver: SetupDriver): Promise<string> {
  // On a pinned install every non-Claude runtime forces a local rebuild — the
  // image bakes /app/node_modules and the CLI manifest, and each changes one.
  // Say so on the option rather than only at the confirm two steps later, so
  // the cost is visible while the choice is still being made. Shown only when
  // this install pulls; on a local-build install it is not a trade-off.
  const pinned = readImageSource() === 'hardened';
  const note = (value: string, hint: string): string =>
    pinned && value !== 'claude' ? `${hint} — ⚠ not in the pre-built image; needs a local build` : hint;

  const options = listSetupProviderChoices().map(({ value, label, hint }) => ({
    value,
    label,
    hint: note(value, hint),
  }));
  const preset = process.env.NANOCLAW_AGENT_PROVIDER?.trim().toLowerCase();
  if (preset) {
    if (!options.some((option) => option.value === preset)) {
      throw new Error(`NANOCLAW_AGENT_PROVIDER=${preset} is not available in this NanoClaw install`);
    }
    setupLog.userInput('agent_provider', preset);
    phEmit('agent_provider_chosen', { provider: preset, preset: true });
    return preset;
  }
  // The pick is persisted as the instance default (DEFAULT_AGENT_PROVIDER), so
  // pre-select the current default — a re-run Enter-through then preserves it
  // instead of silently resetting it to claude. Fall back to claude if the
  // persisted default isn't an offered option (e.g. its provider was removed).
  const currentDefault = options.some((o) => o.value === DEFAULT_AGENT_PROVIDER) ? DEFAULT_AGENT_PROVIDER : 'claude';
  const choice = await selectPrompt(driver, 'agent-provider', {
    message: 'Which agent runtime should power your assistant?',
    options,
    initialValue: currentDefault,
  });
  setupLog.userInput('agent_provider', choice);
  phEmit('agent_provider_chosen', { provider: choice });
  return choice;
}

async function runAuthStep(driver: SetupDriver): Promise<void> {
  if (anthropicSecretExists()) {
    driver.log('success', brandBody('Your Claude account is already connected.'));
    setupLog.step('auth', 'skipped', 0, { REASON: 'secret-already-present' });
    return;
  }

  // Custom Anthropic-compatible endpoint flow. Both URL and token must be set;
  // OneCLI stores the token as a generic Bearer secret keyed to the URL host,
  // so the container only ever sees ANTHROPIC_BASE_URL + a placeholder.
  const customBaseUrl = process.env.NANOCLAW_ANTHROPIC_BASE_URL?.trim();
  const customAuthToken = process.env.NANOCLAW_ANTHROPIC_AUTH_TOKEN?.trim();
  if (customBaseUrl && customAuthToken) {
    registerSensitiveValue(customAuthToken);
    await runCustomEndpointAuth(driver, customBaseUrl, customAuthToken);
    return;
  }

  const method = await selectPrompt(driver, 'anthropic-auth-method', {
    message: 'How would you like to connect to Claude?',
    options: [
      {
        value: 'subscription',
        label: 'Sign in with my Claude subscription',
        hint: 'recommended if you have Pro or Max',
      },
      {
        value: 'oauth',
        label: 'Paste an OAuth token I already have',
        hint: 'sk-ant-oat…',
      },
      {
        value: 'api',
        label: 'Paste an Anthropic API key',
        hint: 'pay-per-use via console.anthropic.com',
      },
      {
        value: 'skip',
        label: "Skip - I'll connect later",
        hint: 'not recommended - Claude helps debug setup issues',
      },
    ],
  });
  setupLog.userInput('auth_method', method);
  phEmit('auth_method_chosen', { method });

  if (method === 'skip') {
    const confirmed = await confirmPrompt(
      driver,
      'anthropic-auth-skip-confirm',
      "Skip Claude sign-in? The agent won't be able to run until you connect, and we won't be able to help debug setup errors.",
      false,
    );
    if (!confirmed) {
      // Loop back to the auth picker so they can choose a real method.
      return runAuthStep(driver);
    }
    setupLog.step('auth', 'skipped', 0, { REASON: 'user-skipped' });
    driver.log('warn', brandBody('Claude sign-in skipped. Re-run setup or run `bash nanoclaw.sh` to finish later.'));
    return;
  }

  if (method === 'subscription') {
    await runSubscriptionAuth(driver);
  } else {
    await runPasteAuth(driver, method);
  }
}

async function runSubscriptionAuth(driver: SetupDriver): Promise<void> {
  driver.log('step', brandBody('Opening the Claude sign-in flow…'));
  if (driver.mode === 'ndjson') {
    const start = Date.now();
    const result = await runClaudeSubscriptionMachineAuth(driver);
    const durationMs = Date.now() - start;
    if (!result.ok) {
      setupLog.step('auth', 'failed', durationMs, {
        METHOD: 'subscription',
        ERROR: result.reason,
        ...(result.detail ? { DETAIL: result.detail } : {}),
      });
      await fail(
        'auth',
        "Couldn't complete the Claude sign-in.",
        result.reason === 'spawn_failed'
          ? 'Install the Claude CLI, then rerun setup or choose a paste option.'
          : 'Re-run setup and try again, or choose a paste option instead.',
        undefined,
        driver,
      );
    }
    setupLog.step('auth', 'interactive', durationMs, { METHOD: 'subscription' });
    driver.log('success', brandBody('Claude account connected.'));
    return;
  }
  if (driver.mode === 'terminal') {
    console.log(k.dim('   (a browser will open for sign-in; this part is interactive)'));
    console.log();
  }
  const start = Date.now();
  const code = await runInheritScript('bash', ['setup/register-claude-token.sh']);
  const durationMs = Date.now() - start;
  if (driver.mode === 'terminal') console.log();
  if (code !== 0) {
    setupLog.step('auth', 'failed', durationMs, {
      EXIT_CODE: code,
      METHOD: 'subscription',
    });
    await fail(
      'auth',
      "Couldn't complete the Claude sign-in.",
      'Re-run setup and try again, or choose a paste option instead.',
      undefined,
      driver,
    );
  }
  setupLog.step('auth', 'interactive', durationMs, { METHOD: 'subscription' });
  driver.log('success', brandBody('Claude account connected.'));
}

async function runPasteAuth(driver: SetupDriver, method: 'oauth' | 'api'): Promise<void> {
  const label = method === 'oauth' ? 'OAuth token' : 'API key';
  const prefix = method === 'oauth' ? 'sk-ant-oat' : 'sk-ant-api';

  const answer = await secretPrompt(driver, `anthropic-${method}-secret`, {
    message: `Paste your ${label}`,
    validateValue: (answerValue) => {
      const v = String(answerValue);
      // Strip any internal whitespace so a line-wrapped paste that did
      // survive into clack can still validate. The mid-token-newline
      // case where clack only sees the first line is caught by the
      // shape check below.
      const cleaned = (v ?? '').replace(/\s+/g, '');
      if (!cleaned) return 'Required';
      if (!cleaned.startsWith(prefix)) {
        return `Should start with ${prefix}…`;
      }
      if (method === 'oauth' && !/^sk-ant-oat[A-Za-z0-9_-]{80,500}AA$/.test(cleaned)) {
        return cleaned.length < 90
          ? 'Token looks truncated - line breaks in the paste can cut it off. Widen your terminal so the token fits on one line, then paste again.'
          : "Token shape doesn't look right (expected sk-ant-oat…AA).";
      }
      return undefined;
    },
  });
  const token = (answer as string).replace(/\s+/g, '');

  const run = (childArgs: string[]): Promise<Awaited<ReturnType<typeof runQuietChild>>> =>
    runQuietChild(
      'auth',
      'onecli',
      childArgs,
      {
        running: `Saving your ${label} to your OneCLI vault…`,
        done: 'Claude account connected.',
      },
      {
        extraFields: { METHOD: method },
        ...(driver.mode === 'ndjson' ? { env: childEnvWithoutSetupSecrets() } : {}),
      },
      driver,
    );
  const res = await withSecretFile(token, (filePath) =>
    run([
      'secrets',
      'create',
      '--name',
      'Anthropic',
      '--type',
      'anthropic',
      '--file',
      filePath,
      '--host-pattern',
      'api.anthropic.com',
    ]),
  );
  if (!res.ok) {
    await fail(
      'auth',
      `Couldn't save your ${label} to the vault.`,
      'Make sure OneCLI is running (`onecli version`), then retry.',
      undefined,
      driver,
    );
  }
}

/**
 * Set up Anthropic auth for a custom endpoint. The token is stored as a
 * OneCLI generic secret with header injection so the proxy rewrites the
 * Authorization header on the wire — the container only ever sees
 * ANTHROPIC_BASE_URL + a placeholder bearer.
 */
async function runCustomEndpointAuth(driver: SetupDriver, baseUrl: string, token: string): Promise<void> {
  let host: string;
  let canonicalBaseUrl: string;
  try {
    const invalid = validateHttpUrl(baseUrl);
    if (invalid) throw new Error(invalid);
    const parsed = new URL(baseUrl);
    host = parsed.hostname;
    canonicalBaseUrl = parsed.toString();
  } catch {
    await fail(
      'auth',
      `Invalid Anthropic base URL: ${baseUrl}`,
      'Check --anthropic-base-url and retry.',
      undefined,
      driver,
    );
    return;
  }

  const args = (filePath: string): string[] => [
    'secrets',
    'create',
    '--name',
    'Anthropic',
    '--type',
    'generic',
    '--file',
    filePath,
    '--host-pattern',
    host,
    '--header-name',
    'Authorization',
    '--value-format',
    'Bearer {value}',
  ];
  const run = (childArgs: string[]): Promise<Awaited<ReturnType<typeof runQuietChild>>> =>
    runQuietChild(
      'auth',
      'onecli',
      childArgs,
      {
        running: `Saving your Anthropic auth token to your OneCLI vault…`,
        done: 'Claude account connected.',
      },
      {
        extraFields: { METHOD: 'custom-endpoint', HOST: host },
        ...(driver.mode === 'ndjson' ? { env: childEnvWithoutSetupSecrets() } : {}),
      },
      driver,
    );
  const res = await withSecretFile(token, (filePath) => run(args(filePath)));
  if (!res.ok) {
    await fail(
      'auth',
      `Couldn't save your Anthropic auth token to the vault.`,
      'Make sure OneCLI is running (`onecli version`), then retry.',
      undefined,
      driver,
    );
  }

  // ANTHROPIC_BASE_URL has to be in .env so the runtime provider config
  // reads it when building container env. The token is *not* written —
  // OneCLI holds it.
  writeEnvLine('ANTHROPIC_BASE_URL', canonicalBaseUrl);

  // Register the claude provider so the runtime passes ANTHROPIC_BASE_URL
  // and the placeholder bearer into the container. Only appended when the
  // user has configured a custom endpoint; standard installs don't load
  // the file at all.
  appendProviderImport('./claude.js');
}

function writeEnvLine(key: string, value: string): void {
  const envFile = path.join(PROJECT_ROOT, '.env');
  const content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content.trimEnd() + (content ? '\n' : '') + `${key}=${value}\n`;
  fs.writeFileSync(envFile, next);
}

function appendProviderImport(modulePath: string): void {
  const file = path.join(PROJECT_ROOT, 'src', 'providers', 'index.ts');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const line = `import '${modulePath}';`;
  if (content.includes(line)) return;
  const sep = content && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, content + sep + line + '\n');
}

// ─── timezone step ─────────────────────────────────────────────────────

/**
 * Auto-detect TZ, confirm with the user when it comes back as UTC (a
 * common sign we're on a VPS that wasn't localised), and persist through
 * the usual `--step timezone -- --tz <zone>` path. Free-text answers get
 * a headless `claude -p` pass to resolve them to a real IANA zone.
 */
async function runTimezoneStep(driver: SetupDriver): Promise<void> {
  const res = await runQuietStep(
    'timezone',
    {
      running: 'Checking your timezone…',
      done: 'Timezone set.',
    },
    [],
    driver,
  );
  if (!res.ok && res.terminal?.fields.NEEDS_USER_INPUT !== 'true') {
    await fail('timezone', "Couldn't determine your timezone.", undefined, undefined, driver);
  }

  const fields = res.terminal?.fields ?? {};
  const resolvedTz = fields.RESOLVED_TZ;
  const needsInput = fields.NEEDS_USER_INPUT === 'true';
  const isUtc = resolvedTz === 'UTC' || resolvedTz === 'Etc/UTC' || resolvedTz === 'Universal';

  // Three branches:
  //   - no TZ detected: ask where they are (or leave as UTC)
  //   - detected UTC: confirm (likely VPS, but worth checking)
  //   - detected specific zone: confirm explicitly rather than silently
  //     persisting — users shouldn't be surprised the agent "already knew"
  //     their timezone from system settings they didn't think about.
  if (!needsInput && !isUtc && resolvedTz && resolvedTz !== 'none') {
    const confirmed = await confirmPrompt(
      driver,
      'timezone-detected-confirm',
      `I detected ${resolvedTz} from your computer settings. Is that right?`,
      true,
    );
    setupLog.userInput('timezone_confirm_detected', String(confirmed));
    if (confirmed) return;
  }

  const message = needsInput
    ? "Your system didn't expose a timezone. Which one are you in?"
    : !isUtc
      ? 'Where are you, then?'
      : 'Your system reports UTC as the timezone. Is that right, or are you somewhere else?';

  // For the non-UTC "detected-but-wrong" branch we skip the select and jump
  // straight to the free-text prompt — the user already said "not that".
  let choice: 'keep' | 'answer' = 'answer';
  if (needsInput || isUtc) {
    choice = await selectPrompt(driver, 'timezone-choice', {
      message,
      options: needsInput
        ? [
            { value: 'answer', label: "I'll tell you where I am" },
            { value: 'keep', label: 'Leave it as UTC' },
          ]
        : [
            { value: 'keep', label: 'Keep UTC', hint: 'remote server / happy with UTC' },
            { value: 'answer', label: "I'm somewhere else" },
          ],
    });
    setupLog.userInput('timezone_choice', choice);
  }

  if (choice === 'keep') return;

  const answer = await textPrompt(driver, 'timezone-location', {
    message: 'Where are you? (city, region, or IANA zone)',
    placeholder: 'e.g. New York, London, Asia/Tokyo',
    validation: { required: true },
    validateValue: (value) => (String(value).trim() ? undefined : 'Required'),
  });
  const raw = (answer as string).trim();
  setupLog.userInput('timezone_input', raw);

  let tz: string | null = isValidTimezone(raw) ? raw : null;
  if (!tz) {
    if (claudeCliAvailable(driver)) {
      tz = await resolveTimezoneViaClaude(raw, driver);
    } else {
      driver.log(
        'warn',
        brandBody(
          wrapForGutter(
            "That's not a standard IANA zone and I can't call Claude to interpret it here — try again with a zone like `America/New_York` or `Europe/London`.",
            4,
          ),
        ),
      );
    }
  }

  if (!tz) {
    // One retry with a direct-IANA ask; if that fails too, leave the
    // previously-detected value in .env and move on rather than looping.
    const retryAnswer = await textPrompt(driver, 'timezone-iana', {
      message: 'Enter an IANA timezone string',
      placeholder: 'e.g. America/New_York',
      validation: { required: true },
      validateValue: (value) => {
        const s = String(value).trim();
        if (!s) return 'Required';
        if (!isValidTimezone(s)) return 'Not a valid IANA zone';
        return undefined;
      },
    });
    tz = (retryAnswer as string).trim();
    setupLog.userInput('timezone_retry', tz);
  }

  const persist = await runQuietStep(
    'timezone',
    {
      running: `Saving timezone ${tz}…`,
      done: `Timezone set to ${tz}.`,
    },
    ['--tz', tz],
    driver,
  );
  if (!persist.ok) {
    await fail('timezone', `Couldn't save timezone ${tz}.`, undefined, undefined, driver);
  }
}

// ─── prompts owned by the sequencer ────────────────────────────────────

async function askDisplayName(driver: SetupDriver, fallback: string): Promise<string> {
  const answer = await textPrompt(driver, 'display-name', {
    message: `What should your assistant call ${accentGreen('you')}?`,
    placeholder: fallback,
    default: fallback,
  });
  const value = (answer as string).trim() || fallback;
  setupLog.userInput('display_name', value);
  return value;
}

async function askChannelChoice(driver: SetupDriver): Promise<ChannelChoice> {
  const choice = await selectPrompt(driver, 'channel-choice', {
    message: 'Want to chat with your assistant from your phone?',
    options: [
      { value: 'slack', label: 'Yes, connect Slack', hint: 'NEW!! one-click install' },
      { value: 'teams', label: 'Yes, connect Microsoft Teams' },
      { value: 'telegram', label: 'Yes, connect Telegram' },
      { value: 'discord', label: 'Yes, connect Discord' },
      { value: 'whatsapp', label: 'Yes, connect WhatsApp', hint: 'best with a dedicated number' },
      {
        value: 'dial',
        label: 'Yes, connect Dial',
        hint: 'a dedicated phone number for your agent — place calls, SMS — worldwide',
      },
      {
        value: 'signal',
        label: 'Yes, connect Signal',
        hint: 'needs signal-cli installed',
      },
      {
        value: 'imessage',
        label: 'Yes, connect iMessage',
        hint: 'local Mac or hosted iMessage (via photon.codes)',
      },
      { value: 'other', label: 'Other…', hint: 'install via /add-<name> after setup' },
      { value: 'skip', label: 'Skip for now', hint: "I'll just use the terminal" },
    ],
  });
  setupLog.userInput('channel_choice', String(choice));
  phEmit('channel_chosen', { channel: String(choice) });
  return choice;
}

async function askOtherChannelName(driver: SetupDriver): Promise<void | typeof BACK_TO_CHANNEL_SELECTION> {
  if (driver.mode === 'terminal') {
    const action = await selectPrompt(driver, 'other-channel-action', {
      message: 'Which channel would you like to install?',
      options: [
        {
          value: 'type',
          label: 'Type the channel name',
          hint: 'e.g. matrix, github, linear, webex',
        },
        { value: 'back', label: '← Back to channel selection' },
      ],
      initialValue: 'type',
    });
    if (action === 'back') return BACK_TO_CHANNEL_SELECTION;
  }

  const answer = await textPrompt(driver, 'other-channel-name', {
    message: 'Channel name',
    placeholder: 'e.g. matrix, github, linear, webex',
  });
  const name = (answer as string)
    .trim()
    .toLowerCase()
    .replace(/^\/?(add-)?/, '');
  setupLog.userInput('other_channel', name);
  phEmit('channel_other_named', { channel: name });
  driver.log(
    'info',
    brandBody(
      wrapForGutter(
        `No bash installer for ${k.bold(name)} — open Claude Code after setup and run ${k.bold(`/add-${name}`)} to install it.`,
        4,
      ),
    ),
  );
}

// ─── interactive / env helpers ─────────────────────────────────────────

type ContainerRuntimeStatus = 'ready' | 'missing' | 'stopped' | 'permission' | 'other';

function containerRuntimeStatus(): ContainerRuntimeStatus {
  const result = spawnSync('docker', ['info'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
  if (result.status === 0) return 'ready';
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  if (/permission denied/i.test(output)) return 'permission';
  if (/cannot connect|is the docker daemon running|no such file/i.test(output)) return 'stopped';
  return 'other';
}

async function waitForContainerRuntime(): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (containerRuntimeStatus() === 'ready') return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

async function ensureMachineContainerRuntime(driver: SetupDriver): Promise<void> {
  if (driver.mode !== 'ndjson') return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = containerRuntimeStatus();
    if (status === 'ready') return;
    if (status === 'missing') {
      driver.error('container_runtime_required', 'Docker must be installed before setup can continue.', [
        {
          kind: 'manual',
          title: 'Install Docker',
          instructions: ['Install Docker Desktop on macOS or Docker Engine on Linux, then rerun setup.'],
        },
      ]);
    }
    if (status === 'stopped') {
      const action =
        process.platform === 'darwin'
          ? {
              id: 'start-docker',
              kind: 'startApplication' as const,
              title: 'Start Docker Desktop',
              application: 'Docker',
            }
          : null;
      if (!action)
        driver.error('container_runtime_not_started', 'Docker must be running before setup can continue.', [
          {
            kind: 'manual',
            title: 'Start Docker',
            instructions: ['Start the Docker service in a terminal, then rerun setup.'],
          },
        ]);
      const result = await driver.externalAction(action, waitForContainerRuntime);
      if (result === 'attempted') continue;
      driver.error('container_runtime_not_started', 'Docker must be running before setup can continue.', [
        { kind: 'manual', title: 'Start Docker', instructions: ['Start Docker Desktop, then rerun setup.'] },
      ]);
    }
    if (status === 'permission') {
      const user = process.env.USER?.trim();
      const groups = user
        ? (spawnSync('id', ['-nG', user], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).stdout ?? '')
        : '';
      if (groups.split(/\s+/).includes('docker')) maybeReexecUnderSg(driver);
      driver.error('container_runtime_permission', 'This login session cannot access Docker yet.', [
        {
          kind: 'manual',
          title: 'Refresh Docker group membership',
          instructions: ['Add your user to the docker group if needed.', 'Log out and back in, then rerun setup.'],
        },
      ]);
    }
    driver.error('container_runtime_unavailable', 'Docker is installed but its status could not be verified.', [
      {
        kind: 'manual',
        title: 'Check Docker',
        instructions: ['Run docker info in a terminal, fix the reported problem, then rerun setup.'],
      },
    ]);
  }
  driver.error('container_runtime_unavailable', 'Docker did not become ready.');
}

async function ensureMachineServicePermissions(driver: SetupDriver): Promise<void> {
  if (driver.mode !== 'ndjson' || process.platform !== 'linux' || process.getuid?.() === 0) return;
  if (spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }).status !== 0) return;
  if (containerRuntimeStatus() !== 'ready') return;
  const probe = (): boolean =>
    spawnSync('systemd-run', ['--user', '--pipe', '--wait', 'docker', 'info'], { stdio: 'ignore' }).status === 0;
  if (probe() || spawnSync('which', ['setfacl'], { stdio: 'ignore' }).status !== 0) return;
  const user = process.env.USER?.trim();
  if (!user) driver.error('service_permission_unknown_user', 'Could not determine the user for Docker socket access.');
  driver.error('service_permission_required', 'The service cannot access Docker in machine mode.', [
    {
      kind: 'manual',
      title: 'Grant Docker socket access',
      instructions: [`Run setfacl for ${user} in a terminal, then rerun setup.`],
    },
  ]);
}

async function rebuildProviderImage(driver: SetupDriver): Promise<ReturnType<typeof buildContainerImage>> {
  const result = await runQuietChild(
    'provider-image-build',
    path.join(PROJECT_ROOT, 'container', 'build.sh'),
    [],
    { running: 'Rebuilding the sandbox image…', done: 'Sandbox image rebuilt.' },
    undefined,
    driver,
  );
  return result.ok
    ? { ok: true }
    : {
        ok: false,
        message: `The container image build failed (exit ${result.exitCode}).`,
        hint: `Inspect ${result.rawLog}, fix Docker or the build input, then retry.`,
      };
}

function ensureLocalBinOnPath(): void {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const current = process.env.PATH ?? '';
  const segments = current.split(path.delimiter).filter(Boolean);
  if (segments.includes(localBin)) return;
  process.env.PATH = current ? `${localBin}${path.delimiter}${current}` : localBin;
}

function anthropicSecretExists(): boolean {
  try {
    const res = spawnSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return false;
    return /anthropic/i.test(res.stdout ?? '');
  } catch {
    return false;
  }
}

/**
 * Probe the host for a working OneCLI install so we can offer to reuse it
 * instead of re-running the installer (which rebinds the listener and breaks
 * any other app already using that gateway).
 */
function detectExistingOnecli(): { version: string; apiHost: string } | null {
  try {
    const ver = spawnSync('onecli', ['version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (ver.status !== 0) return null;
    const version = (ver.stdout ?? '').trim();
    if (!version) return null;

    const host = spawnSync('onecli', ['config', 'get', 'api-host'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (host.status !== 0) return null;
    const raw = (host.stdout ?? '').trim();
    if (!raw) return null;

    // onecli 1.3+ emits JSON by default. Older versions would print raw text.
    try {
      const parsed = JSON.parse(raw) as { data?: unknown; value?: unknown };
      const val = parsed.data ?? parsed.value;
      if (typeof val === 'string' && val.trim()) {
        return { version, apiHost: val.trim() };
      }
    } catch {
      // not JSON — try to extract a URL directly
    }
    const m = raw.match(/https?:\/\/[\w.-]+(?::\d+)?/);
    return m ? { version, apiHost: m[0] } : null;
  } catch {
    return null;
  }
}

/**
 * After installing Docker, this process's supplementary groups are still
 * frozen from login — subsequent steps that talk to /var/run/docker.sock
 * (onecli install, service start, …) fail with EACCES even though the
 * daemon is up. Detect that and re-exec the whole driver under `sg docker`
 * so the rest of the run inherits the docker group without a re-login.
 */
function maybeReexecUnderSg(driver: SetupDriver): void {
  if (process.env.NANOCLAW_REEXEC_SG === '1') return;
  if (process.platform !== 'linux') return;
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (info.status === 0) return;
  const err = `${info.stderr ?? ''}\n${info.stdout ?? ''}`;
  if (!/permission denied/i.test(err)) return;
  if (spawnSync('which', ['sg'], { stdio: 'ignore' }).status !== 0) return;

  driver.log('warn', brandBody('Docker socket not accessible in current group. Re-executing under `sg docker`.'));
  const existingSkip = (process.env.NANOCLAW_SKIP ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const skipList = [...new Set([...existingSkip, ...setupLog.completedStepNames()])].join(',');
  if (driver.mode === 'ndjson') driver.handoff();
  const command = driver.mode === 'ndjson' ? 'exec ./node_modules/.bin/tsx setup/auto.ts' : 'pnpm run setup:auto';
  const res = spawnSync('sg', ['docker', '-c', command], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NANOCLAW_REEXEC_SG: '1',
      ...(driver.mode === 'ndjson' ? { NANOCLAW_DRIVER_CONTINUATION: '1' } : {}),
      ...(skipList ? { NANOCLAW_SKIP: skipList } : {}),
    },
  });
  process.exit(res.status ?? 1);
}

// ─── intro + progression-log init ──────────────────────────────────────

function printIntro(driver: SetupDriver): void {
  const isReexec = process.env.NANOCLAW_REEXEC_SG === '1';
  const wordmark = `${k.bold('Nano')}${brandBold('Claw')}`;

  if (isReexec) {
    driver.intro(`${brandChip(' Welcome ')}  ${wordmark}  ${k.dim('· picking up where we left off')}`);
    return;
  }

  // bash already printed the wordmark above us; the clack intro carries the
  // welcome framing alone so the two don't double up. Standalone runs of
  // setup:auto still see this as the first line — fine without the wordmark
  // since the line itself signals the start of the flow.
  driver.intro("Let's get you set up.");
}

/**
 * Bootstrap (nanoclaw.sh) normally initializes logs/setup.log and writes
 * the bootstrap entry before we even boot. If someone runs `pnpm run
 * setup:auto` directly, start a fresh progression log here so we don't
 * append to a stale one from a previous run.
 */
function initProgressionLog(): void {
  if (process.env.NANOCLAW_BOOTSTRAPPED === '1') return;
  let commit = '';
  try {
    commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // git not available or not a repo — skip
  }
  let branch = '';
  try {
    branch = spawnSync('git', ['branch', '--show-current'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // skip
  }
  setupLog.reset({
    invocation: 'setup:auto (standalone)',
    user: process.env.USER ?? 'unknown',
    cwd: PROJECT_ROOT,
    branch: branch || 'unknown',
    commit: commit || 'unknown',
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const rootDriver = createSetupDriver(
    process.argv.includes('--uninstall') || process.env.NANOCLAW_OPERATION === 'uninstall' ? 'uninstall' : 'setup',
  );

  main(rootDriver).catch((err) => {
    if (err instanceof DriverCancelled) {
      rootDriver.cancelled();
      process.exitCode = rootDriver.mode === 'ndjson' ? 2 : 0;
      return;
    }
    if (err instanceof DriverTerminalError) {
      process.exitCode = err.exitCode;
      return;
    }
    if (rootDriver.mode === 'ndjson') {
      try {
        rootDriver.error('unexpected_error', err instanceof Error ? err.message : String(err), [
          {
            kind: 'rerun',
            args:
              rootDriver.operation === 'uninstall'
                ? ['--uninstall', '--protocol', 'nanoclaw.driver.v1']
                : ['--protocol', 'nanoclaw.driver.v1'],
          },
        ]);
      } catch {
        process.exitCode = 1;
      }
      return;
    }
    p.log.error(err instanceof Error ? err.message : String(err));
    p.cancel('Setup aborted.');
    process.exitCode = 1;
  });
}
