/**
 * Removal-plan executor. Each action runs in its own try/catch: a failure
 * becomes a summary note and execution continues (re-running the
 * uninstaller is idempotent — the next scan only finds what's left).
 *
 * Must stay safe to run after logs/ and node_modules/ are gone: only static
 * imports, no dynamic import(), no setup-log writes. Output goes through
 * the injected `log` callback.
 */
import fs from 'fs';
import { createHash } from 'node:crypto';
import path from 'path';

import { listVaultAgents, type RunCommand } from './onecli-agents.js';
import type { RemovalAction } from './plan.js';
import { checkoutHostProcesses, isNanoclawHostCommand, pathIdentity } from './scan.js';

export type ActionOutcome = 'removed' | 'preserved' | 'failed' | 'untouched' | 'alreadyAbsent';

export type UninstallActionResult = {
  actionId: string;
  artifactId: string;
  outcome: ActionOutcome;
  error?: { code: string; message: string };
};

export interface ExecDeps {
  runCommand: RunCommand;
  log: (line: string) => void;
  /** True when running as root — required to remove a system-level unit. */
  isRoot: boolean;
  prerequisiteFailed?: boolean;
  prerequisiteError?: { code: string; message: string };
  onResult?: (result: UninstallActionResult) => void;
  killProcess?: (pid: number) => void;
  sleep?: (milliseconds: number) => void;
  processStopTimeoutMs?: number;
}

type IdentityResult = {
  outcome: 'failed' | 'untouched' | 'alreadyAbsent';
  error?: { code: string; message: string };
};

function missingExactPath(target: string): boolean {
  try {
    fs.lstatSync(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new IdentityRevalidationError({
      outcome: 'failed',
      error: { code: 'identity_check_failed', message: 'The exact filesystem target could not be checked.' },
    });
  }
}

class IdentityRevalidationError extends Error {
  constructor(readonly result: IdentityResult) {
    super(result.error?.message ?? 'The target identity changed during removal.');
  }
}

export function executePlan(
  actions: RemovalAction[],
  deps: ExecDeps,
): { notes: string[]; results: UninstallActionResult[]; prerequisiteFailed: boolean } {
  const notes: string[] = [];
  const results: UninstallActionResult[] = [];
  let prerequisiteFailed = deps.prerequisiteFailed === true;
  for (const action of actions) {
    let outcome: ActionOutcome = 'failed';
    let error: { code: string; message: string } | undefined;
    try {
      if (prerequisiteFailed && dependsOnStoppedService(action)) {
        outcome = 'untouched';
        error = deps.prerequisiteError ?? {
          code: 'service_prerequisite_failed',
          message: 'The service could not be stopped safely.',
        };
        notes.push(`${action.kind}: left untouched (${error.message})`);
      } else {
        const identity = verifyScopedRoot(action) ?? verifyExactIdentity(action, deps.runCommand);
        if (identity) {
          outcome = identity.outcome;
          error = identity.error;
        } else {
          outcome = runAction(action, deps, notes);
        }
      }
    } catch (err) {
      if (err instanceof IdentityRevalidationError) {
        outcome = err.result.outcome;
        error = err.result.error;
        notes.push(`${action.kind}: left untouched (${err.message}); re-run the uninstaller to rescan.`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`${action.kind}: failed (${msg}); re-run the uninstaller to retry.`);
        error = { code: 'action_failed', message: msg };
        outcome = 'failed';
      }
    }
    if (stopsService(action) && (outcome === 'failed' || outcome === 'untouched')) {
      prerequisiteFailed = true;
    }
    const result: UninstallActionResult = {
      actionId: actionId(action),
      artifactId: artifactId(action),
      outcome,
      ...(error ? { error } : {}),
    };
    results.push(result);
    deps.onResult?.(result);
  }
  return { notes, results, prerequisiteFailed };
}

export function artifactId(action: RemovalAction): string {
  return `artifact-${createHash('sha256').update(actionKey(action)).digest('hex').slice(0, 16)}`;
}

export function actionId(action: RemovalAction): string {
  return `remove-${createHash('sha256').update(actionKey(action)).digest('hex').slice(0, 16)}`;
}

/**
 * Copy .env aside before deletion. Never clobbers an existing backup —
 * falls back to a timestamped name on collision. Returns the backup path.
 */
export function backupEnv(envPath: string, backupRoot: string, expectedIdentity?: string): string {
  return backupEnvSecure(envPath, backupRoot, expectedIdentity);
}

/**
 * Copy an approved .env without following a symlink. The production plan
 * always supplies an external backupRoot. The root is explicit so no caller
 * can accidentally advertise a checkout-local credential backup.
 */
function backupEnvSecure(envPath: string, backupRoot: string, expectedIdentity = pathIdentity(envPath)): string {
  if (!expectedIdentity) throw new Error('credential backup source is unavailable');

  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (noFollow === undefined) throw new Error('credential backup source could not be opened safely');
  let sourceFd: number | undefined;
  let contents: Buffer;
  try {
    sourceFd = fs.openSync(envPath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(sourceFd);
    if (!stat.isFile()) throw new Error('credential backup source is not a regular file');
    contents = fs.readFileSync(sourceFd);
    const openedIdentity = `file:${stat.dev}:${stat.ino}:${createHash('sha256').update(contents).digest('hex')}`;
    if (openedIdentity !== expectedIdentity) {
      throw new IdentityRevalidationError({
        outcome: 'untouched',
        error: { code: 'identity_changed', message: 'The .env file changed before it could be backed up.' },
      });
    }
  } catch (error) {
    if (error instanceof IdentityRevalidationError) throw error;
    throw new Error('credential backup source could not be opened safely');
  } finally {
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
  }

  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(backupRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('credential backup directory is not a private directory');
  }
  fs.chmodSync(backupRoot, 0o700);

  const candidates = [
    path.join(backupRoot, '.env.bak'),
    ...Array.from({ length: 8 }, (_, index) => path.join(backupRoot, `.env.bak.${Date.now()}-${process.pid}-${index}`)),
  ];
  let backupPath: string | undefined;
  let backupFd: number | undefined;
  for (const candidate of candidates) {
    try {
      backupFd = fs.openSync(
        candidate,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      backupPath = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error('credential backup could not be created safely');
    }
  }
  if (!backupPath || backupFd === undefined) throw new Error('credential backup name is unavailable');
  try {
    fs.fchmodSync(backupFd, 0o600);
    fs.writeFileSync(backupFd, contents);
  } catch {
    try {
      fs.closeSync(backupFd);
    } catch {
      /* best effort cleanup */
    }
    try {
      fs.unlinkSync(backupPath);
    } catch {
      /* preserve the original on cleanup failure */
    }
    throw new Error('credential backup could not be written safely');
  }
  fs.closeSync(backupFd);

  // The source may have been replaced while the backup was being written.
  // Leave both the replacement and the approved backup untouched in that case.
  if (pathIdentity(envPath) !== expectedIdentity) {
    throw new IdentityRevalidationError({
      outcome: 'untouched',
      error: { code: 'identity_changed', message: 'The .env file changed before it could be removed.' },
    });
  }
  try {
    fs.unlinkSync(envPath);
  } catch {
    throw new Error('credential source could not be removed after backup');
  }
  return backupPath;
}

function runAction(action: RemovalAction, deps: ExecDeps, notes: string[]): ActionOutcome {
  const { runCommand, log } = deps;
  switch (action.kind) {
    case 'unload-service':
      switch (action.flavor) {
        case 'launchd':
          {
            const unloaded = runCommand('launchctl', ['unload', action.unitPath]);
            const alreadyStopped = /could not find|not loaded|no such process/i.test(
              `${unloaded.stdout}\n${unloaded.stderr ?? ''}`,
            );
            if (unloaded.status !== 0 && !alreadyStopped) {
              throw new Error('launchctl unload failed');
            }
          }
          removeApprovedServiceUnit(action, deps.runCommand);
          log('✓ background service removed');
          return 'removed';
        case 'systemd-user':
          requireSuccess(
            runCommand('systemctl', ['--user', 'disable', '--now', `${action.unitName}.service`]),
            'systemd user service stop failed',
          );
          removeApprovedServiceUnit(action, deps.runCommand);
          requireSuccess(runCommand('systemctl', ['--user', 'daemon-reload']), 'systemd user daemon-reload failed');
          log('✓ background service removed');
          return 'removed';
        case 'systemd-system':
          if (!deps.isRoot) {
            log('! system service needs root; left in place');
            notes.push(`System service ${action.unitPath}; re-run with sudo to remove.`);
            throw new Error(`System service ${action.unitPath} needs root.`);
          }
          requireSuccess(
            runCommand('systemctl', ['disable', '--now', `${action.unitName}.service`]),
            'system service stop failed',
          );
          removeApprovedServiceUnit(action, deps.runCommand);
          requireSuccess(runCommand('systemctl', ['daemon-reload']), 'system daemon-reload failed');
          log('✓ system service removed');
          return 'removed';
      }
    case 'kill-pid': {
      let pid = NaN;
      try {
        pid = Number(fs.readFileSync(action.pidFile, 'utf-8').trim());
      } catch {
        // pidfile already gone
      }
      if (Number.isInteger(pid) && pid > 0) {
        const current = processCommand(runCommand, pid);
        if (!current.available) throw new Error('could not verify the host process');
        if (current.command) {
          if (!isNanoclawHostCommand(current.command, action.processPattern)) {
            throw new Error('pidfile points to a process outside this checkout');
          }
          try {
            (deps.killProcess ?? ((target) => process.kill(target)))(pid);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
          }
          waitForStopped(() => {
            const state = processCommand(runCommand, pid);
            if (!state.available) throw new Error('could not verify that the host stopped');
            return !state.command;
          }, deps);
        }
      }
      fs.rmSync(action.pidFile, { force: true });
      log('✓ stopped host process');
      return 'removed';
    }
    case 'pkill-host': {
      const matching = checkoutProcesses(runCommand, action.pattern);
      if (matching.length === 0) return 'alreadyAbsent';
      for (const pid of matching) {
        try {
          (deps.killProcess ?? ((target) => process.kill(target)))(pid);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
      }
      waitForStopped(() => checkoutProcesses(runCommand, action.pattern).length === 0, deps);
      return 'removed';
    }
    case 'rm-containers': {
      // Re-list at removal time: the host was alive during the confirm
      // phase and may have spawned containers the scan never saw.
      const ps = runCommand(action.runtime, ['ps', '-aq', '--filter', `label=${action.labelFilter}`]);
      if (ps.status !== 0) {
        notes.push(
          `Containers: '${action.runtime}' unavailable — remove later with: ` +
            `${action.runtime} ps -aq --filter label=${action.labelFilter} | xargs -r ${action.runtime} rm -f`,
        );
        throw new Error(`'${action.runtime}' unavailable while listing approved containers`);
      }
      const ids = ps.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) return 'alreadyAbsent';
      requireSuccess(runCommand(action.runtime, ['rm', '-f', ...ids]), 'container removal failed');
      log(`✓ removed ${ids.length} container(s)`);
      return 'removed';
    }
    case 'rmi': {
      const res = runCommand(action.runtime, ['rmi', action.image]);
      if (res.status === 0) {
        log('✓ removed container image');
        return 'removed';
      } else {
        log('! could not remove image (in use?)');
        notes.push(`Image ${action.image}: not removed; retry with: ${action.runtime} rmi ${action.image}`);
      }
      throw new Error(`container image ${action.image} was not removed`);
    }
    case 'rm-ncl-symlink':
      fs.rmSync(action.linkPath, { force: true });
      log('✓ removed ncl command');
      return 'removed';
    case 'delete-onecli-agent': {
      const res = runCommand('onecli', ['agents', 'delete', '--id', action.agent.uuid]);
      if (res.status === 0) {
        log(`✓ deleted OneCLI agent ${action.agent.name} (${action.agent.identifier})`);
        return 'removed';
      } else if (res.status === null) {
        // spawn failure (binary gone since the scan), not a missing agent
        log(`! couldn't run onecli for ${action.agent.identifier}`);
        notes.push(
          `OneCLI agent ${action.agent.name} (${action.agent.identifier}): couldn't run onecli — ` +
            `delete manually with: onecli agents delete --id ${action.agent.uuid}`,
        );
        throw new Error('onecli could not be started');
      }
      throw new Error(`OneCLI agent ${action.agent.identifier} was not deleted`);
    }
    case 'backup-env': {
      let envStat: fs.Stats;
      try {
        envStat = fs.lstatSync(action.envPath);
      } catch {
        return 'alreadyAbsent';
      }
      if (!envStat.isFile()) {
        throw new IdentityRevalidationError({
          outcome: 'untouched',
          error: { code: 'identity_changed', message: 'The .env path is no longer a regular file.' },
        });
      }
      // Backup and removal are one action so a failed backup (which throws
      // into executePlan's catch) can never be followed by the deletion.
      if (!action.backupRoot) throw new Error('credential backup destination is unavailable');
      const backup = backupEnvSecure(action.envPath, action.backupRoot, action.expectedIdentity);
      log(`✓ removed .env (backup at ${backup})`);
      return 'removed';
    }
    case 'delete-path':
    case 'delete-runtime-path':
      if (!fs.existsSync(action.item.path)) return 'alreadyAbsent';
      fs.rmSync(action.item.path, { recursive: true, force: true });
      log(`✓ removed ${action.item.what}`);
      return 'removed';
  }
}

function actionKey(action: RemovalAction): string {
  switch (action.kind) {
    case 'unload-service':
      return `${action.kind}:${action.unitPath}`;
    case 'kill-pid':
      return `${action.kind}:${action.pidFile}:${action.processPattern}`;
    case 'pkill-host':
      return `${action.kind}:${action.pattern}`;
    case 'rm-containers':
      return `${action.kind}:${action.runtime}:${action.labelFilter}`;
    case 'rmi':
      return `${action.kind}:${action.runtime}:${action.image}`;
    case 'rm-ncl-symlink':
      return `${action.kind}:${action.linkPath}`;
    case 'delete-onecli-agent':
      return `${action.kind}:${action.agent.uuid}`;
    case 'backup-env':
      return `${action.kind}:${action.envPath}`;
    case 'delete-path':
    case 'delete-runtime-path':
      return `${action.kind}:${action.item.path}`;
  }
}

function stopsService(action: RemovalAction): boolean {
  return (
    action.kind === 'unload-service' ||
    action.kind === 'kill-pid' ||
    action.kind === 'pkill-host' ||
    action.kind === 'rm-containers'
  );
}

function dependsOnStoppedService(action: RemovalAction): boolean {
  return ['rm-containers', 'rmi', 'backup-env', 'delete-onecli-agent', 'delete-path', 'delete-runtime-path'].includes(
    action.kind,
  );
}

function verifyExactIdentity(action: RemovalAction, runCommand: RunCommand): IdentityResult | undefined {
  if (!('identityRequired' in action) || action.identityRequired !== true) return undefined;
  const expected = action.expectedIdentity;
  if (!expected) {
    return {
      outcome: 'untouched',
      error: { code: 'identity_uninspectable', message: 'The exact target identity could not be proven.' },
    };
  }
  if (action.kind === 'rmi') {
    const current = runCommand(action.runtime, ['image', 'inspect', action.image]);
    if (current.status === 1) return { outcome: 'alreadyAbsent' };
    if (current.status !== 0) {
      return {
        outcome: 'failed',
        error: { code: 'identity_check_failed', message: 'The container image identity could not be checked.' },
      };
    }
    if (current.stdout.trim() !== expected) {
      return {
        outcome: 'untouched',
        error: { code: 'identity_changed', message: 'The container image changed after approval.' },
      };
    }
    return undefined;
  }
  if (action.kind === 'delete-onecli-agent') {
    const current = listVaultAgents(runCommand);
    if (!current.available) {
      return {
        outcome: 'failed',
        error: { code: 'identity_check_failed', message: 'The OneCLI agent list could not be checked.' },
      };
    }
    const agent = current.agents.find((candidate) => candidate.uuid === action.agent.uuid);
    if (!agent) return { outcome: 'alreadyAbsent' };
    if (JSON.stringify(agent) !== expected) {
      return {
        outcome: 'untouched',
        error: { code: 'identity_changed', message: 'The OneCLI agent changed after approval.' },
      };
    }
    return undefined;
  }
  const target =
    action.kind === 'unload-service'
      ? action.unitPath
      : action.kind === 'kill-pid'
        ? action.pidFile
        : action.kind === 'backup-env'
          ? action.envPath
          : action.kind === 'delete-path' || action.kind === 'delete-runtime-path'
            ? action.item.path
            : action.linkPath;
  const current = pathIdentity(target);
  if (!current) {
    if (missingExactPath(target)) return { outcome: 'alreadyAbsent' };
    return {
      outcome: 'failed',
      error: { code: 'identity_check_failed', message: 'The exact filesystem target could not be checked.' },
    };
  }
  if (current !== expected) {
    return {
      outcome: 'untouched',
      error: { code: 'identity_changed', message: 'The exact filesystem target changed after approval.' },
    };
  }
  if (action.kind === 'kill-pid') {
    const pid = Number(fs.readFileSync(action.pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      const process = processCommand(runCommand, pid);
      if (!process.available) {
        return {
          outcome: 'failed',
          error: { code: 'identity_check_failed', message: 'The host process identity could not be checked.' },
        };
      }
      if (process.command && !isNanoclawHostCommand(process.command, action.processPattern)) {
        return {
          outcome: 'untouched',
          error: { code: 'identity_changed', message: 'The pidfile now points outside this checkout.' },
        };
      }
    }
  }
  return undefined;
}

function removeApprovedServiceUnit(
  action: Extract<RemovalAction, { kind: 'unload-service' }>,
  runCommand: RunCommand,
): void {
  const identity = verifyExactIdentity(action, runCommand);
  if (identity?.outcome === 'alreadyAbsent') return;
  if (identity) throw new IdentityRevalidationError(identity);
  fs.rmSync(action.unitPath, { force: true });
}

function verifyScopedRoot(
  action: RemovalAction,
): { outcome: 'untouched' | 'alreadyAbsent'; error?: { code: string; message: string } } | undefined {
  if ((action.kind !== 'delete-path' && action.kind !== 'delete-runtime-path') || !action.expectedRootIdentity) {
    return undefined;
  }
  const current = pathIdentity(action.item.path);
  if (!current) {
    if (missingExactPath(action.item.path)) return { outcome: 'alreadyAbsent' };
    return {
      outcome: 'untouched',
      error: { code: 'identity_check_failed', message: 'The checkout-owned root could not be checked.' },
    };
  }
  if (current !== action.expectedRootIdentity) {
    return {
      outcome: 'untouched',
      error: { code: 'ownership_root_changed', message: 'The approved checkout-owned root changed before removal.' },
    };
  }
  return undefined;
}

function processCommand(runCommand: RunCommand, pid: number): { available: boolean; command?: string } {
  const result = runCommand('ps', ['-p', String(pid), '-o', 'command=']);
  if (result.status === 0) return { available: true, command: result.stdout.trim() || undefined };
  if (result.status === 1) return { available: true };
  return { available: false };
}

function checkoutProcesses(runCommand: RunCommand, pattern: string): number[] {
  const pids = checkoutHostProcesses(runCommand, pattern);
  if (!pids) throw new Error('could not list host processes');
  return pids;
}

function waitForStopped(check: () => boolean, deps: ExecDeps): void {
  const timeout = deps.processStopTimeoutMs ?? 5_000;
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('host process did not stop before the timeout');
    (deps.sleep ?? sleepSync)(50);
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function requireSuccess(result: { status: number | null }, message: string): void {
  if (result.status !== 0) throw new Error(message);
}
