/**
 * Step: registry — inspect and manage the pulled-image path after setup.
 *
 *   --status           what this install pulls, and who it is to the registry
 *   --refresh          re-acquire the pinned reference and reconcile
 *   --opt-out          go back to locally built images
 *   --logout           revoke the session and remove the local credential + helper
 *   --non-interactive  emit only the status block, no prose
 *
 * **This step never prompts, and that is a hard constraint rather than a
 * stylistic one.** It is reachable both under `runWindowedStep` (stdin
 * discarded — `setup/lib/runner.ts` spawns with `stdio:['ignore','pipe','pipe']`)
 * and, through the container step it sits alongside, under the Linux
 * `sg docker` re-exec, which has a real TTY. A prompt would work in one and
 * hang forever in the other. `--non-interactive` therefore does not turn
 * prompting off — nothing to turn off — it turns the human prose off for
 * callers that only want the status block.
 *
 * Signing in is deliberately NOT here: it needs a TTY and up to 15 minutes of
 * device-flow wait, so it lives in `setup/registry-login.sh` and runs through
 * `runInheritScript` from `setup/auto.ts`.
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { log } from '../src/log.js';
import { credentialHelperStatus, uninstallCredentialHelper } from './install-cred-helper.js';
import {
  AGENT_IMAGE_PIN,
  AGENT_IMAGE_REF_ENV_KEY,
  HARDENED_IMAGE_ENV_KEY,
  clearRegistryAccount,
  inspectAgentImage,
  readAgentImageDigest,
  readAgentImagePin,
  readBrokerUrl,
  readImageSource,
  readRegistryAccount,
  readRegistryHost,
  unsupportedPlatformPin,
  writeImageSource,
  type RegistryAccount,
} from './lib/registry-state.js';
import { emitStatus } from './status.js';

type Mode = 'status' | 'refresh' | 'opt-out' | 'logout';

const MODE_FLAGS: Record<string, Mode> = {
  '--status': 'status',
  '--refresh': 'refresh',
  '--opt-out': 'opt-out',
  '--logout': 'logout',
};

// One line: the step's own failures are rendered through setup/index.ts's
// catch, which puts the message in an ERROR field of a line-oriented block.
const USAGE =
  'Usage: --step registry -- [--status | --refresh | --opt-out | --logout] [--non-interactive]';

/**
 * The block name has to be `stepName.toUpperCase()`: on a thrown error
 * `setup/index.ts` emits a failure block under that name without loading this
 * module, and a consumer matching on two different names would miss one of the
 * two. ("registry" has no hyphen, so the transform is a no-op here — unlike
 * `registry-reconcile`, whose crash block reads REGISTRY-RECONCILE while its
 * own reads REGISTRY_RECONCILE.)
 */
const BLOCK = 'REGISTRY';

function parseArgs(args: string[]): { mode: Mode; quiet: boolean } {
  let mode: Mode | undefined;
  let quiet = false;
  for (const arg of args) {
    if (arg === '--non-interactive') {
      quiet = true;
      continue;
    }
    const flagged = MODE_FLAGS[arg];
    if (!flagged) {
      throw new Error(`Unknown flag: ${arg}. ${USAGE}`);
    }
    if (mode && mode !== flagged) {
      throw new Error(`Pick one action, not both ${mode} and ${flagged}. ${USAGE}`);
    }
    mode = flagged;
  }
  return { mode: mode ?? 'status', quiet };
}

export async function run(args: string[]): Promise<void> {
  const { mode, quiet } = parseArgs(args);
  const say = (line = ''): void => {
    if (!quiet) console.log(line);
  };

  switch (mode) {
    case 'refresh':
      return refresh(say);
    case 'opt-out':
      return optOut(say);
    case 'logout':
      return logout(say);
    default:
      return status(say);
  }
}

// ─── status ────────────────────────────────────────────────────────────

async function status(say: (line?: string) => void): Promise<void> {
  const source = readImageSource();
  const pin = readAgentImagePin();
  // A per-platform pin that names other architectures is not "no pin" — saying
  // so would send someone to add a pin they already have.
  const wrongPlatform = pin ? undefined : unsupportedPlatformPin();
  const pinnedDigest = readAgentImageDigest();
  const image = inspectAgentImage();
  const account = readRegistryAccount();
  const helper = credentialHelperStatus();

  // `unknown` covers three different states — unpinned, not a digest ref, and
  // docker unreachable — and none of them is a mismatch. Only claim drift when
  // both sides answered.
  const pinMatch =
    !pinnedDigest || !image.registryDigest
      ? 'unknown'
      : String(pinnedDigest === image.registryDigest);

  const row = (label: string, value: string): void => say(`${(label + ':').padEnd(18)}${value}`);
  row('Image source', source === 'hardened' ? 'pull a pinned image' : 'build here');
  row('On this machine', `${image.source}  (${image.ref})`);
  if (pin) row('Pinned', pin);
  row('Signed in as', account ? accountLabel(account) : 'not signed in');
  if (account?.entitlements?.length) row('Perks', account.entitlements.join(', '));
  row('Docker helper', helperLabel(helper));

  // This step reports; it cannot sign anyone in (it must never prompt, because it
  // is reachable from runners with no stdin). So say what to run instead —
  // otherwise the honest "not signed in" above is a dead end.
  if (!account) {
    say('');
    say('Not signed in. To use the pinned image:');
    say('  bash setup/registry-login.sh                 sign in (opens your browser)');
    say('  bash setup/registry-login.sh --code <code>   or redeem an enrollment code');
    if (!pin && !wrongPlatform) {
      say('');
      say('This copy also has no agent-image pin in versions.json, so there is');
      say('nothing for it to fetch — ./container/build.sh is the only path here.');
    }
  } else if (source !== 'hardened') {
    // Signed in but still set to build locally: the container step would build
    // and never touch the registry, which reads as "the pull silently did not
    // happen". Worth naming rather than leaving the two rows to contradict
    // each other.
    say('');
    say('Signed in, but this install is still set to build its own image.');
    say('  bash setup/registry-login.sh --force       re-run sign-in, which sets the pinned path');
    say('  ... or set NANOCLAW_HARDENED_IMAGE=true in .env');
  } else if (!helper.installed) {
    say('');
    say('Signed in, but docker has no credential helper — re-run');
    say('  bash setup/registry-login.sh --force');
  }

  if (pinMatch === 'false') {
    say('');
    say('The image behind the local tag is not the pinned one — run --refresh.');
  }

  if (wrongPlatform) {
    say('');
    say(`The agent-image pin has no reference for ${wrongPlatform.platform}.`);
    say(`  it pins: ${wrongPlatform.available.join(', ')}`);
    say('Build locally with ./container/build.sh build, or set');
    say(`${AGENT_IMAGE_REF_ENV_KEY} to a reference for this architecture.`);
  } else if (source === 'hardened' && !pin) {
    say('');
    say('This install is set to pull, but nothing says which image.');
    say(`Set ${AGENT_IMAGE_REF_ENV_KEY} in .env, or add an "${AGENT_IMAGE_PIN}" pin to versions.json.`);
  }

  // The pin names the host docker authenticates against, so it is the only host
  // whose wiring matters. Wired-to-something-else and wired-but-uninstalled both
  // surface at pull time as a bare failure with no mention of a helper.
  const pinnedHost = readRegistryHost();
  if (source === 'hardened' && pinnedHost && !(helper.installed && helper.wiredHosts.includes(pinnedHost))) {
    say('');
    say(`Nothing supplies docker with credentials for ${pinnedHost} — a pull will not be authenticated.`);
  }

  emitStatus(BLOCK, {
    MODE: 'status',
    IMAGE_SOURCE: source,
    IMAGE_SOURCE_ACTUAL: image.source,
    IMAGE_REF: pin ?? '',
    IMAGE_PIN_DIGEST: pinnedDigest ?? '',
    IMAGE_DIGEST: image.registryDigest ?? '',
    PIN_MATCH: pinMatch,
    REGISTRY_HOST: pinnedHost ?? '',
    ACCOUNT: accountLabel(account),
    ACCOUNT_ID: account?.account_id ?? '',
    CRED_HELPER: helper.installed,
    CRED_HELPER_HOSTS: helper.wiredHosts.join(','),
    BROKER: readBrokerUrl(account),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

/** Never the token, and never an empty string that reads as a missing field. */
function accountLabel(account: RegistryAccount | undefined): string {
  if (!account) return 'none';
  return account.email ?? account.account_id ?? 'signed-in';
}

/**
 * Installed and wired are independent, and the pair that reads as fine but is
 * not — a `credHelpers` key naming a binary that is gone — deserves its own
 * sentence rather than being flattened into a host list.
 */
function helperLabel(helper: { installed: boolean; wiredHosts: string[] }): string {
  const hosts = helper.wiredHosts.join(', ');
  if (helper.installed) return hosts || 'installed, wired to nothing';
  return hosts ? `${hosts} — but the helper binary is missing` : 'not installed';
}

// ─── refresh ───────────────────────────────────────────────────────────

/**
 * Re-acquire the pinned reference. A no-op when those exact bytes are already
 * here — `container/pull.sh` guards on `docker image inspect` — so this moves
 * an install onto a digest that changed under it, rather than re-downloading
 * the one it already runs.
 */
async function refresh(say: (line?: string) => void): Promise<void> {
  const source = readImageSource();
  if (source !== 'hardened') {
    // Refusing rather than pulling anyway: on a local-build install the bytes
    // under the slug tag are ones this machine made, and a retag would replace
    // them with somebody else's under the same name.
    say(`This install builds its agent image here (${HARDENED_IMAGE_ENV_KEY} is not true).`);
    say('Re-run setup to switch, or `./container/build.sh pull` to fetch once without switching.');
    emitStatus(BLOCK, {
      MODE: 'refresh',
      IMAGE_SOURCE: source,
      STATUS: 'failed',
      ERROR: 'not_hardened',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const before = inspectAgentImage(projectRoot).registryDigest ?? '';
  const pull = spawnSync('bash', [path.join(projectRoot, 'container', 'pull.sh')], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (pull.status !== 0) {
    // pull.sh exits 2 when nothing is configured to acquire; everything else is
    // a real failure. Never fall back to a local build — that would replace the
    // pinned bytes under the same tag and report success.
    const errorCode = pull.status === 2 ? 'image_ref_not_configured' : 'image_pull_failed';
    log.error('Agent image refresh failed', { exitCode: pull.status, errorCode });
    emitStatus(BLOCK, {
      MODE: 'refresh',
      IMAGE_SOURCE: source,
      IMAGE_REF: readAgentImagePin() ?? '',
      IMAGE_DIGEST: before,
      STATUS: 'failed',
      ERROR: errorCode,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const after = inspectAgentImage(projectRoot).registryDigest ?? '';

  // Same reasoning as the container step: retagging the slug tag does nothing
  // for a group pinned to its own derived image, so the reconcile is part of
  // acquiring the image rather than a follow-up someone might not run. Imported
  // lazily so `--status` and `--logout` never load the DB layer.
  let cleared = 0;
  let removed = 0;
  let foreign = 0;
  try {
    const { reconcileDerivedImages } = await import('./registry-reconcile.js');
    const result = reconcileDerivedImages();
    cleared = result.cleared.length;
    removed = result.removed.length;
    foreign = result.foreign.length;
  } catch (err) {
    // Loud, not fatal: the image is here and tagged. What is left is groups
    // still spawning pre-hardened derived images, which `--step
    // registry-reconcile` exists to fix by hand.
    log.error('Could not reconcile derived agent-group images', { err });
  }

  say();
  say(after && after !== before ? `Now running ${after}.` : 'Already up to date.');
  if (cleared > 0) {
    say(`Cleared ${cleared} agent-group image pin(s) so they run the refreshed image.`);
  }

  emitStatus(BLOCK, {
    MODE: 'refresh',
    IMAGE_SOURCE: source,
    IMAGE_REF: readAgentImagePin() ?? '',
    IMAGE_DIGEST: after,
    CHANGED: String(after !== before),
    CLEARED: cleared,
    IMAGES_REMOVED: removed,
    FOREIGN_PINS: foreign,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

// ─── opt-out ───────────────────────────────────────────────────────────

/**
 * Back to locally built images. Only the setting changes: the bytes already
 * under the slug tag keep running until the next `./container/build.sh`, which
 * is what makes this safe to run at any time.
 */
async function optOut(say: (line?: string) => void): Promise<void> {
  const before = readImageSource();
  writeImageSource('local');
  log.info('Agent image source set to local', { before });

  if (before === 'hardened') {
    say('This install now builds its own agent image.');
    say('The pulled image keeps running until you rebuild: ./container/build.sh');
    if (readRegistryAccount()) {
      say('Your account credential is untouched — remove it with --logout.');
    }
  } else {
    say('Already building locally. Nothing changed.');
  }

  emitStatus(BLOCK, {
    MODE: 'opt-out',
    IMAGE_SOURCE: 'local',
    CHANGED: String(before === 'hardened'),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

// ─── logout ────────────────────────────────────────────────────────────

/**
 * Revoke server-side, then remove the local credential and the docker pointer.
 *
 * The local half runs even when the revoke fails. A token we cannot revoke is a
 * record on somebody's server; the same token sitting 0600 on this disk is a
 * local oracle any process running as this user can call. Removing it is the
 * part the operator actually asked for, so a broker that is down must not block
 * it — but the failure is reported rather than swallowed.
 */
async function logout(say: (line?: string) => void): Promise<void> {
  const account = readRegistryAccount();
  const broker = readBrokerUrl(account);
  const revoke = account ? await revokeSession(broker, account.token) : 'skipped';

  const removedFiles = clearRegistryAccount();
  // The helper binary goes with the credential: left on PATH with nothing to
  // read, it is a `docker pull` that fails with a helper error instead of an
  // honest "not signed in".
  const helper = uninstallCredentialHelper();
  log.info('Registry logout', { revoke, removedFiles, helper });

  if (!account) {
    say('Not signed in — nothing to revoke.');
  } else if (revoke === 'revoked') {
    say('Session revoked.');
  } else if (revoke === 'gone') {
    say('That session was already invalid; removed it locally.');
  } else {
    say(`Couldn't reach ${broker} to revoke the session — removed it locally anyway.`);
    say('If you believe the token was copied elsewhere, revoke it from your account page.');
  }
  if (removedFiles.length) say('Credential removed.');
  if (helper.removedHosts.length) {
    say(`Docker no longer asks us for ${helper.removedHosts.join(', ')}.`);
  }

  // Deliberately not coupled to --opt-out: someone re-signing-in on the same
  // machine should not have to re-opt-in. But a pull with no credential fails,
  // so say so rather than letting the next container step discover it.
  if (readImageSource() === 'hardened') {
    say('');
    say(`This install still pulls its agent image (${HARDENED_IMAGE_ENV_KEY}=true) and no longer has`);
    say('credentials for it. Sign in again by re-running setup, or switch back with --opt-out.');
  }

  emitStatus(BLOCK, {
    MODE: 'logout',
    REVOKE: revoke,
    CREDENTIAL_REMOVED: String(removedFiles.length > 0),
    CRED_HELPER_REMOVED: helper.removedBinaries.join(',') || '',
    CRED_HELPER_HOSTS: helper.removedHosts.join(','),
    IMAGE_SOURCE: readImageSource(),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

type RevokeOutcome = 'revoked' | 'gone' | 'failed' | 'skipped';

/**
 * `DELETE /v1/session`, authenticated with the token being revoked.
 *
 * 401/404 count as success: both mean the broker does not recognise this token,
 * which is the state we were trying to reach. Short timeout because this is
 * cleanup — a hanging broker must not hold up removing a local file.
 */
async function revokeSession(broker: string, token: string): Promise<RevokeOutcome> {
  try {
    const res = await fetch(`${broker}/v1/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 || res.status === 404) return 'gone';
    if (!res.ok) {
      log.warn('Broker refused the revoke', { status: res.status });
      return 'failed';
    }
    return 'revoked';
  } catch (err) {
    log.warn('Could not reach the broker to revoke the session', { broker, err });
    return 'failed';
  }
}
