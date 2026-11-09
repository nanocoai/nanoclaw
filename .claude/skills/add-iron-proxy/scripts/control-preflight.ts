import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installCommand } from './install-command.js';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(fs.readFileSync(path.join(skill, 'versions.json'), 'utf8')) as Record<string, string>;

/** Registers QEMU user-mode emulation for linux/amd64 with the engine's kernel; printed, never run by setup. */
export const AMD64_EMULATION_COMMAND = `docker run --privileged --rm ${pins['amd64-emulation-image']} --install amd64`;

const BINFMT = '/proc/sys/fs/binfmt_misc';

/**
 * Whether this kernel runs amd64 binaries through binfmt_misc: the global
 * switch on, and one enabled handler for 64-bit x86-64 ELF at offset 0 (the
 * handler's name varies; NixOS registers x86_64-linux) with the F flag,
 * without which the interpreter is looked up inside each container, and the
 * console image has none. Undefined when binfmt_misc cannot be read here
 * (not mounted in this namespace): unknown, not absent.
 */
export function hasAmd64Emulation(
  list = () => fs.readdirSync(BINFMT),
  read = (file: string) => fs.readFileSync(path.join(BINFMT, file), 'utf8'),
): boolean | undefined {
  let status: string;
  try {
    status = read('status').trim();
  } catch {
    return undefined;
  }
  if (status !== 'enabled') return false;
  try {
    return list().some((name) => {
      if (name === 'status' || name === 'register') return false;
      const lines = read(name).split('\n');
      const field = (key: string) =>
        lines
          .find((line) => line.startsWith(key))
          ?.slice(key.length)
          .trim() ?? '';
      const magic = field('magic ').replace(/\s/g, '');
      return (
        lines[0].trim() === 'enabled' &&
        field('flags:').includes('F') &&
        (field('offset ') || '0') === '0' &&
        magic.startsWith('7f454c4602') &&
        magic.slice(36, 40) === '3e00'
      );
    });
  } catch {
    return undefined;
  }
}

/**
 * The pinned console image is linux/amd64 only. On an engine that runs on
 * this machine (same kernel and hostname) and can neither run it natively nor
 * emulate it, stop before any pull and say what enables emulation. An engine
 * elsewhere (Docker Desktop, a VM, a remote daemon) cannot be inspected from
 * here and is left to run as before. Setup runs this before building Iron Proxy.
 */
export async function checkControlEngine(emulation = hasAmd64Emulation, platform = process.platform): Promise<void> {
  const [arch, kernel, host] = (
    await installCommand('docker', ['info', '--format', '{{.Architecture}} {{.KernelVersion}} {{.Name}}'], {
      label: 'Check the Docker engine architecture',
      timeoutMs: 15_000,
      capture: true,
      failureHint: 'Check that Docker is running and reachable, then retry.',
    })
  )
    .trim()
    .split(' ');
  if (!/^[a-z0-9_]+$/.test(arch ?? ''))
    throw new Error('Docker did not report its engine architecture; check that Docker is running');
  if (arch === 'x86_64' || platform !== 'linux' || kernel !== os.release() || host !== os.hostname()) return;
  if (emulation() !== false) return;
  throw new Error(
    [
      `Iron Control cannot run on this ${arch} Docker engine: its pinned image is linux/amd64 only and the engine has no amd64 emulation.`,
      'Pick one, then re-run setup:',
      `  - Enable amd64 emulation for this Docker engine: ${AMD64_EMULATION_COMMAND}`,
      '    Iron Control then runs its pinned image emulated; Iron Proxy stays native. The registration lives in the kernel and is gone after a reboot: re-run it, or register it at boot, or Iron Control restart-loops with exec format error.',
      '  - Choose the OneCLI gateway instead of Iron Proxy.',
    ].join('\n'),
  );
}
