import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getInstallSlug } from '../../src/install-slug.js';
import { refreshInstalledSkills, type SkillsRefreshReport } from '../update-skills.js';
import {
  createCommandRunner,
  defaultServiceEnvironment,
  detectService,
  drainContainers,
  startService,
  stopService,
  verifyServiceHealth,
  type CommandRunner,
  type ServiceEnvironment,
  type ServiceHandle,
} from './service.js';

export type UpdatePhase = 'conflict' | 'prepared' | 'validated' | 'cutover' | 'complete' | 'rolled-back' | 'abandoned';

export interface UpdateRequirement {
  id: string;
  type: 'breaking-change' | 'external-component';
  description: string;
  source: string;
  status: 'pending' | 'succeeded' | 'failed';
  rollback?: string;
}

export interface SnapshotEntry {
  relativePath: string;
  existed: boolean;
}

export interface UpdateState {
  schema: 'nanoclaw-update/v1';
  id: string;
  phase: UpdatePhase;
  projectRoot: string;
  transactionRoot: string;
  stageRoot: string;
  stageBranch: string;
  upstreamRef: string;
  strategy: 'merge' | 'rebase' | 'cherry-pick';
  originalHead: string;
  targetHead?: string;
  backupBranch: string;
  backupTag: string;
  changedFiles: string[];
  requirements: UpdateRequirement[];
  skillRefresh?: SkillsRefreshReport;
  service?: ServiceHandle;
  snapshot?: SnapshotEntry[];
  validation?: string[];
  lastError?: string;
  createdAt: string;
  completedAt?: string;
  stageCleanedAt?: string;
}

export interface PruneReport {
  schema: 'nanoclaw-update-prune/v1';
  keepId: string;
  dryRun: boolean;
  removed: string[];
  retained: string[];
}

export interface UpdateRuntime {
  runner: CommandRunner;
  serviceEnv: ServiceEnvironment;
  detectService(projectRoot: string): ServiceHandle;
  stopService(handle: ServiceHandle): Promise<void>;
  drainContainers(projectRoot: string): Promise<void>;
  startService(handle: ServiceHandle, projectRoot: string): void;
  verifyHealth(handle: ServiceHandle, projectRoot: string): Promise<boolean>;
}

export function createUpdateRuntime(runner = createCommandRunner()): UpdateRuntime {
  const serviceEnv = defaultServiceEnvironment(runner);
  return {
    runner,
    serviceEnv,
    detectService: (root) => detectService(root, serviceEnv),
    stopService: (handle) => stopService(handle, serviceEnv),
    drainContainers: (root) => drainContainers(root, serviceEnv),
    startService: (handle, root) => startService(handle, root, serviceEnv),
    verifyHealth: (handle, root) => verifyServiceHealth(handle, root, serviceEnv),
  };
}

function git(runtime: UpdateRuntime, root: string, args: string[]): string {
  return runtime.runner.run('git', args, root);
}

function tryGit(runtime: UpdateRuntime, root: string, args: string[]): { ok: boolean; stdout: string } {
  return runtime.runner.tryRun('git', args, root);
}

export function defaultTransactionsRoot(projectRoot: string): string {
  if (process.env.NANOCLAW_UPDATE_DIR) return path.resolve(process.env.NANOCLAW_UPDATE_DIR);
  return path.join(path.dirname(projectRoot), '.nanoclaw-updates', getInstallSlug(projectRoot));
}

function statePath(transactionRoot: string): string {
  return path.join(transactionRoot, 'state.json');
}

function hasSafeStatePaths(state: UpdateState, projectRoot: string, transactionRoot: string, id: string): boolean {
  return (
    state.id === id &&
    path.resolve(state.projectRoot) === path.resolve(projectRoot) &&
    path.resolve(state.transactionRoot) === path.resolve(transactionRoot) &&
    path.resolve(state.stageRoot) === path.join(path.resolve(transactionRoot), 'worktree') &&
    state.stageBranch === `update-nanoclaw/${id}` &&
    /^backup\/pre-update-[0-9a-f]{8}-\d{14}-[0-9a-f]{8}$/.test(state.backupBranch) &&
    /^pre-update-[0-9a-f]{8}-\d{14}-[0-9a-f]{8}$/.test(state.backupTag)
  );
}

function saveState(state: UpdateState): void {
  fs.mkdirSync(state.transactionRoot, { recursive: true });
  const target = statePath(state.transactionRoot);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

export function loadState(projectRoot: string, id: string): UpdateState {
  const expectedTransactionRoot = path.join(defaultTransactionsRoot(path.resolve(projectRoot)), id);
  const target = statePath(expectedTransactionRoot);
  const state = JSON.parse(fs.readFileSync(target, 'utf8')) as UpdateState;
  if (state.schema !== 'nanoclaw-update/v1') throw new Error(`Unsupported update state in ${target}`);
  if (!hasSafeStatePaths(state, projectRoot, expectedTransactionRoot, id)) {
    throw new Error('Update state contains mismatched or unsafe paths');
  }
  return state;
}

function currentBranch(runtime: UpdateRuntime, root: string): string {
  const branch = git(runtime, root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) throw new Error('Update requires a named branch, not detached HEAD');
  return branch;
}

function assertClean(runtime: UpdateRuntime, root: string, what = 'Working tree'): void {
  if (git(runtime, root, ['status', '--porcelain'])) throw new Error(`${what} must be clean`);
}

function requirementId(type: UpdateRequirement['type'], source: string): string {
  return `${type}-${createHash('sha256').update(source).digest('hex').slice(0, 10)}`;
}

function breakingRequirements(runtime: UpdateRuntime, root: string, from: string, to: string): UpdateRequirement[] {
  const diff = git(runtime, root, ['diff', '--unified=0', from, to, '--', 'CHANGELOG.md']);
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++') && line.includes('[BREAKING]'))
    .map((line) => line.slice(1).trim())
    .map((description) => ({
      id: requirementId('breaking-change', description),
      type: 'breaking-change' as const,
      description,
      source: 'CHANGELOG.md',
      status: 'pending' as const,
    }));
}

function jsonAt(runtime: UpdateRuntime, root: string, rev: string, file: string): Record<string, unknown> {
  const result = tryGit(runtime, root, ['show', `${rev}:${file}`]);
  if (!result.ok || !result.stdout) return {};
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function externalRequirements(runtime: UpdateRuntime, root: string, from: string, to: string): UpdateRequirement[] {
  const before = jsonAt(runtime, root, from, 'versions.json');
  const after = jsonAt(runtime, root, to, 'versions.json');
  return ['onecli-gateway', 'onecli-cli']
    .filter((name) => before[name] !== after[name])
    .map((name) => {
      const description = `${name}: ${String(before[name] ?? 'absent')} → ${String(after[name] ?? 'absent')}`;
      return {
        id: requirementId('external-component', description),
        type: 'external-component' as const,
        description,
        source: 'docs/onecli-upgrades.md',
        status: 'pending' as const,
        rollback: `Restore ${name} to ${String(before[name] ?? 'the previously installed version')}`,
      };
    });
}

function refreshPreparedState(state: UpdateState, runtime: UpdateRuntime): void {
  assertClean(runtime, state.stageRoot, 'Staging worktree');
  state.targetHead = git(runtime, state.stageRoot, ['rev-parse', 'HEAD']);
  state.changedFiles = git(runtime, state.stageRoot, ['diff', '--name-only', state.originalHead, state.targetHead])
    .split('\n')
    .filter(Boolean);
  state.requirements = [
    ...breakingRequirements(runtime, state.stageRoot, state.originalHead, state.targetHead),
    ...externalRequirements(runtime, state.stageRoot, state.originalHead, state.targetHead),
  ];
  state.phase = 'prepared';
  state.lastError = undefined;
  saveState(state);
}

export interface PrepareOptions {
  projectRoot: string;
  upstreamRef: string;
  strategy?: UpdateState['strategy'];
  commits?: string[];
}

export function prepareUpdate(options: PrepareOptions, runtime = createUpdateRuntime()): UpdateState {
  const projectRoot = fs.realpathSync(options.projectRoot);
  assertClean(runtime, projectRoot);
  currentBranch(runtime, projectRoot);
  git(runtime, projectRoot, ['rev-parse', '--verify', options.upstreamRef]);

  const originalHead = git(runtime, projectRoot, ['rev-parse', 'HEAD']);
  const short = originalHead.slice(0, 8);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  const id = `${stamp}-${short}-${randomUUID().slice(0, 8)}`;
  const transactionRoot = path.join(defaultTransactionsRoot(projectRoot), id);
  const stageRoot = path.join(transactionRoot, 'worktree');
  const stageBranch = `update-nanoclaw/${id}`;
  const unique = id.slice(-8);
  const backupBranch = `backup/pre-update-${short}-${stamp}-${unique}`;
  const backupTag = `pre-update-${short}-${stamp}-${unique}`;
  const strategy = options.strategy ?? 'merge';

  fs.mkdirSync(transactionRoot, { recursive: true });
  git(runtime, projectRoot, ['branch', backupBranch, originalHead]);
  git(runtime, projectRoot, ['tag', backupTag, originalHead]);
  git(runtime, projectRoot, ['worktree', 'add', '-b', stageBranch, stageRoot, originalHead]);

  const state: UpdateState = {
    schema: 'nanoclaw-update/v1',
    id,
    phase: 'prepared',
    projectRoot,
    transactionRoot,
    stageRoot,
    stageBranch,
    upstreamRef: options.upstreamRef,
    strategy,
    originalHead,
    backupBranch,
    backupTag,
    changedFiles: [],
    requirements: [],
    createdAt: new Date().toISOString(),
  };
  saveState(state);

  let applied: { ok: boolean; stdout: string };
  if (strategy === 'merge') {
    applied = tryGit(runtime, stageRoot, ['merge', '--no-edit', options.upstreamRef]);
  } else if (strategy === 'rebase') {
    applied = tryGit(runtime, stageRoot, ['rebase', options.upstreamRef]);
  } else {
    if (!options.commits?.length) throw new Error('Cherry-pick strategy requires at least one commit');
    applied = tryGit(runtime, stageRoot, ['cherry-pick', ...options.commits]);
  }

  if (!applied.ok) {
    state.phase = 'conflict';
    state.lastError = applied.stdout || `${strategy} needs conflict resolution`;
    saveState(state);
    return state;
  }
  refreshPreparedState(state, runtime);
  return state;
}

export function resumePreparedUpdate(projectRoot: string, id: string, runtime = createUpdateRuntime()): UpdateState {
  const state = loadState(projectRoot, id);
  if (state.phase !== 'conflict' && state.phase !== 'prepared') throw new Error(`Cannot resume from ${state.phase}`);
  refreshPreparedState(state, runtime);
  return state;
}

function commitStageChanges(state: UpdateState, runtime: UpdateRuntime, message: string): void {
  if (!git(runtime, state.stageRoot, ['status', '--porcelain'])) return;
  git(runtime, state.stageRoot, ['add', '--all']);
  git(runtime, state.stageRoot, ['commit', '-m', message]);
}

function hasChanged(state: UpdateState, prefix: string): boolean {
  return state.changedFiles.some((file) => file === prefix || file.startsWith(`${prefix}/`));
}

export async function validateUpdate(
  projectRoot: string,
  id: string,
  runtime = createUpdateRuntime(),
): Promise<UpdateState> {
  const state = loadState(projectRoot, id);
  if (state.phase !== 'prepared' && state.phase !== 'validated') throw new Error(`Cannot validate from ${state.phase}`);
  assertClean(runtime, state.stageRoot, 'Staging worktree');

  try {
    state.skillRefresh = await refreshInstalledSkills(state.stageRoot);
    if (!state.skillRefresh.success) throw new Error('One or more installed skills failed to refresh');
    commitStageChanges(state, runtime, 'chore: refresh installed skill payloads');
    refreshPreparedState(state, runtime);

    const checks: string[] = [];
    runtime.runner.run('pnpm', ['install', '--frozen-lockfile'], state.stageRoot);
    checks.push('host dependencies');
    runtime.runner.run('pnpm', ['run', 'build'], state.stageRoot);
    checks.push('host build');
    runtime.runner.run('pnpm', ['test'], state.stageRoot);
    checks.push('host tests');

    if (hasChanged(state, 'container/agent-runner')) {
      if (runtime.runner.tryRun('bun', ['--version'], state.stageRoot).ok) {
        runtime.runner.run(
          'bun',
          ['install', '--frozen-lockfile'],
          path.join(state.stageRoot, 'container/agent-runner'),
        );
        runtime.runner.run(
          'pnpm',
          ['exec', 'tsc', '-p', 'container/agent-runner/tsconfig.json', '--noEmit'],
          state.stageRoot,
        );
        checks.push('container dependencies and typecheck');
      } else {
        checks.push('container typecheck deferred to image build (Bun unavailable on host)');
      }
    }

    state.validation = checks;
    state.phase = 'validated';
    state.lastError = undefined;
    saveState(state);
    return state;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    saveState(state);
    throw err;
  }
}

const MUTABLE_PATHS = ['.env', 'data', 'groups', 'store', 'start-nanoclaw.sh', 'nanoclaw.pid'];

function copyEntry(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: stat.mode });
    for (const entry of fs.readdirSync(source)) copyEntry(path.join(source, entry), path.join(destination, entry));
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
  } else if (stat.isFile()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode);
  }
  // Sockets and other ephemeral special files are intentionally omitted.
}

function createSnapshot(state: UpdateState): SnapshotEntry[] {
  const snapshotRoot = path.join(state.transactionRoot, 'snapshot');
  fs.mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const bytesNeeded = MUTABLE_PATHS.reduce((total, relativePath) => {
    const source = path.join(state.projectRoot, relativePath);
    return total + (fs.existsSync(source) ? entrySize(source) : 0);
  }, 0);
  const disk = fs.statfsSync(snapshotRoot);
  const bytesAvailable = Number(disk.bavail) * Number(disk.bsize);
  const reserve = 256 * 1024 * 1024;
  if (bytesAvailable < bytesNeeded + reserve) {
    throw new Error(
      `Not enough free space for mutable-state snapshot: need ${bytesNeeded + reserve}, have ${bytesAvailable}`,
    );
  }
  return MUTABLE_PATHS.map((relativePath) => {
    const source = path.join(state.projectRoot, relativePath);
    const existed = fs.existsSync(source);
    if (existed) copyEntry(source, path.join(snapshotRoot, relativePath));
    return { relativePath, existed };
  });
}

function entrySize(source: string): number {
  const stat = fs.lstatSync(source);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return fs.readdirSync(source).reduce((total, entry) => total + entrySize(path.join(source, entry)), 0);
}

function restoreSnapshot(state: UpdateState): void {
  if (!state.snapshot) throw new Error('No mutable-state snapshot exists');
  const snapshotRoot = path.join(state.transactionRoot, 'snapshot');
  for (const entry of state.snapshot) {
    const target = path.join(state.projectRoot, entry.relativePath);
    fs.rmSync(target, { recursive: true, force: true });
    if (entry.existed) copyEntry(path.join(snapshotRoot, entry.relativePath), target);
  }
}

function installAndBuild(root: string, state: UpdateState, runtime: UpdateRuntime): void {
  runtime.runner.run('pnpm', ['install', '--frozen-lockfile'], root);
  runtime.runner.run('pnpm', ['run', 'build'], root);
  if (hasChanged(state, 'container')) {
    const hardened =
      fs.existsSync(path.join(root, '.env')) &&
      /^NANOCLAW_HARDENED_IMAGE=true$/m.test(fs.readFileSync(path.join(root, '.env'), 'utf8'));
    runtime.runner.run('bash', ['container/build.sh', ...(hardened ? ['pull'] : [])], root);
  }
}

async function rollbackLocal(state: UpdateState, runtime: UpdateRuntime): Promise<void> {
  if (!state.service) throw new Error('Update state has no captured service handle for rollback');
  await runtime.stopService(state.service);
  git(runtime, state.projectRoot, ['reset', '--hard', state.originalHead]);
  restoreSnapshot(state);
  installAndBuild(state.projectRoot, state, runtime);
  if (state.service?.active) {
    runtime.startService(state.service, state.projectRoot);
    if (!(await runtime.verifyHealth(state.service, state.projectRoot))) {
      throw new Error('Rollback restored code and state, but the previous service failed health verification');
    }
  }
  state.phase = 'rolled-back';
  state.completedAt = new Date().toISOString();
  saveState(state);
}

export async function cutoverUpdate(
  projectRoot: string,
  id: string,
  runtime = createUpdateRuntime(),
): Promise<UpdateState> {
  const state = loadState(projectRoot, id);
  if (state.phase !== 'validated') throw new Error(`Cannot cut over from ${state.phase}`);
  if (!state.targetHead) throw new Error('Validated update has no target commit');
  assertClean(runtime, state.projectRoot);
  if (git(runtime, state.projectRoot, ['rev-parse', 'HEAD']) !== state.originalHead) {
    throw new Error('Live checkout moved after the update was staged');
  }

  state.service = runtime.detectService(state.projectRoot);
  await runtime.stopService(state.service);
  try {
    await runtime.drainContainers(state.projectRoot);
    state.snapshot = createSnapshot(state);
    saveState(state);
    git(runtime, state.projectRoot, ['reset', '--hard', state.targetHead]);
    installAndBuild(state.projectRoot, state, runtime);
    state.phase = 'cutover';
    state.lastError = undefined;
    saveState(state);
    return state;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    saveState(state);
    if (state.snapshot) await rollbackLocal(state, runtime);
    else if (state.service.active) runtime.startService(state.service, state.projectRoot);
    throw err;
  }
}

export function acknowledgeRequirement(
  projectRoot: string,
  id: string,
  requirementIdValue: string,
  status: 'succeeded' | 'failed',
  rollback: string | undefined,
): UpdateState {
  const state = loadState(projectRoot, id);
  if (state.phase !== 'cutover') throw new Error(`Cannot acknowledge requirements from ${state.phase}`);
  const requirement = state.requirements.find((item) => item.id === requirementIdValue);
  if (!requirement) throw new Error(`Unknown requirement: ${requirementIdValue}`);
  if (requirement.type === 'external-component' && status === 'succeeded' && !rollback && !requirement.rollback) {
    throw new Error(`External requirement ${requirementIdValue} needs an exact rollback instruction`);
  }
  requirement.status = status;
  if (rollback) requirement.rollback = rollback;
  saveState(state);
  return state;
}

export async function finishUpdate(
  projectRoot: string,
  id: string,
  runtime = createUpdateRuntime(),
): Promise<UpdateState> {
  const state = loadState(projectRoot, id);
  if (state.phase !== 'cutover') throw new Error(`Cannot finish from ${state.phase}`);
  const unresolved = state.requirements.filter((requirement) => requirement.status !== 'succeeded');
  if (unresolved.length > 0) throw new Error(`Unresolved migrations: ${unresolved.map((item) => item.id).join(', ')}`);
  assertClean(runtime, state.projectRoot, 'Cut-over checkout');
  state.targetHead = git(runtime, state.projectRoot, ['rev-parse', 'HEAD']);
  state.changedFiles = git(runtime, state.projectRoot, ['diff', '--name-only', state.originalHead, state.targetHead])
    .split('\n')
    .filter(Boolean);
  saveState(state);

  try {
    runtime.runner.run(
      'pnpm',
      ['exec', 'tsx', 'scripts/upgrade-state.ts', 'set', '', 'update-nanoclaw'],
      state.projectRoot,
    );
    if (state.service?.active) {
      runtime.startService(state.service, state.projectRoot);
      if (!(await runtime.verifyHealth(state.service, state.projectRoot))) {
        throw new Error('Updated service failed process/socket/CLI health verification');
      }
    }
    state.phase = 'complete';
    state.completedAt = new Date().toISOString();
    state.lastError = undefined;
    saveState(state);
    return state;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    saveState(state);
    await rollbackLocal(state, runtime);
    throw err;
  }
}

export async function rollbackUpdate(
  projectRoot: string,
  id: string,
  runtime = createUpdateRuntime(),
): Promise<UpdateState> {
  const state = loadState(projectRoot, id);
  if (!state.snapshot) throw new Error('This update has no mutable-state snapshot to restore');
  await rollbackLocal(state, runtime);
  return state;
}

function removeStageArtifacts(state: UpdateState, runtime: UpdateRuntime): void {
  const remove = tryGit(runtime, state.projectRoot, ['worktree', 'remove', '--force', state.stageRoot]);
  if (!remove.ok) {
    if (fs.existsSync(state.stageRoot)) throw new Error(`Could not remove staging worktree: ${remove.stdout}`);
    tryGit(runtime, state.projectRoot, ['worktree', 'prune']);
  }
  deleteBranch(runtime, state.projectRoot, state.stageBranch);
}

function deleteBranch(runtime: UpdateRuntime, projectRoot: string, branch: string): void {
  tryGit(runtime, projectRoot, ['branch', '-D', branch]);
  if (tryGit(runtime, projectRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]).ok) {
    throw new Error(`Could not remove update branch: ${branch}`);
  }
}

function deleteTag(runtime: UpdateRuntime, projectRoot: string, tag: string): void {
  tryGit(runtime, projectRoot, ['tag', '-d', tag]);
  if (tryGit(runtime, projectRoot, ['rev-parse', '--verify', `refs/tags/${tag}`]).ok) {
    throw new Error(`Could not remove update tag: ${tag}`);
  }
}

export function cleanupUpdate(projectRoot: string, id: string, runtime = createUpdateRuntime()): UpdateState {
  const state = loadState(projectRoot, id);
  if (state.phase !== 'complete' && state.phase !== 'rolled-back') {
    throw new Error(`Cannot clean staging artifacts from ${state.phase}`);
  }
  removeStageArtifacts(state, runtime);
  state.stageCleanedAt = new Date().toISOString();
  saveState(state);
  return state;
}

export function pruneTransactions(
  projectRoot: string,
  keepId: string,
  dryRun: boolean,
  runtime = createUpdateRuntime(),
): PruneReport {
  const resolvedProjectRoot = fs.realpathSync(projectRoot);
  const root = path.resolve(defaultTransactionsRoot(resolvedProjectRoot));
  const filesystemRoot = path.parse(root).root;
  if (root === filesystemRoot || root === resolvedProjectRoot || resolvedProjectRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe transaction root: ${root}`);
  }
  const keep = loadState(resolvedProjectRoot, keepId);
  const terminal = new Set<UpdatePhase>(['complete', 'rolled-back', 'abandoned']);
  const removed: string[] = [];
  const retained: string[] = [];

  for (const id of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
    const transactionRoot = path.join(root, id);
    if (!fs.lstatSync(transactionRoot).isDirectory()) continue;
    let state: UpdateState;
    try {
      state = JSON.parse(fs.readFileSync(statePath(transactionRoot), 'utf8')) as UpdateState;
    } catch {
      retained.push(id);
      continue;
    }
    const valid =
      state.schema === 'nanoclaw-update/v1' &&
      hasSafeStatePaths(state, resolvedProjectRoot, transactionRoot, id);
    const olderThanKeep = Date.parse(state.createdAt) < Date.parse(keep.createdAt);
    if (!valid || id === keepId || !terminal.has(state.phase) || !olderThanKeep) {
      retained.push(id);
      continue;
    }
    removed.push(id);
    if (dryRun) continue;
    removeStageArtifacts(state, runtime);
    if (state.backupBranch !== keep.backupBranch) {
      deleteBranch(runtime, state.projectRoot, state.backupBranch);
    }
    if (state.backupTag !== keep.backupTag) {
      deleteTag(runtime, state.projectRoot, state.backupTag);
    }
    fs.rmSync(transactionRoot, { recursive: true, force: true });
  }

  return { schema: 'nanoclaw-update-prune/v1', keepId, dryRun, removed, retained };
}

export function abandonUpdate(projectRoot: string, id: string, runtime = createUpdateRuntime()): UpdateState {
  const state = loadState(projectRoot, id);
  if (!['conflict', 'prepared', 'validated'].includes(state.phase)) {
    throw new Error(`Cannot abandon an update after cutover (${state.phase})`);
  }
  removeStageArtifacts(state, runtime);
  deleteBranch(runtime, state.projectRoot, state.backupBranch);
  deleteTag(runtime, state.projectRoot, state.backupTag);
  state.phase = 'abandoned';
  state.completedAt = new Date().toISOString();
  saveState(state);
  return state;
}

export function summarizeState(state: UpdateState): Record<string, unknown> {
  return {
    schema: state.schema,
    id: state.id,
    phase: state.phase,
    originalHead: state.originalHead,
    targetHead: state.targetHead,
    upstreamRef: state.upstreamRef,
    backupBranch: state.backupBranch,
    backupTag: state.backupTag,
    stageRoot: state.stageRoot,
    stageCleanedAt: state.stageCleanedAt,
    changedFiles: state.changedFiles,
    requirements: state.requirements,
    skillRefresh: state.skillRefresh,
    service: state.service,
    validation: state.validation,
    lastError: state.lastError,
    rollback: state.snapshot ? `pnpm exec tsx scripts/update-nanoclaw.ts rollback --id ${state.id}` : undefined,
  };
}
