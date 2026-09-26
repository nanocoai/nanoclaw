import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as p from '@clack/prompts';
import { parse as parseYaml } from 'yaml';

import { installCommand, InstallCommandFailure } from './install-command.js';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(fs.readFileSync(path.join(skill, 'versions.json'), 'utf8')) as Record<string, string>;

/** Registers QEMU user-mode emulation for linux/amd64 with the running kernel. */
export const AMD64_EMULATION_COMMAND = 'docker run --privileged --rm tonistiigi/binfmt --install amd64';
const REVISION_LABEL = 'org.opencontainers.image.revision';

/**
 * Where the console image comes from. The upstream registry publishes Iron
 * Control for linux/amd64 only, so another architecture either builds the
 * pinned source natively or runs the pinned image under emulation.
 */
export type ControlImageSource = 'pinned' | 'pinned-emulated' | 'local-build';

/** The image the compose file runs for Iron Control's `web` service. */
export interface ControlImage {
  source: ControlImageSource;
  image: string;
  /** Compose `platform:`: linux/amd64 for the pinned image, the engine's own for a local build. */
  platform: string;
  /** The Docker engine architecture the choice was made for (GOARCH). */
  arch: string;
}

export interface ControlHost {
  /** The Docker engine's architecture (GOARCH): amd64, arm64, … */
  arch: string;
  /** `docker buildx version` succeeds, so setup can build the pinned source here. */
  canBuild: boolean;
  /** The engine runs linux/amd64 containers: Docker Desktop, or QEMU binfmt on Linux. */
  hasEmulation: boolean;
  /** This machine already holds the locally built image for the pinned revision. */
  hasLocalBuild: boolean;
}

/** Recorded in the install's material directory so re-runs and updates keep the same path. */
export interface ControlImageRecord extends ControlImage {
  commit: string;
  imageId?: string;
  recordedAt: string;
}

export type ControlImagePlan = { ok: true; image: ControlImage; note?: string } | { ok: false; message: string };

/** The install seam for tests: production runs `installCommand` itself. */
export type Exec = typeof installCommand;

export interface ControlImageOptions {
  exec?: Exec;
  /**
   * Asks the operator whether setup may register amd64 emulation with the
   * given command. Absent in a headless run, which stops with the exact
   * commands instead.
   */
  confirmEmulation?: (command: string) => Promise<boolean>;
  /** Test seam for the emulation probe. */
  emulation?: () => boolean;
  report?: (line: string) => void;
}

export function pinnedControlImage(): ControlImage {
  return {
    source: 'pinned',
    image: pins['iron-control-image'],
    platform: pins['iron-control-platform'],
    arch: 'amd64',
  };
}

export function emulatedControlImage(arch: string): ControlImage {
  return {
    source: 'pinned-emulated',
    image: pins['iron-control-image'],
    platform: pins['iron-control-platform'],
    arch,
  };
}

export function localControlImageTag(arch: string): string {
  return `nanoclaw-iron-control:${pins['iron-control-commit'].slice(0, 7)}-${arch}`;
}

export function localControlImage(arch: string): ControlImage {
  return { source: 'local-build', image: localControlImageTag(arch), platform: `linux/${arch}`, arch };
}

export function blockedControlImageMessage(arch: string): string {
  return [
    `Iron Control has no ${arch} image: the pinned upstream image is linux/amd64 only, this Docker cannot build one (docker buildx is unavailable), and it cannot run amd64 containers under emulation.`,
    'Pick one, then re-run setup:',
    '  - Install Docker Buildx (the docker-buildx-plugin package) so setup builds Iron Control from the pinned source on this machine.',
    `  - Enable amd64 emulation for this Docker engine: ${AMD64_EMULATION_COMMAND}`,
    '    Iron Control then runs emulated; Iron Proxy stays native.',
    '  - Choose the OneCLI gateway instead of Iron Proxy.',
  ].join('\n');
}

/**
 * The decision table. amd64 keeps the pinned image and digest untouched. Any
 * other architecture reuses what this install already chose while that path
 * still works, otherwise prefers a native build over emulation.
 */
export function planControlImage(host: ControlHost, previous?: ControlImageSource): ControlImagePlan {
  if (host.arch === 'amd64') return { ok: true, image: pinnedControlImage() };
  const emulated: ControlImagePlan = {
    ok: true,
    image: emulatedControlImage(host.arch),
    note: `Iron Control runs its pinned linux/amd64 image under emulation on this ${host.arch} host; Iron Proxy stays native.`,
  };
  const local = (note: string): ControlImagePlan => ({ ok: true, image: localControlImage(host.arch), note });
  if (previous === 'pinned-emulated' && host.hasEmulation) return emulated;
  if (host.hasLocalBuild) return local(`Using the Iron Control image built on this machine for ${host.arch}.`);
  if (host.canBuild) {
    return local(
      `Iron Control publishes no ${host.arch} image; building it from the pinned source on this machine (several minutes).`,
    );
  }
  if (host.hasEmulation) return emulated;
  return { ok: false, message: blockedControlImageMessage(host.arch) };
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

const probeHint = 'Check that Docker is running and reachable, then retry.';

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
      failureHint: probeHint,
    })
  ).trim();
  if (!/^[a-z0-9]+$/.test(arch))
    throw new Error('Docker did not report its engine architecture; check that Docker is running');
  if (arch === 'amd64') return { arch, canBuild: true, hasEmulation: true, hasLocalBuild: false };
  const canBuild = (await probe(exec, ['buildx', 'version'], 'Check Docker Buildx', 'not available')) !== undefined;
  const built = await probe(
    exec,
    [
      'image',
      'inspect',
      localControlImageTag(arch),
      '--format',
      `{{.Architecture}} {{index .Config.Labels "${REVISION_LABEL}"}}`,
    ],
    'Check for an Iron Control image built on this machine',
    'not built yet',
  );
  return {
    arch,
    canBuild,
    hasEmulation: (options.emulation ?? hasAmd64Emulation)(),
    hasLocalBuild: built?.trim() === `${arch} ${pins['iron-control-commit']}`,
  };
}

export function readControlImageRecord(file: string): ControlImageRecord | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as ControlImageRecord;
    const sources: ControlImageSource[] = ['pinned', 'pinned-emulated', 'local-build'];
    if (!sources.includes(record.source) || typeof record.arch !== 'string' || typeof record.image !== 'string')
      return undefined;
    return record;
  } catch {
    return undefined;
  }
}

function writeControlImageRecord(file: string, record: ControlImageRecord): void {
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Installs from before image.json ran the pinned image under emulation; they
 * stay on it while it still works. Only a compose file that still pins that
 * image counts, so deleting image.json from a local build decides again.
 */
function composeSource(file: string): ControlImageSource | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const web = parseYaml(fs.readFileSync(file, 'utf8'))?.services?.web;
    return web?.image === pins['iron-control-image'] && web?.platform ? 'pinned-emulated' : undefined;
  } catch {
    return undefined;
  }
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

async function askEmulation(command: string): Promise<boolean> {
  const answer = await p.confirm({
    message: `Iron Control has no image for this architecture and Docker cannot build one here. Enable amd64 emulation now by running: ${command}?`,
    initialValue: false,
  });
  return !p.isCancel(answer) && answer === true;
}

/**
 * Decides before any pull how Iron Control runs on this engine, builds the
 * native image when that is the choice, and records the choice next to the
 * install's other console material. amd64 engines never leave the pinned
 * image and write no record.
 */
export async function ensureControlImage(
  paths: { image: string; compose: string },
  options: ControlImageOptions = {},
): Promise<ControlImage> {
  const exec = options.exec ?? installCommand;
  const report = options.report ?? console.log;
  const emulation = options.emulation ?? hasAmd64Emulation;
  const host = await detectControlHost(options);
  if (host.arch === 'amd64') return pinnedControlImage();
  const record = readControlImageRecord(paths.image);
  const previous = record?.arch === host.arch ? record.source : composeSource(paths.compose);
  let plan = planControlImage(host, previous);
  if (!plan.ok) {
    const confirm =
      options.confirmEmulation ?? (process.stdin.isTTY && process.stdout.isTTY ? askEmulation : undefined);
    if (!confirm || !(await confirm(AMD64_EMULATION_COMMAND))) throw new Error(plan.message);
    await exec('docker', ['run', '--privileged', '--rm', 'tonistiigi/binfmt', '--install', 'amd64'], {
      label: 'Enable amd64 emulation',
      timeoutMs: 180_000,
      failureHint: `Run it yourself and re-run setup: ${AMD64_EMULATION_COMMAND}`,
    });
    if (!emulation()) throw new Error(`amd64 emulation is still unavailable after: ${AMD64_EMULATION_COMMAND}`);
    plan = planControlImage({ ...host, hasEmulation: true }, previous);
    if (!plan.ok) throw new Error(plan.message);
  }
  if (plan.note) report(plan.note);
  const image = plan.image;
  let imageId: string | undefined;
  if (image.source === 'local-build') {
    if (!host.hasLocalBuild) await buildControlImage(host.arch, exec);
    imageId = (
      await exec('docker', ['image', 'inspect', image.image, '--format', '{{.Id}}'], {
        label: 'Record the Iron Control image',
        timeoutMs: 15_000,
        capture: true,
      })
    ).trim();
  }
  writeControlImageRecord(paths.image, {
    ...image,
    commit: pins['iron-control-commit'],
    ...(imageId ? { imageId } : {}),
    recordedAt: new Date().toISOString(),
  });
  return image;
}
