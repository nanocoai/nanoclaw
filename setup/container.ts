/**
 * Step: container — Build container image and verify with test run.
 * Supports Apple Container (preferred on macOS) and Docker.
 */
import { execSync, spawnSync } from 'child_process';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { log } from '../src/log.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { commandExists, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

type RuntimeStatus = 'ok' | 'no-permission' | 'no-daemon' | 'other';

function runtimeStatus(runtime: string): RuntimeStatus {
  const cmd = runtime === 'container' ? ['container', 'system', 'status'] : ['docker', 'info'];
  const res = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf-8' });
  if (res.status === 0) return 'ok';
  const err = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  if (/permission denied/i.test(err)) return 'no-permission';
  if (/cannot connect|is the docker daemon running|no such file|api server not running/i.test(err)) return 'no-daemon';
  return 'other';
}

/**
 * Try to start the runtime if installed but idle. Polls up to 60s for it
 * to come up — but bails on permission errors (only docker on linux).
 */
async function tryStartRuntime(runtime: string): Promise<RuntimeStatus> {
  const platform = getPlatform();
  log.info('Container runtime not running — attempting to start', { runtime, platform });

  try {
    if (runtime === 'container') {
      execSync('container system start', { stdio: 'ignore' });
    } else if (platform === 'macos') {
      execSync('open -a Docker', { stdio: 'ignore' });
    } else if (platform === 'linux') {
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
    const s = runtimeStatus(runtime);
    if (s === 'ok') {
      log.info('Runtime is up', { runtime });
      return 'ok';
    }
    if (s === 'no-permission') {
      log.info('Docker daemon is up but socket is not accessible (group membership)');
      return 'no-permission';
    }
  }
  log.warn('Runtime did not become ready within 60s', { runtime });
  return 'no-daemon';
}

/**
 * Pick a runtime: explicit --runtime wins; otherwise prefer Apple Container
 * on macOS when present, falling back to Docker.
 */
function pickRuntime(explicit?: string): string {
  if (explicit && explicit !== 'auto') return explicit;
  if (commandExists('container') && getPlatform() === 'macos') return 'container';
  return 'docker';
}

function parseArgs(args: string[]): { runtime: string } {
  let explicit: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      explicit = args[i + 1];
      i++;
    }
  }
  return { runtime: pickRuntime(explicit) };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = getDefaultContainerImage(projectRoot);

  if (runtime !== 'docker' && runtime !== 'container') {
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

  // Install path for docker only; Apple Container must be present already.
  if (runtime === 'docker' && !commandExists('docker')) {
    log.info('Docker not found — running setup/install-docker.sh');
    try {
      execSync('bash setup/install-docker.sh', { cwd: projectRoot, stdio: 'inherit' });
    } catch (err) {
      log.warn('install-docker.sh failed', { err });
    }
  }

  if (!commandExists(runtime)) {
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
    let status = runtimeStatus(runtime);
    if (status !== 'ok') {
      status = await tryStartRuntime(runtime);
    }

    // Docker-on-Linux: stale group membership requires sg re-exec.
    if (runtime === 'docker' && status === 'no-permission' && getPlatform() === 'linux' && commandExists('sg')) {
      const inGroup = spawnSync('id', ['-nG'], { encoding: 'utf-8' });
      if (!(inGroup.stdout ?? '').split(/\s+/).includes('docker')) {
        log.info('Adding current user to docker group');
        spawnSync('sudo', ['usermod', '-aG', 'docker', process.env.USER ?? ''], { stdio: 'inherit' });
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

  // Build-args from .env. Only INSTALL_CJK_FONTS is passed through today.
  const buildArgs: string[] = [];
  try {
    const fs = await import('fs');
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf-8').match(/^INSTALL_CJK_FONTS=(.+)$/m);
      const val = match?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (val === 'true') buildArgs.push('--build-arg', 'INSTALL_CJK_FONTS=true');
    }
  } catch {
    // .env is optional
  }

  // Build — stdio inherit so the parent setup runner can tail per-step output
  // and render it in a rolling window.
  let buildOk = false;
  log.info('Building container', { runtime, buildArgs });
  const buildRes = spawnSync(
    runtime,
    ['build', ...buildArgs, '-t', image, '.'],
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

  // Test
  let testOk = false;
  if (buildOk) {
    log.info('Testing container');
    try {
      const output = execSync(
        `echo '{}' | ${runtime} run -i --rm --entrypoint /bin/echo ${image} "Container OK"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      testOk = output.includes('Container OK');
      log.info('Container test result', { testOk });
    } catch {
      log.error('Container test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
