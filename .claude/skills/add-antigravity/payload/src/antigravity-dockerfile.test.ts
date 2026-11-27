/**
 * Structural guard for the Antigravity image reach-in.
 *
 * The Antigravity CLI (`agy`) is a native binary, not an npm package, so it
 * cannot live in container/cli-tools.json and nothing imports or typechecks
 * it. /add-antigravity inserts a block into container/Dockerfile, inside core's
 * `nanoclaw:provider-binaries` marker region, that runs
 * container/install-antigravity.sh, which downloads one pinned build and checks
 * its sha512. Drop the block on an upgrade (or lose the pins in the script) and
 * the image still builds; antigravity groups then fail on their first message
 * with `agy: not found`, or run whatever build Google published last. These
 * tests go red first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfilePath = join(root, 'container', 'Dockerfile');
const scriptPath = join(root, 'container', 'install-antigravity.sh');

/**
 * The Dockerfile as Docker reads it: comment lines dropped, backslash
 * continuations joined, one instruction per entry with whitespace collapsed.
 */
function instructions(text: string): string[] {
  return text
    .replace(/^\s*#.*$/gm, '')
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const BLOCK_MARKER = '# ---- Antigravity CLI (add-antigravity) ----';

const EXPECTED_BLOCK = [
  BLOCK_MARKER,
  'ARG AGY_VERSION=1.5.8',
  'COPY install-antigravity.sh /tmp/install-antigravity.sh',
  'RUN AGY_REQUESTED_VERSION="${AGY_VERSION}" sh /tmp/install-antigravity.sh && rm /tmp/install-antigravity.sh',
  'ENV AGY_CLI_DISABLE_AUTO_UPDATE=true',
];

describe('container/Dockerfile installs the Antigravity CLI', () => {
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const lines = dockerfile.split('\n').map((line) => line.trim());
  const at = (text: string): number => lines.findIndex((line) => line.includes(text));
  const blockStart = at(BLOCK_MARKER);
  const steps = instructions(dockerfile);

  it('carries the add-antigravity block, in order and unbroken', () => {
    expect(blockStart, 'the Antigravity block is missing from container/Dockerfile').toBeGreaterThanOrEqual(0);
    expect(lines.slice(blockStart, blockStart + EXPECTED_BLOCK.length)).toEqual(EXPECTED_BLOCK);
  });

  it('sits inside the provider-binaries region, where the build is still root', () => {
    // Other skills may add their own blocks to the region, before or after this one.
    const open = at('# >>> nanoclaw:provider-binaries');
    const close = at('# <<< nanoclaw:provider-binaries');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(open).toBeLessThan(blockStart);
    expect(close).toBeGreaterThanOrEqual(blockStart + EXPECTED_BLOCK.length);
    // No USER switch before the block: it installs into /usr/local/bin as root.
    expect(lines.slice(0, blockStart).filter((line) => /^USER\s/.test(line))).toEqual([]);
  });

  it("comes before core's switch to node and before the provenance labels", () => {
    const coreUser = lines.findIndex((line) => /^USER node$/.test(line));
    expect(coreUser).toBeGreaterThan(blockStart);
    // Below the labels' ARGs, a lockfile change would re-download agy.
    expect(at('# ---- Provenance labels')).toBeGreaterThan(blockStart);
    expect(at('ARG AGENT_RUNNER_LOCK_SHA256')).toBeGreaterThan(blockStart);
  });

  it('switches user nowhere in the block, so the image still ends as node', () => {
    const block = lines.slice(blockStart, blockStart + EXPECTED_BLOCK.length);
    expect(block.filter((line) => /^USER\s/.test(line))).toEqual([]);
    expect(steps.filter((step) => step.startsWith('USER ')).at(-1)).toBe('USER node');
  });

  it('installs into the final (only) stage', () => {
    const lastFrom = steps.map((step) => step.startsWith('FROM ')).lastIndexOf(true);
    expect(lastFrom).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(EXPECTED_BLOCK[3])).toBeGreaterThan(lastFrom);
  });
});

describe('container/install-antigravity.sh pins one verified build', () => {
  it('ships next to the Dockerfile, inside the build context', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';

  it('pins the same exact version the Dockerfile block asks for', () => {
    const pinned = script.match(/^AGY_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];
    expect(pinned).toBeDefined();
    expect(EXPECTED_BLOCK).toContain(`ARG AGY_VERSION=${pinned}`);
  });

  it('pins an exact version and execution id', () => {
    expect(script).toMatch(/^AGY_VERSION=\d+\.\d+\.\d+$/m);
    expect(script).toMatch(/^AGY_EXECUTION_ID=\d+$/m);
    expect(script).not.toMatch(/latest/i);
  });

  it('pins a distinct sha512 for amd64 and arm64 and verifies the download', () => {
    const amd64 = script.match(/^AGY_SHA512_AMD64=([0-9a-f]{128})$/m)?.[1];
    const arm64 = script.match(/^AGY_SHA512_ARM64=([0-9a-f]{128})$/m)?.[1];
    expect(amd64).toBeDefined();
    expect(arm64).toBeDefined();
    expect(amd64).not.toBe(arm64);
    expect(script).toContain('sha512sum -c');
  });

  it('downloads the pinned build from Google and installs it as agy', () => {
    expect(script).toContain(
      'https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}-${AGY_EXECUTION_ID}',
    );
    expect(script).toContain('AGY_INSTALL_DIR="${AGY_INSTALL_DIR:-/usr/local/bin}"');
    expect(script).toContain('install -m 0755 "$work/antigravity" "$AGY_INSTALL_DIR/agy"');
    expect(script).toContain('"$AGY_INSTALL_DIR/agy" --version');
  });
});
