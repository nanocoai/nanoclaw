/**
 * The /update-nanoclaw controller runs from a `git archive` extract in a temp
 * dir, and every command after `prepare` runs before the stage has
 * node_modules (validate is what installs them). So the controller's static
 * import graph must stay inside the archived paths and import no packages, and
 * the setup/ helpers it loads from the stage must import no packages either.
 *
 * The archived paths are a contract with every installed copy of the skill:
 * an operator's older SKILL.md extracts its own list from the newest ref. So
 * this checks both the list SKILL.md has now and the list older copies use.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { loadGatewayModules } from './transaction.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SKILL = path.join(REPO_ROOT, '.claude/skills/update-nanoclaw/SKILL.md');
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules/tsx/dist/loader.mjs');
const CONTROLLER = 'scripts/update-nanoclaw.ts';
// What installed copies of the skill extract (since the whole-scripts/ fix).
const INSTALLED_SKILL_ARCHIVE = ['scripts', 'src/install-slug.ts'];
// The stage is a full checkout; these trees stand in for it.
const STAGE_TREES = ['scripts', 'setup', 'src'];
const STAGED_GATEWAY_MODULES = ['setup/gateways/refresh.ts', 'setup/gateways/selection.ts', 'setup/set-env.ts'];
const MODULE_NOT_FOUND = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  // Canonical path, as SKILL.md does with `pwd -P`.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitEnv(): NodeJS.ProcessEnv {
  // Keep the operator's global config (signing, hooks) out of fixture commits,
  // and background maintenance off: the seed commit writes enough loose objects
  // to start a detached repack that races the local clones below.
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'maintenance.auto',
    GIT_CONFIG_VALUE_0: 'false',
  };
}

/** The pathspecs of SKILL.md's `git archive "$upstream_ref" … | tar -x -C "$controller_dir"`. */
function archivedPaths(): string[] {
  const match = fs
    .readFileSync(SKILL, 'utf8')
    .match(/^git archive "\$upstream_ref" (.+?) \| tar -x -C "\$controller_dir"$/m);
  if (!match) throw new Error('SKILL.md no longer contains the controller archive command');
  return match[1].trim().split(/\s+/);
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

function assertNoNodeModulesAbove(dir: string): void {
  for (let current = dir; ; current = path.dirname(current)) {
    expect(fs.existsSync(path.join(current, 'node_modules')), `${current}/node_modules`).toBe(false);
    if (path.dirname(current) === current) return;
  }
}

/** Every module specifier a file loads at runtime, including literal dynamic imports. */
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      specifiers.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      specifiers.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** Walk each entry's graph inside the extract; report anything it cannot load there. */
function unloadableImports(root: string, entries: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      const from = path.relative(root, file);
      if (!specifier.startsWith('.')) {
        if (!isBuiltin(specifier)) problems.push(`${from} imports package ${specifier}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier);
      const candidate = [target.replace(/\.js$/, '.ts'), target].find((p) => fs.existsSync(p));
      if (!candidate) problems.push(`${from} imports ${specifier}, which is not in the archive`);
      else if (/\.[cm]?[jt]s$/.test(candidate)) walk(candidate);
    }
  };
  for (const entry of entries) walk(path.join(root, entry));
  return problems;
}

/** Run the controller the way SKILL.md does: tsx from the live install, the script by absolute path. */
function runController(script: string, args: string[], cwd: string, updateDir: string) {
  return spawnSync(process.execPath, ['--import', TSX_LOADER, script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...gitEnv(), NANOCLAW_UPDATE_DIR: updateDir },
  });
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function commit(root: string, message: string): void {
  git(root, ['add', '--all']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
}

const ARCHIVES: [string, () => string[]][] = [
  ['the SKILL.md archive', archivedPaths],
  ['the archive installed skills use', () => INSTALLED_SKILL_ARCHIVE],
];

// Each case spawns tsx cold on a few hundred modules; allow for a loaded CI box.
describe('update-nanoclaw controller archive', { timeout: 60_000 }, () => {
  describe.each(ARCHIVES)('%s', (_name, paths) => {
    it('holds every module the controller imports, and none of them is a package', () => {
      const controller = temp('ctrl-archive-controller-');
      extract(controller, paths());

      expect(unloadableImports(controller, [CONTROLLER])).toEqual([]);
    });

    it('loads and runs the controller with no node_modules', () => {
      const controller = temp('ctrl-archive-controller-');
      extract(controller, paths());
      assertNoNodeModulesAbove(controller);
      const install = temp('ctrl-archive-install-');

      const result = runController(
        path.join(controller, CONTROLLER),
        ['status', '--project-root', install, '--id', 'missing'],
        install,
        temp('ctrl-archive-update-state-'),
      );

      // A domain error from loadState proves the whole static graph loaded.
      expect(result.stderr).not.toMatch(MODULE_NOT_FOUND);
      expect(result.stderr).toContain('nanoclaw-update-error/v1');
      expect(result.status).toBe(1);
    });
  });

  it('loads the gateway helpers from a stage that has no node_modules', () => {
    const stage = temp('ctrl-archive-stage-');
    extract(stage, STAGE_TREES);
    assertNoNodeModulesAbove(stage);
    expect(unloadableImports(stage, STAGED_GATEWAY_MODULES)).toEqual([]);

    const controller = temp('ctrl-archive-controller-');
    extract(controller, INSTALLED_SKILL_ARCHIVE);
    const transaction = pathToFileURL(path.join(controller, 'scripts/update/transaction.ts')).href;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        TSX_LOADER,
        '--input-type=module',
        '--eval',
        `// No package.json in the extract, so tsx loads it as CommonJS.
         const loaded = await import(${JSON.stringify(transaction)});
         const { loadGatewayModules } = loaded.loadGatewayModules ? loaded : loaded.default;
         const modules = await loadGatewayModules(${JSON.stringify(stage)});
         console.log(Object.entries(modules).map(([name, fn]) => name + ':' + typeof fn).sort().join(','));`,
      ],
      { cwd: stage, encoding: 'utf8' },
    );

    expect(result.stderr).not.toMatch(MODULE_NOT_FOUND);
    expect(result.stdout.trim(), result.stderr).toBe(
      'refreshGateway:function,resolveGatewaySelection:function,upsertEnvVar:function',
    );
  });

  it('names the missing module when a cherry-pick stage predates the gateway helpers', async () => {
    const stage = temp('ctrl-archive-stage-');

    await expect(loadGatewayModules(stage)).rejects.toThrow(
      `${stage} has no setup/gateways/refresh.ts; include the commit that adds it, or update with merge or rebase`,
    );
  });

  it('prepares to a conflict, then resumes from the controller or the stage before either has dependencies', () => {
    const controller = temp('ctrl-archive-controller-');
    extract(controller, INSTALLED_SKILL_ARCHIVE);
    assertNoNodeModulesAbove(controller);
    const updateDir = temp('ctrl-archive-update-state-');

    // An official repo carrying these sources, and an install that customized
    // the same line upstream later changes.
    const seed = temp('ctrl-archive-seed-');
    extract(seed, STAGE_TREES);
    write(seed, 'package.json', '{"name":"nanoclaw-test","version":"2.4.0"}\n');
    write(seed, '.gitignore', 'data/\n.env\nnode_modules\n');
    write(seed, 'NOTES.md', 'base\n');
    git(seed, ['init', '-q', '-b', 'main']);
    commit(seed, 'base');
    const official = path.join(temp('ctrl-archive-official-'), 'official.git');
    git(path.dirname(official), ['clone', '-q', '--bare', seed, official]);
    const install = path.join(temp('ctrl-archive-install-'), 'install');
    git(path.dirname(install), ['clone', '-q', official, install]);
    git(install, ['remote', 'add', 'upstream', official]);
    git(install, ['config', 'user.name', 'Test']);
    git(install, ['config', 'user.email', 'test@example.com']);
    write(install, 'NOTES.md', 'local\n');
    commit(install, 'local customization');
    write(seed, 'NOTES.md', 'upstream\n');
    commit(seed, 'upstream change');
    git(seed, ['push', '-q', official, 'main']);
    git(install, ['fetch', '-q', 'upstream']);

    const prepared = runController(
      path.join(controller, CONTROLLER),
      ['prepare', '--project-root', install, '--upstream-ref', 'upstream/main', '--strategy', 'merge'],
      install,
      updateDir,
    );
    expect(prepared.stderr).not.toMatch(MODULE_NOT_FOUND);
    expect(prepared.status, prepared.stderr).toBe(2);
    const conflict = JSON.parse(prepared.stdout) as { id: string; phase: string; stageRoot: string };
    expect(conflict.phase).toBe('conflict');
    expect(fs.existsSync(path.join(conflict.stageRoot, 'node_modules'))).toBe(false);

    write(conflict.stageRoot, 'NOTES.md', 'local and upstream\n');
    git(conflict.stageRoot, ['add', 'NOTES.md']);
    git(conflict.stageRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--no-edit']);

    // The current SKILL.md resumes from the controller; older copies from the stage.
    for (const root of [controller, conflict.stageRoot]) {
      const resumed = runController(
        path.join(root, CONTROLLER),
        ['resume', '--project-root', install, '--id', conflict.id],
        install,
        updateDir,
      );
      expect(resumed.stderr).not.toMatch(MODULE_NOT_FOUND);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(JSON.parse(resumed.stdout)).toMatchObject({ id: conflict.id, phase: 'prepared' });
    }
  });
});
