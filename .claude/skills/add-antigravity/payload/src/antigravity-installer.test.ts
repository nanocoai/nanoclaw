/**
 * Behaviour test for container/install-antigravity.sh, the installer the
 * /add-antigravity Dockerfile block runs during the image build.
 *
 * The structural guard (antigravity-dockerfile.test.ts) proves the pins are
 * present; this one proves the script acts on them: the build architecture
 * picks the matching tarball and hash, anything else is refused, a version
 * the Dockerfile asks for that the script does not pin is refused, a checksum
 * mismatch stops before extraction, and the smoke check rejects a binary that
 * is not the pinned version. Nothing touches the network or /usr/local/bin:
 * curl, sha512sum, tar and install are stubs on PATH that log their calls, the
 * extracted "agy" is a stub that prints a chosen version, and AGY_INSTALL_DIR
 * points the install at a temporary prefix.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(root, 'container', 'install-antigravity.sh');
const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';

const pinned = (name: string): string => script.match(new RegExp(`^${name}=(\\S+)$`, 'm'))?.[1] ?? '';
const VERSION = pinned('AGY_VERSION');
const BASE = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${VERSION}-${pinned('AGY_EXECUTION_ID')}`;

const STUBS: Record<string, string> = {
  // curl -fsSL ... -o <file> <url>: record the URL, write a dummy tarball.
  curl: `out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; --retry|--retry-delay) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
echo "$url" >> "$STUB_LOG/curl"
printf 'tarball' > "$out"`,
  // sha512sum -c <file>: record the checksum line, pass unless told to fail.
  sha512sum: `cat "$2" >> "$STUB_LOG/sha512sum"
[ "\${STUB_SHA_FAIL:-}" = 1 ] && { echo "cli.tar.gz: FAILED" >&2; exit 1; }
exit 0`,
  // tar -xzf <tarball> -C <dir> antigravity: extract a stub agy that prints STUB_AGY_VERSION.
  tar: `echo "$*" >> "$STUB_LOG/tar"
printf '#!/bin/sh\\necho "$STUB_AGY_VERSION"\\n' > "$4/antigravity"
chmod +x "$4/antigravity"`,
  // install -m 0755 <src> <dest>
  install: `echo "$*" >> "$STUB_LOG/install"
cp "$3" "$4" && chmod 0755 "$4"`,
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(arch: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-installer-'));
  temps.push(dir);
  const bin = join(dir, 'bin');
  const log = join(dir, 'log');
  const prefix = join(dir, 'prefix');
  for (const d of [bin, log, prefix]) mkdirSync(d);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // uname -m, stubbed only when a test fakes the build machine.
  if (env.FAKE_UNAME !== undefined) {
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho "$FAKE_UNAME"\n');
    chmodSync(join(bin, 'uname'), 0o755);
  }
  const result = spawnSync('sh', [scriptPath, arch], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      AGY_INSTALL_DIR: prefix,
      STUB_LOG: log,
      STUB_AGY_VERSION: VERSION,
      ...env,
    },
  });
  const read = (name: string): string => (existsSync(join(log, name)) ? readFileSync(join(log, name), 'utf8') : '');
  return { ...result, read, agy: join(prefix, 'agy') };
}

describe('container/install-antigravity.sh', () => {
  it('is present and pins a version', () => {
    expect(existsSync(scriptPath)).toBe(true);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each([
    ['amd64', 'linux-x64/cli_linux_x64.tar.gz', 'AGY_SHA512_AMD64'],
    ['arm64', 'linux-arm/cli_linux_arm64.tar.gz', 'AGY_SHA512_ARM64'],
  ])('installs the pinned %s build after checking its own hash', (arch, path, hashVar) => {
    const r = run(arch);
    expect(r.status, r.stderr).toBe(0);
    expect(r.read('curl').trim()).toBe(`${BASE}/${path}`);
    expect(r.read('sha512sum')).toMatch(new RegExp(`^${pinned(hashVar)}  \\S+/cli\\.tar\\.gz\\n$`));
    expect(r.read('tar')).toMatch(/^-xzf \S+\/cli\.tar\.gz -C \S+ antigravity\n$/);
    expect(r.read('install')).toMatch(new RegExp(`^-m 0755 \\S+/antigravity ${r.agy}\\n$`));
    expect(existsSync(r.agy)).toBe(true);
    expect(r.stdout).toContain(`agy ${VERSION} installed at ${r.agy}`);
  });

  it.each([
    ['x86_64', 'linux-x64/cli_linux_x64.tar.gz'],
    ['aarch64', 'linux-arm/cli_linux_arm64.tar.gz'],
    ['arm64', 'linux-arm/cli_linux_arm64.tar.gz'],
  ])('falls back to the build machine (%s) when no architecture is passed', (machine, path) => {
    const r = run('', { FAKE_UNAME: machine });
    expect(r.status, r.stderr).toBe(0);
    expect(r.read('curl').trim()).toBe(`${BASE}/${path}`);
  });

  it('refuses an unsupported build machine when no architecture is passed', () => {
    const r = run('', { FAKE_UNAME: 'armv7l' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unsupported architecture 'armv7l'");
    expect(r.read('curl')).toBe('');
  });

  it('refuses an architecture agy does not ship, before downloading', () => {
    const r = run('riscv64');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unsupported architecture 'riscv64'");
    expect(r.read('curl')).toBe('');
  });

  it('installs when the Dockerfile asks for the pinned version', () => {
    const r = run('amd64', { AGY_REQUESTED_VERSION: VERSION });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(r.agy)).toBe(true);
  });

  it('refuses a Dockerfile version the script does not pin, before downloading', () => {
    const r = run('amd64', { AGY_REQUESTED_VERSION: '9.9.9' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`the Dockerfile asks for agy 9.9.9, but this script pins ${VERSION}`);
    expect(r.read('curl')).toBe('');
  });

  it('aborts on a checksum mismatch before extracting or installing', () => {
    const r = run('amd64', { STUB_SHA_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(r.read('sha512sum')).not.toBe('');
    expect(r.read('tar')).toBe('');
    expect(r.read('install')).toBe('');
    expect(existsSync(r.agy)).toBe(false);
  });

  it('fails the smoke check when the binary is not the pinned version', () => {
    const r = run('amd64', { STUB_AGY_VERSION: '9.9.9' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`expected agy ${VERSION}, got '9.9.9'`);
  });
});
