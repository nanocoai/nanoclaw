/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 */
import { execSync, spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { log } from '../src/log.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { commandExists, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

type DockerStatus = 'ok' | 'no-permission' | 'no-daemon' | 'other';

function dockerStatus(): DockerStatus {
  const res = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (res.status === 0) return 'ok';
  const err = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  if (/permission denied/i.test(err)) return 'no-permission';
  if (/cannot connect|is the docker daemon running|no such file/i.test(err)) return 'no-daemon';
  return 'other';
}

function dockerRunning(): boolean {
  return dockerStatus() === 'ok';
}

/**
 * Try to start Docker if it's installed but idle. Poll up to 60s for the
 * daemon to come up — but bail immediately if the socket is reachable and
 * only blocked by a group-permission error, since that won't resolve by
 * waiting (the caller handles the sg re-exec for that case).
 */
async function tryStartDocker(): Promise<DockerStatus> {
  const platform = getPlatform();
  log.info('Docker not running — attempting to start', { platform });

  try {
    if (platform === 'macos') {
      execSync('open -a Docker', { stdio: 'ignore' });
    } else if (platform === 'linux') {
      // Inherit stdio so sudo can prompt for a password if needed.
      execSync('sudo systemctl start docker', { stdio: 'inherit' });
    } else {
      return 'other';
    }
  } catch (err) {
    log.warn('Start command failed', { err });
    return 'other';
  }

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const s = dockerStatus();
    if (s === 'ok') {
      log.info('Docker is up');
      return 'ok';
    }
    if (s === 'no-permission') {
      log.info('Docker daemon is up but socket is not accessible (group membership)');
      return 'no-permission';
    }
  }
  log.warn('Docker did not become ready within 60s');
  return 'no-daemon';
}

function parseArgs(args: string[]): { runtime: string } {
  // `--runtime` is still accepted for backwards compatibility with the /setup
  // skill, but `docker` is the only supported value.
  let runtime = 'docker';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      runtime = args[i + 1];
      i++;
    }
  }
  return { runtime };
}

/**
 * Read a setup-time setting: caller's env wins, `.env` is the fallback.
 *
 * Not `src/config.ts`'s `readEnvFile` — `setup/index.ts` never calls
 * `applyToEnv`, so on a standalone `--step container` run (including the
 * `sg docker` re-exec below) none of these keys are in process.env.
 */
function readSetting(projectRoot: string, name: string): string | undefined {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const content = readFileSync(path.join(projectRoot, '.env'), 'utf-8');
    const match = content.match(new RegExp(`^${name}=(.+)$`, 'm'));
    return match?.[1].trim().replace(/^["']|["']$/g, '');
  } catch (_err) {
    return undefined;
  }
}

/**
 * Repository half of the committed `agent-image` pin, if there is one.
 *
 * The pin may also be an object keyed by platform. Architecture is irrelevant
 * here — per-platform references differ in digest, not in repository — so any
 * entry answers the question, and this avoids needing to know the daemon's
 * architecture on a step that must work standalone.
 */
function pinnedRepo(projectRoot: string): string | undefined {
  try {
    const raw = readFileSync(path.join(projectRoot, 'versions.json'), 'utf-8');
    const pin = (JSON.parse(raw) as Record<string, unknown>)['agent-image'];
    const ref =
      typeof pin === 'string'
        ? pin
        : pin && typeof pin === 'object' && !Array.isArray(pin)
          ? Object.values(pin as Record<string, unknown>).find(
              (v): v is string => typeof v === 'string' && v.trim().length > 0,
            )
          : undefined;
    return ref ? ref.split('@')[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The registry digest behind the local tag, for the status block. Empty for a
 * locally built image — it has no RepoDigests — which is why it is only read
 * on the pull path.
 *
 * `expectRepo` is the repository we just pulled from. The same bytes pushed to
 * more than one repository carry one RepoDigest each, all addressing identically,
 * so taking the first reports whichever sorts first — routinely not the one in
 * play. Match the expected repository and only fall back when nothing matches.
 */
function imageDigest(image: string, expectRepo?: string): string {
  const res = spawnSync(
    'docker',
    ['image', 'inspect', '--format', '{{range .RepoDigests}}{{println .}}{{end}}', image],
    { encoding: 'utf-8' },
  );
  if (res.status !== 0) return '';
  const all = (res.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (expectRepo) {
    const match = all.find((d) => d.startsWith(`${expectRepo}@`));
    if (match) return match;
  }
  return all[0] ?? '';
}

/**
 * What the image must satisfy for a spawn to work, mirroring what
 * `buildContainerArgs` produces: `--entrypoint bash`, an arbitrary uid on
 * macOS, HOME forced to /home/node. The caller pre-creates /workspace/group in
 * the scratch mount the way the host owns a real session dir, so this asserts
 * the image can use it, not that the daemon can conjure it.
 */
const SMOKE_SCRIPT = [
  'set -e',
  'command -v bun >/dev/null',
  'command -v git >/dev/null',
  'test -r /app/node_modules',
  'test -w /home/node',
  'test -w /workspace/group',
  'touch /workspace/.heartbeat',
  'echo "Container OK"',
].join('\n');

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = getDefaultContainerImage(projectRoot);
  const logFile = path.join(projectRoot, 'logs', 'setup.log');

  if (runtime !== 'docker') {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'unknown_runtime',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!commandExists('docker')) {
    log.info('Docker not found — running setup/install-docker.sh');
    try {
      execSync('bash setup/install-docker.sh', { cwd: projectRoot, stdio: 'inherit' });
    } catch (err) {
      log.warn('install-docker.sh failed', { err });
    }
  }

  if (!commandExists('docker')) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  {
    let status = dockerStatus();
    if (status !== 'ok') {
      status = await tryStartDocker();
    }

    // Socket is unreachable due to group perms — current shell's supplementary
    // groups are fixed at login, so `usermod -aG docker` doesn't affect us
    // until next login. Ensure the user is in the docker group (install-docker.sh
    // does this on fresh installs, but skips when Docker is already present),
    // then re-exec under `sg docker` so the child picks up docker as its
    // primary group and can talk to /var/run/docker.sock without a logout.
    if (status === 'no-permission' && getPlatform() === 'linux' && commandExists('sg')) {
      // Ensure the current user is in the docker group — without this,
      // sg will ask for the (typically unset) group password and fail.
      const inGroup = spawnSync('id', ['-nG'], { encoding: 'utf-8' });
      if (!(inGroup.stdout ?? '').split(/\s+/).includes('docker')) {
        log.info('Adding current user to docker group');
        spawnSync('sudo', ['usermod', '-aG', 'docker', process.env.USER ?? ''], {
          stdio: 'inherit',
        });
      }

      log.info('Re-executing container step under `sg docker`');
      const res = spawnSync(
        'sg',
        ['docker', '-c', 'pnpm exec tsx setup/index.ts --step container'],
        { cwd: projectRoot, stdio: 'inherit' },
      );
      process.exit(res.status ?? 1);
    }

    if (status !== 'ok') {
      const error =
        status === 'no-permission' ? 'docker_group_not_active' : 'runtime_not_available';
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: error,
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  const buildCmd = 'docker build';
  const runCmd = 'docker';

  // Build-args from .env. Only INSTALL_CJK_FONTS is passed through today.
  // Keeps /setup and ./container/build.sh in sync — both read the same source.
  const buildArgs: string[] = [];
  try {
    const fs = await import('fs');
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf-8').match(/^INSTALL_CJK_FONTS=(.+)$/m);
      const val = match?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (val === 'true') buildArgs.push('--build-arg INSTALL_CJK_FONTS=true');
    }
  } catch {
    // .env is optional; absence is normal on a fresh checkout
  }

  // Where the image comes from. pull.sh fetches pinned bytes and retags them to
  // `image`, so everything past this point is identical either way. The other
  // rebuild paths refuse when this is set, because `docker build -t <slug>:latest`
  // would replace the pinned image in place with nothing downstream able to tell.
  const source =
    readSetting(projectRoot, 'NANOCLAW_HARDENED_IMAGE')?.toLowerCase() === 'true'
      ? 'pull'
      : 'build';

  // Build — stdio inherit so the parent setup runner can tail docker's
  // per-step output and render it in a rolling window. Previously we used
  // execSync which buffered everything; users couldn't tell whether a
  // 3–10 minute build was making progress or hung. The pull path inherits
  // stdio for the same reason: a cold pull is minutes of layer transfer.
  let buildOk = false;
  let digest = '';
  let errorCode = '';
  if (source === 'pull') {
    log.info('Acquiring container image from registry', { image });
    const pullRes = spawnSync('bash', [path.join(projectRoot, 'container', 'pull.sh')], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    if (pullRes.status === 0) {
      buildOk = true;
      // The pinned ref names the repository we pulled from; pass it so the
      // reported digest is that repository's and not some other one the same
      // bytes also live in.
      digest = imageDigest(image, readSetting(projectRoot, 'NANOCLAW_AGENT_IMAGE_REF')?.split('@')[0] ?? pinnedRepo(projectRoot));
      log.info('Container image acquired', { image, digest });

      // Retagging the slug tag does nothing for an agent group pinned to its
      // own derived image — `container-runner.ts:511` prefers that pin — so
      // the reconcile is part of acquiring the image, not a follow-up.
      // Imported here rather than at the top of the file so a local-build
      // install never loads the DB layer at all, and so a problem in the
      // reconcile can't stop an install that already has its image.
      try {
        const { reconcileDerivedImages } = await import('./registry-reconcile.js');
        const reconciled = reconcileDerivedImages();
        log.info('Derived agent-group images reconciled', {
          cleared: reconciled.cleared.length,
          removed: reconciled.removed.length,
          foreign: reconciled.foreign.length,
        });
      } catch (err) {
        // Loud, but not fatal: the image is pulled and tagged. What's left is
        // groups still spawning pre-hardened derived images, which is exactly
        // what `--step registry-reconcile` exists to fix by hand.
        log.error('Could not reconcile derived agent-group images', { err });
      }
    } else {
      // No fallback to a local build: that would swap the pinned image for
      // locally built bytes under the same tag and then report success.
      // pull.sh exits 2 when there is nothing configured to pull.
      errorCode = pullRes.status === 2 ? 'image_ref_not_configured' : 'image_pull_failed';
      log.error('Container image pull failed', { exitCode: pullRes.status, errorCode });
    }
  } else {
    log.info('Building container', { runtime, buildArgs });
    const buildRes = spawnSync(
      buildCmd.split(' ')[0],
      [
        ...buildCmd.split(' ').slice(1),
        ...buildArgs.flatMap((a) => a.split(' ')),
        '-t',
        image,
        '.',
      ],
      {
        cwd: path.join(projectRoot, 'container'),
        stdio: 'inherit',
      },
    );
    if (buildRes.status === 0) {
      buildOk = true;
      log.info('Container build succeeded');
    } else {
      log.error('Container build failed', { exitCode: buildRes.status });
    }
  }

  // Test under the contract the runner actually spawns with, not merely "the
  // image can run something". On macOS `--user` is an arbitrary uid with no
  // passwd entry, so everything the agent touches must be world-accessible or
  // owned through a mount — the old `--entrypoint /bin/echo` test ran as the
  // image's default user and passed on images the agent could not start in.
  // Scratch dir under data/ because that is where real session dirs live.
  let testOk = false;
  if (buildOk) {
    log.info('Testing container');
    mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
    const workspace = mkdtempSync(path.join(projectRoot, 'data', 'container-smoke-'));
    // 0777 because the mount has to be writable by the container's effective
    // uid, which is only the host's on the path where --user is pushed.
    chmodSync(workspace, 0o777);
    // Pre-create the image's WORKDIR on the host rather than letting the daemon
    // materialize it inside the mount. Production does exactly this — the host
    // owns the session dir and its `group/` before the container ever starts
    // (buildMounts in src/container-runner.ts) — and daemons disagree about who
    // owns a WORKDIR auto-created inside a bind mount, so relying on that would
    // make the smoke test stricter than the thing it is meant to model.
    mkdirSync(path.join(workspace, 'group'), { recursive: true });
    chmodSync(path.join(workspace, 'group'), 0o777);
    try {
      const testArgs = ['run', '--rm', '-v', `${workspace}:/workspace`];
      const hostUid = process.getuid?.();
      const hostGid = process.getgid?.();
      if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
        testArgs.push('--user', `${hostUid}:${hostGid}`, '-e', 'HOME=/home/node');
      }
      testArgs.push('--entrypoint', 'bash', image, '-c', SMOKE_SCRIPT);
      const testRes = spawnSync(runCmd, testArgs, { encoding: 'utf-8' });
      testOk = testRes.status === 0 && (testRes.stdout ?? '').includes('Container OK');
      if (testOk) {
        log.info('Container test result', { testOk });
      } else {
        log.error('Container test failed', {
          exitCode: testRes.status,
          stderr: (testRes.stderr ?? '').trim().slice(-500),
        });
      }
    } finally {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch (err) {
        log.warn('Could not remove the smoke-test workspace', { workspace, err });
      }
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    SOURCE: source,
    ...(digest ? { DIGEST: digest } : {}),
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    ...(errorCode ? { ERROR: errorCode } : {}),
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
