/**
 * Cutover's install swaps node_modules under the running controller, and the
 * esbuild tsx started with refuses a binary of another version, so the
 * controller must load everything before that install. This runs it as SKILL.md
 * does, with an esbuild that stops working once the install ran.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
// What installed copies of the skill extract (see controller-archive.test.ts).
const CONTROLLER_ARCHIVE = ['scripts', 'src/install-slug.ts'];
// The gateway helpers cutover loads (loadGatewayModules), and the barrel the test gateway appends to.
const INSTALL_FILES = [
  'setup/gateways/catalog.ts',
  'setup/gateways/selection.ts',
  'setup/set-env.ts',
  'src/gateway-providers/installed.ts',
];
const GATEWAY_SKILL = '.claude/skills/add-test-gateway';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function gitEnv(): NodeJS.ProcessEnv {
  // Same isolation as controller-archive.test.ts: no operator config, no background repack.
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'maintenance.auto',
    GIT_CONFIG_VALUE_0: 'false',
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function commit(root: string, message: string): void {
  git(root, ['add', '--all']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
}

/** What `git archive <this tree> <paths>` would hold: tracked plus not-yet-committed files. */
function extract(into: string, paths: string[]): void {
  const files = git(REPO_ROOT, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths])
    .split('\0')
    .filter(Boolean);
  for (const rel of files) {
    const source = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(source)) continue; // deleted in the working tree
    fs.mkdirSync(path.dirname(path.join(into, rel)), { recursive: true });
    fs.copyFileSync(source, path.join(into, rel));
  }
}

/** Copy files and everything they import by relative path; the helpers import no packages. */
function copyWithImports(into: string, files: string[]): void {
  const queue = [...files];
  for (const seen = new Set<string>(); queue.length > 0; ) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    write(into, rel, source);
    const code = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
    for (const [, spec] of code.matchAll(/(?:from|import) '(\.\.?\/[^']+)\.js'/g)) {
      queue.push(path.join(path.dirname(rel), `${spec}.ts`));
    }
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function script(dir: string, name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
  return file;
}

/** The native binary behind the esbuild that tsx loads. */
function esbuildBinary(): string {
  // pnpm keeps a package's dependencies beside its real directory, not under the link.
  const fromTsx = createRequire(fs.realpathSync(path.join(REPO_ROOT, 'node_modules/tsx/package.json')));
  const fromEsbuild = createRequire(fromTsx.resolve('esbuild/package.json'));
  return fromEsbuild.resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
}

interface Harness {
  install: string;
  env: NodeJS.ProcessEnv;
  /** Created by the live install: node_modules, and so esbuild, changed. */
  swapped: string;
  /** One line per esbuild start: before-install or after-install. */
  starts: string;
  /** Running esbuild services, which the live install stops. */
  pids: string;
}

/** An install with a detectable gateway, and an upstream update that touches gateway code. */
function createHarness(): Harness {
  const seed = temp('toolchain-seed-');
  copyWithImports(seed, INSTALL_FILES);
  write(seed, 'package.json', '{"name":"nanoclaw-test","version":"2.4.0","type":"module"}\n');
  write(seed, '.gitignore', 'data/\n.env\nnode_modules\n');
  git(seed, ['init', '-q', '-b', 'main']);
  commit(seed, 'base');
  const official = path.join(temp('toolchain-official-'), 'official.git');
  git(path.dirname(official), ['clone', '-q', '--bare', seed, official]);
  const install = path.join(temp('toolchain-install-'), 'install');
  git(path.dirname(install), ['clone', '-q', official, install]);
  git(install, ['remote', 'add', 'upstream', official]);
  git(install, ['config', 'user.name', 'Test']);
  git(install, ['config', 'user.email', 'test@example.com']);
  write(install, '.env', 'TEST_GATEWAY_URL=http://127.0.0.1:1\n');
  write(install, 'data/v2.db', 'db\n');

  fs.appendFileSync(path.join(seed, 'src/gateway-providers/installed.ts'), '// upstream change\n');
  write(
    seed,
    `${GATEWAY_SKILL}/gateway.json`,
    '{"kind":"test-gateway","label":"Test gateway","description":"Gateway","default":true}\n',
  );
  write(
    seed,
    `${GATEWAY_SKILL}/SKILL.md`,
    [
      '---',
      'name: add-test-gateway',
      'description: Test gateway.',
      '---',
      '',
      '```nc:copy',
      'payload/src/gateway-providers/test-gateway.ts -> src/gateway-providers/test-gateway.ts',
      '```',
      '',
      '```nc:append to:src/gateway-providers/installed.ts',
      "import './test-gateway.js';",
      '```',
      '',
    ].join('\n'),
  );
  write(
    seed,
    `${GATEWAY_SKILL}/scripts/detect.ts`,
    "import fs from 'node:fs'; console.log(fs.readFileSync('.env', 'utf8').includes('TEST_GATEWAY_URL=') ? 'installed' : 'absent');\n",
  );
  write(seed, `${GATEWAY_SKILL}/payload/src/gateway-providers/test-gateway.ts`, "export const gateway = 'test';\n");
  commit(seed, 'upstream gateway change');
  git(seed, ['push', '-q', official, 'main']);
  git(install, ['fetch', '-q', 'upstream']);

  const bin = temp('toolchain-bin-');
  const swapped = path.join(bin, 'swapped');
  const starts = path.join(bin, 'esbuild-starts');
  const pids = path.join(bin, 'esbuild-pids');
  // The live install swaps node_modules and stops any esbuild started before it;
  // the gateway detector runs on plain node; build and test have nothing to do.
  script(bin, 'pnpm', [
    'case "$*" in',
    `  'install --frozen-lockfile') if [ "$(pwd -P)" = ${quote(install)} ]; then`,
    `    : > ${quote(swapped)}; [ -s ${quote(pids)} ] && kill $(cat ${quote(pids)}) 2>/dev/null; : > ${quote(pids)}`,
    '  fi ;;',
    `  '--silent exec tsx '*) for arg; do :; done; exec ${quote(process.execPath)} "$arg" ;;`,
    'esac',
    'exit 0',
  ]);
  script(bin, 'esbuild', [
    `if [ -e ${quote(swapped)} ]; then`,
    `  echo after-install >> ${quote(starts)}`,
    '  for arg; do case "$arg" in --service=*) host="${arg#--service=}" ;; esac; done',
    '  echo "Cannot start service: Host version \\"$host\\" does not match binary version \\"0.0.0-swapped\\"" >&2',
    '  exit 1',
    'fi',
    `echo before-install >> ${quote(starts)}`,
    `echo $$ >> ${quote(pids)}`,
    `exec ${quote(esbuildBinary())} "$@"`,
  ]);

  // An inherited NANOCLAW_INSTALL_ID would name a real install's service.
  const inherited = Object.entries(gitEnv()).filter(([key]) => !/^(NANOCLAW_|TSX_|NODE_OPTIONS$)/.test(key));
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(inherited),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    // No launchd or systemd definition to find, so no service to stop.
    HOME: temp('toolchain-home-'),
    // tsx's transform cache, shared by one update run's commands as in SKILL.md.
    TMPDIR: temp('toolchain-tmp-'),
    NANOCLAW_UPDATE_DIR: temp('toolchain-update-state-'),
    CONTAINER_RUNTIME: script(bin, 'docker', ['exit 0']),
    ESBUILD_BINARY_PATH: path.join(bin, 'esbuild'),
  };
  return { install, env, swapped, starts, pids };
}

/** As SKILL.md runs it: the live install's tsx, the controller from its own extract. */
function runController(controller: string, args: string[], harness: Harness) {
  return spawnSync(
    process.execPath,
    [TSX_CLI, path.join(controller, 'scripts/update-nanoclaw.ts'), ...args, '--project-root', harness.install],
    { cwd: harness.install, encoding: 'utf8', env: harness.env },
  );
}

// Several cold tsx starts over a few hundred modules; allow for a loaded CI box.
describe.skipIf(process.platform === 'win32')('update-nanoclaw across a toolchain change', { timeout: 120_000 }, () => {
  it('cuts over with a gateway selected when the install swaps esbuild', () => {
    const harness = createHarness();
    const controller = temp('toolchain-controller-');
    extract(controller, CONTROLLER_ARCHIVE);

    const prepared = runController(controller, ['prepare', '--upstream-ref', 'upstream/main'], harness);
    expect(prepared.status, prepared.stderr).toBe(0);
    const { id } = JSON.parse(prepared.stdout) as { id: string };
    const validated = runController(controller, ['validate', '--id', id], harness);
    expect(validated.status, validated.stderr).toBe(0);
    const statePath = path.join(harness.env.NANOCLAW_UPDATE_DIR!, id, 'state.json');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).gatewaySelection).toBe('test-gateway');

    fs.writeFileSync(harness.starts, '');
    fs.writeFileSync(harness.pids, '');
    const cutover = runController(controller, ['cutover', '--id', id], harness);

    expect(cutover.status, cutover.stderr).toBe(0);
    expect(JSON.parse(cutover.stdout)).toMatchObject({ id, phase: 'cutover' });
    expect(fs.existsSync(harness.swapped)).toBe(true);
    expect(fs.readFileSync(path.join(harness.install, '.env'), 'utf8')).toContain(
      'NANOCLAW_GATEWAY_PROVIDER=test-gateway',
    );
    // The gateway helpers compiled through this esbuild, and only before the install.
    const starts = fs.readFileSync(harness.starts, 'utf8').split('\n').filter(Boolean);
    expect(starts).toContain('before-install');
    expect(starts).not.toContain('after-install');
  });
});
