import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installCommand, InstallCommandFailure } from './install-command.js';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(fs.readFileSync(path.join(skill, 'versions.json'), 'utf8')) as Record<string, string>;

const REVISION_LABEL = 'org.opencontainers.image.revision';

/** Registers QEMU user-mode emulation for linux/amd64 with the running kernel; printed, never run by setup. */
export const AMD64_EMULATION_COMMAND = `docker run --privileged --rm ${pins['amd64-emulation-image']} --install amd64`;

/** The image the compose file runs for Iron Control's `web` service. */
export interface ControlImage {
  /** The upstream registry publishes Iron Control for linux/amd64 only; other engines without emulation build the pinned source. */
  source: 'pinned' | 'local-build';
  image: string;
  /** Compose `platform:`: linux/amd64 for the pinned image, the engine's own for a local build. */
  platform: string;
}

export interface ControlHost {
  /** The Docker engine's architecture (GOARCH): amd64, arm64, … */
  arch: string;
  /** The engine runs linux/amd64 containers: Docker Desktop, or QEMU binfmt on Linux. */
  hasEmulation: boolean;
}

/** The install seam for tests: production runs `installCommand` itself. */
export type Exec = typeof installCommand;

export interface ControlImageOptions {
  exec?: Exec;
  /** Test seam for the emulation probe. */
  emulation?: () => boolean;
  report?: (line: string) => void;
}

export function pinnedControlImage(): ControlImage {
  return { source: 'pinned', image: pins['iron-control-image'], platform: pins['iron-control-platform'] };
}

export function localControlImageTag(arch: string): string {
  return `nanoclaw-iron-control:${pins['iron-control-commit'].slice(0, 7)}-${arch}`;
}

export function localControlImage(arch: string): ControlImage {
  return { source: 'local-build', image: localControlImageTag(arch), platform: `linux/${arch}` };
}

export function blockedControlImageMessage(arch: string): string {
  return [
    `Iron Control has no ${arch} image: the pinned upstream image is linux/amd64 only, this Docker engine cannot run amd64 containers under emulation, and it cannot build one (docker buildx is unavailable).`,
    'Pick one, then re-run setup:',
    `  - Enable amd64 emulation for this Docker engine: ${AMD64_EMULATION_COMMAND}`,
    '    Iron Control then runs its pinned image emulated; Iron Proxy stays native.',
    '  - Install Docker Buildx (the docker-buildx-plugin package) so setup builds Iron Control from the pinned source on this machine.',
    '  - Choose the OneCLI gateway instead of Iron Proxy.',
  ].join('\n');
}

/**
 * The decision table: the pinned image and digest wherever the engine can run
 * it (amd64 natively, anything else under emulation); a native build from the
 * pinned source only where it cannot.
 */
export function planControlImage(host: ControlHost): { image: ControlImage; note?: string } {
  if (host.arch === 'amd64') return { image: pinnedControlImage() };
  if (host.hasEmulation) {
    return {
      image: pinnedControlImage(),
      note: `Iron Control runs its pinned linux/amd64 image under emulation on this ${host.arch} engine; Iron Proxy stays native.`,
    };
  }
  return {
    image: localControlImage(host.arch),
    note: `Iron Control publishes no ${host.arch} image and this engine cannot emulate amd64; building it from the pinned source on this machine.`,
  };
}

/**
 * Docker Desktop (macOS, Windows) always runs amd64 images. On Linux the
 * kernel must have a QEMU handler registered and enabled, which is what the
 * binfmt command above does. A disabled handler keeps its file, and the
 * global status switch disables every handler at once. The handler also needs
 * the F flag: without it the interpreter is looked up inside each container,
 * and the console image has none.
 */
export function hasAmd64Emulation(
  platform = process.platform,
  read = (file: string) => fs.readFileSync(file, 'utf8'),
): boolean {
  if (platform !== 'linux') return true;
  const entry = (file: string) => read(`/proc/sys/fs/binfmt_misc/${file}`).split('\n');
  try {
    const handler = entry('qemu-x86_64');
    const flags = handler.find((line) => line.startsWith('flags:')) ?? '';
    return entry('status')[0].trim() === 'enabled' && handler[0].trim() === 'enabled' && flags.slice(6).includes('F');
  } catch {
    return false;
  }
}

async function probe(exec: Exec, args: string[], label: string, absentHint: string): Promise<string | undefined> {
  try {
    return await exec('docker', args, { label, timeoutMs: 15_000, capture: true, absentHint });
  } catch (error) {
    if (error instanceof InstallCommandFailure && error.interrupted) throw error;
    return undefined;
  }
}

export async function detectControlHost(options: ControlImageOptions = {}): Promise<ControlHost> {
  const exec = options.exec ?? installCommand;
  const arch = (
    await exec('docker', ['version', '--format', '{{.Server.Arch}}'], {
      label: 'Check the Docker engine architecture',
      timeoutMs: 15_000,
      capture: true,
      failureHint: 'Check that Docker is running and reachable, then retry.',
    })
  ).trim();
  if (!/^[a-z0-9]+$/.test(arch))
    throw new Error('Docker did not report its engine architecture; check that Docker is running');
  return { arch, hasEmulation: arch === 'amd64' || (options.emulation ?? hasAmd64Emulation)() };
}

/**
 * Build unmodified upstream Iron Control from the pinned revision, natively.
 * Explicit so neither DOCKER_DEFAULT_PLATFORM nor a selected docker-container
 * builder (which keeps results in its cache) changes what lands in the engine.
 */
export async function buildControlImage(arch: string, exec: Exec = installCommand): Promise<void> {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-iron-control-'));
  try {
    const git = (args: string[], label = 'Prepare Iron Control source') =>
      exec('git', args, {
        cwd: source,
        label,
        timeoutMs: 120_000,
        failureHint:
          'The pinned source could not be fetched or prepared. Verify repository access from this machine and retry; setup will not prompt for credentials.',
      });
    await git(['init', '-q']);
    await git(['remote', 'add', 'origin', pins['iron-control-source']]);
    await git(['fetch', '--depth', '1', 'origin', pins['iron-control-commit']], 'Fetch pinned Iron Control source');
    await git(['checkout', '--detach', 'FETCH_HEAD']);
    await git(['diff', '--exit-code']);
    await exec(
      'docker',
      [
        'buildx',
        'build',
        '--platform',
        `linux/${arch}`,
        '--load',
        '-t',
        localControlImageTag(arch),
        '--label',
        `${REVISION_LABEL}=${pins['iron-control-commit']}`,
        '--label',
        'ai.nanoclaw.iron-control=local-build',
        source,
      ],
      {
        label: `Build Iron Control image for ${arch}`,
        timeoutMs: 1_200_000,
        failureHint: 'Check Docker, base-image registry access and build resources, then retry.',
      },
    );
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}

/**
 * Decides before any pull how Iron Control runs on this engine and builds the
 * native image when that is the only way. Nothing is recorded: every run
 * decides again from the engine, and the compose file carries the result.
 */
export async function ensureControlImage(options: ControlImageOptions = {}): Promise<ControlImage> {
  const exec = options.exec ?? installCommand;
  const report = options.report ?? console.log;
  const host = await detectControlHost(options);
  const plan = planControlImage(host);
  if (plan.note) report(plan.note);
  if (plan.image.source !== 'local-build') return plan.image;
  const built = await probe(
    exec,
    [
      'image',
      'inspect',
      plan.image.image,
      '--format',
      `{{.Architecture}} {{index .Config.Labels "${REVISION_LABEL}"}}`,
    ],
    'Check for an Iron Control image built on this machine',
    'not built yet',
  );
  if (built?.trim() === `${host.arch} ${pins['iron-control-commit']}`) {
    report(`Using the Iron Control image built on this machine for ${host.arch}.`);
    return plan.image;
  }
  if ((await probe(exec, ['buildx', 'version'], 'Check Docker Buildx', 'not available')) === undefined)
    throw new Error(blockedControlImageMessage(host.arch));
  await buildControlImage(host.arch, exec);
  return plan.image;
}
