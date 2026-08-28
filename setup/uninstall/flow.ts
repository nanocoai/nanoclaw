/**
 * Uninstall flow — clack UI orchestration over scan/plan/remove.
 *
 * Self-deletion constraint: this flow runs on tsx out of the node_modules
 * it deletes. All imports are static (loaded before any deletion), dist/
 * and node_modules/ are removed last (the runtime tail), and once execution
 * starts nothing here writes to logs/ (which would recreate it) or does a
 * dynamic import. After the runtime tail, the only output is console.log.
 *
 * Removes ONLY what belongs to this checkout (per-checkout install slug).
 * Each non-empty group shows a WHAT/WHERE table and asks a default-No
 * confirm. Nothing is deleted until every decision has been made, so
 * Ctrl-C anywhere in the confirm phase leaves the install untouched.
 */
import { spawnSync } from 'child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { emit as phEmit } from '../lib/diagnostics.js';
import { note } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { resolveOnecliDeletions, type RunCommand, type VaultAgent } from './onecli-agents.js';
import { buildRemovalPlan, validateDecisions, type Decisions, type RemovalAction } from './plan.js';
import { actionId, artifactId, executePlan, type ExecDeps, type UninstallActionResult } from './remove.js';
import { scanInstall, tilde, type Inventory } from './scan.js';
import {
  DriverCancelled,
  DriverTerminalError,
  type Artifact,
  type SetupDriver,
  type UninstallChoice,
  type UninstallGroup,
  type UninstallPlan,
  type UninstallReceipt,
} from '../lib/setup-driver.js';

const GROUPS = {
  service: {
    title: '1) App & background service',
    desc: 'Runs NanoClaw in the background. Removing this stops the assistant. None of your data lives here.',
    prompt: 'Delete the app & background service shown above?',
  },
  data: {
    title: '2) App data, logs & secrets',
    desc: 'Message database, conversation history, logs, build files, and your .env (API keys / tokens). Removing this erases stored conversations and saved credentials.',
    prompt: 'Delete app data, logs & secrets shown above? (erases conversations + API keys)',
  },
  user: {
    title: "3) Your agents' memory & files",
    desc: 'Notes and memory your agents created (groups/) and any migrated data (store/). Content you made — it cannot be recovered after deletion.',
    prompt: "Delete your agents' memory & files shown above? (cannot be undone)",
  },
  onecli: {
    title: '4) OneCLI credential agents',
    desc: 'Per-agent entries this copy registered in the OneCLI vault. The OneCLI app, your credentials, and the gateway are NOT touched.',
  },
} as const;

const runCommand: RunCommand = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: 'utf-8' });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
};

export async function runUninstallFlow(
  opts: {
    dryRun: boolean;
    yes: boolean;
    invokedFrom: 'flag' | 'setup-detection';
  },
  driver?: SetupDriver,
): Promise<never> {
  const { dryRun, yes } = opts;

  if (driver?.mode === 'ndjson') return runMachineUninstall(opts, driver);

  if (!process.stdin.isTTY && !yes && !dryRun) {
    console.error(
      'Uninstall needs an interactive terminal. Re-run with --yes to delete everything found without prompts, or --dry-run to preview.',
    );
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const home = os.homedir();
  const scan = (): Inventory =>
    scanInstall({
      projectRoot,
      home,
      platform: process.platform,
      runCommand,
    });

  p.intro(k.bold(`Uninstall NanoClaw`));
  // persistId: false — the emit must not create data/install-id, which would
  // both break --dry-run's "changes nothing" promise and resurrect a data/
  // row in the very inventory we are about to scan.
  phEmit('uninstall_started', { invokedFrom: opts.invokedFrom, dryRun, yes }, { persistId: false });

  const spinner = p.spinner();
  spinner.start('Checking what exists for this copy…');
  const inv = scan();
  spinner.stop(`Scanned copy ${inv.slug} at ${tilde(projectRoot, home)}.`);

  const svcRows = serviceRows(inv, home);
  const dataRows = [...inv.data, ...inv.runtime].map(({ what, where }) => ({ what, where }));
  const userRows = inv.user.map(({ what, where }) => ({ what, where }));
  const serviceDecisionRows =
    svcRows.length > 0 || (dataRows.length === 0 && userRows.length === 0)
      ? svcRows
      : [
          {
            what: 'Checkout-owned processes',
            where: `install ${inv.slug} (if running)`,
          },
        ];
  const totalFound =
    serviceDecisionRows.length + dataRows.length + userRows.length + inv.onecli.mine.length + inv.onecli.orphans.length;

  if (totalFound === 0) {
    p.outro(
      `✓ Nothing to uninstall — this copy (${inv.slug}) is already clean.\n` +
        k.dim('   (No service, containers, image, data, or OneCLI agents found for this folder.)'),
    );
    process.exit(0);
  }

  if (dryRun) {
    p.log.message(k.cyan('PREVIEW ONLY — this shows what would be deleted and changes nothing.'));
    if (serviceDecisionRows.length > 0) {
      note(groupBody(GROUPS.service.desc, serviceDecisionRows), GROUPS.service.title);
    }
    if (dataRows.length > 0) note(groupBody(GROUPS.data.desc, dataRows), GROUPS.data.title);
    if (userRows.length > 0) note(groupBody(GROUPS.user.desc, userRows), GROUPS.user.title);
    if (inv.onecli.mine.length > 0 || inv.onecli.orphans.length > 0) {
      const lines = [GROUPS.onecli.desc, ''];
      lines.push('Would be deleted (after confirmation):');
      for (const a of inv.onecli.mine) lines.push(`  ● ${a.name} — ${a.identifier}`);
      if (inv.onecli.mine.length === 0) lines.push('  (none)');
      lines.push('Left in place — may belong to another copy:');
      for (const a of inv.onecli.orphans) lines.push(`  ○ ${a.name} — ${a.identifier}`);
      if (inv.onecli.orphans.length === 0) lines.push('  (none)');
      note(lines.join('\n'), GROUPS.onecli.title);
    }
    const empty = emptyGroupTitles(serviceDecisionRows.length, dataRows.length, userRows.length, inv);
    if (empty.length > 0) p.log.message(k.dim(`Nothing found for: ${empty.join(', ')}`));
    for (const n of inv.notes) p.log.message(k.dim(`• ${n}`));
    p.outro('Preview complete. Nothing was changed.');
    process.exit(0);
  }

  if (yes) {
    p.log.warn('--yes given: deleting everything found below without asking.');
  } else {
    p.log.message(
      k.dim(
        'You will be asked about each group that has something. Default is to keep\n(just press Enter). Type "y" to delete a group.',
      ),
    );
  }

  // ── confirm phase — nothing is deleted until every decision is made ──

  let serviceYes = false;
  if (serviceDecisionRows.length > 0) {
    note(groupBody(GROUPS.service.desc, serviceDecisionRows), GROUPS.service.title);
    serviceYes = await confirmGroup(GROUPS.service.prompt, yes);
  }

  let dataYes = false;
  if (dataRows.length > 0) {
    note(groupBody(GROUPS.data.desc, dataRows), GROUPS.data.title);
    dataYes = await confirmGroup(GROUPS.data.prompt, yes);
  }

  let userYes = false;
  if (userRows.length > 0) {
    note(groupBody(GROUPS.user.desc, userRows), GROUPS.user.title);
    userYes = await confirmGroup(GROUPS.user.prompt, yes);
  }

  const keptNotes = inv.envBackups.map((backup) => `${backup.what}: ${backup.where} kept.`);
  if (!serviceYes && serviceDecisionRows.length > 0) {
    keptNotes.push(`${GROUPS.service.title}: kept by your choice.`);
  }
  if (!dataYes && dataRows.length > 0) keptNotes.push(`${GROUPS.data.title}: kept by your choice.`);
  if (!userYes && userRows.length > 0) keptNotes.push(`${GROUPS.user.title}: kept by your choice.`);

  const onecliDelete = await decideOnecli(inv, yes, keptNotes);

  const selectionError = uninstallSelectionError(inv, {
    service: serviceYes,
    data: dataYes,
    user: userYes,
  });
  if (selectionError) {
    p.log.error(selectionError);
    process.exit(1);
  }
  if (!sameOwnershipSelectors(inv, scan())) {
    p.log.error('This NanoClaw checkout changed after it was scanned. Nothing was removed; rerun uninstall.');
    process.exit(1);
  }

  // Record the decisions before execution can delete logs/ — but only into
  // an existing logs/ (userInput would otherwise mkdir it back into
  // existence, leaving a fresh logs/setup.log behind after the uninstall).
  if (fs.existsSync(path.join(projectRoot, 'logs'))) {
    setupLog.userInput(
      'uninstall_decisions',
      JSON.stringify({
        service: serviceYes,
        data: dataYes,
        user: userYes,
        onecliAgentsDeleted: onecliDelete.length,
      }),
    );
  }

  const decisions: Decisions = {
    service: serviceYes,
    data: dataYes,
    user: userYes,
    onecliDelete,
  };
  const actions = buildRemovalPlan(inv, decisions);

  if (actions.length === 0) {
    printLeftAlone([...inv.notes, ...keptNotes]);
    p.outro('Nothing selected — nothing was changed.');
    process.exit(0);
  }

  phEmit(
    'uninstall_executed',
    {
      invokedFrom: opts.invokedFrom,
      service: serviceYes,
      data: dataYes,
      user: userYes,
      onecliAgentsDeleted: onecliDelete.length,
    },
    { persistId: false },
  );

  // The runtime tail (dist/, node_modules/) runs after every other action
  // AND after the summary — nothing but console.log may happen once the
  // modules we're running from are gone.
  const head = actions.filter((a) => a.kind !== 'delete-runtime-path');
  const tail = actions.filter((a) => a.kind === 'delete-runtime-path');
  const destructiveStart = head.findIndex((action) => action.kind === 'backup-env' || action.kind === 'delete-path');
  const prerequisites = destructiveStart === -1 ? head : head.slice(0, destructiveStart);
  const destructive = destructiveStart === -1 ? [] : head.slice(destructiveStart);

  const deps: ExecDeps = {
    runCommand,
    log: (line) => p.log.message(line),
    isRoot: process.getuid?.() === 0,
  };
  const prerequisiteResult = executePlan(prerequisites, deps);
  const onecliFailed = prerequisites.some(
    (action, index) =>
      action.kind === 'delete-onecli-agent' &&
      ['failed', 'untouched'].includes(prerequisiteResult.results[index]?.outcome ?? 'failed'),
  );
  const prerequisiteError =
    onecliFailed && !prerequisiteResult.prerequisiteFailed
      ? {
          code: 'credential_prerequisite_failed',
          message: 'OneCLI agent cleanup failed, so app data was left for a safe retry.',
        }
      : undefined;
  const destructiveResult = executePlan(destructive, {
    ...deps,
    prerequisiteFailed: prerequisiteResult.prerequisiteFailed || onecliFailed,
    ...(prerequisiteError ? { prerequisiteError } : {}),
  });

  printLeftAlone([...inv.notes, ...keptNotes, ...prerequisiteResult.notes, ...destructiveResult.notes]);

  const headIncomplete = uninstallIncomplete([...prerequisiteResult.results, ...destructiveResult.results]);
  const tailResult = executePlan(tail, {
    ...deps,
    prerequisiteFailed: headIncomplete,
    ...(headIncomplete
      ? {
          prerequisiteError: {
            code: 'removal_incomplete',
            message: 'Earlier cleanup was incomplete, so runtime files were left for a safe retry.',
          },
        }
      : {}),
    log: (line) => console.log(`  ${line}`),
  });
  for (const n of tailResult.notes) console.log(`  • ${n}`);

  const incomplete = uninstallIncomplete([
    ...prerequisiteResult.results,
    ...destructiveResult.results,
    ...tailResult.results,
  ]);
  if (incomplete) {
    console.error(`\n! Uninstall incomplete for NanoClaw copy ${inv.slug}. Review the items left alone and rerun.`);
    process.exit(1);
  }

  console.log(`\n✓ Done. NanoClaw copy ${inv.slug} has been uninstalled.`);
  process.exit(0);
}

async function runMachineUninstall(
  opts: { dryRun: boolean; yes: boolean; invokedFrom: 'flag' | 'setup-detection' },
  driver: SetupDriver,
): Promise<never> {
  if (opts.dryRun || opts.yes) {
    driver.error(
      'unsupported_machine_option',
      'Machine uninstall is already plan-first; --dry-run and --yes are terminal-only options.',
      [{ kind: 'rerun', args: ['--uninstall', '--protocol', 'nanoclaw.driver.v1'] }],
    );
  }

  const projectRoot = process.cwd();
  const home = os.homedir();
  const scan = (): Inventory => scanInstall({ projectRoot, home, platform: process.platform, runCommand });

  driver.progress('uninstall-scan', 'running', 'Checking this NanoClaw copy');
  const approved = scan();
  driver.progress('uninstall-scan', 'succeeded');
  const plan = protocolPlan(approved);
  const choices = await driver.waitForUninstall(plan, (candidate) =>
    uninstallSelectionError(approved, decisionsFromChoices(approved, candidate)),
  );
  driver.throwIfCancelled();

  const actions = buildRemovalPlan(approved, decisionsFromChoices(approved, choices));
  const selectedIds = new Set(actions.map(artifactId));
  const results: UninstallActionResult[] = [];
  const emit = (result: UninstallActionResult): void => {
    results.push(result);
    driver.uninstallAction(result);
  };

  for (const artifact of plan.artifacts) {
    if (!selectedIds.has(artifact.id)) {
      emit({
        actionId: `preserve-${artifact.id}`,
        artifactId: artifact.id,
        outcome: artifact.disposition === 'alreadyAbsent' ? 'alreadyAbsent' : 'preserved',
      });
    }
  }

  const current = scan();
  if (!sameOwnershipSelectors(approved, current, { selectorsOnly: true })) {
    for (const action of actions) {
      emit({
        actionId: actionId(action),
        artifactId: artifactId(action),
        outcome: 'untouched',
        error: { code: 'checkout_identity_changed', message: 'The checkout identity changed after approval.' },
      });
    }
    driver.completeUninstall(receiptFor('incomplete', results, current));
    throw new DriverTerminalError(1);
  }

  let prerequisiteFailed = false;
  let lastStepId: string | undefined;
  for (const action of actions) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (driverCancelled(driver)) break;
    lastStepId = actionId(action);
    prerequisiteFailed = executePlan([action], {
      runCommand,
      log: () => {},
      isRoot: process.getuid?.() === 0,
      prerequisiteFailed,
      onResult: emit,
    }).prerequisiteFailed;
  }

  if (driverCancelled(driver)) {
    driver.cancelled({ lastStepId, results, remaining: remainingArtifacts(scan()) });
    throw new DriverTerminalError(2);
  }

  const after = scan();
  const remaining = remainingArtifacts(after);
  const residueIds = new Set(remaining.map((artifact) => artifact.id));
  const incomplete =
    results.some((result) => result.outcome === 'failed' || result.outcome === 'untouched') ||
    [...selectedIds].some((id) => residueIds.has(id));
  driver.completeUninstall(receiptFor(incomplete ? 'incomplete' : 'success', results, after));
  throw new DriverTerminalError(incomplete ? 1 : 0);
}

function driverCancelled(driver: SetupDriver): boolean {
  try {
    driver.throwIfCancelled();
    return false;
  } catch (error) {
    if (error instanceof DriverCancelled) return true;
    throw error;
  }
}

function decisionsFromChoices(inventory: Inventory, choices: Map<UninstallGroup, UninstallChoice>): Decisions {
  return {
    service: choices.get('service') === 'remove',
    data: choices.get('data') === 'remove',
    user: choices.get('user') === 'remove',
    onecliDelete: choices.get('onecli') === 'remove' ? inventory.onecli.mine : [],
  };
}

function protocolPlan(inventory: Inventory): UninstallPlan {
  const actions = buildRemovalPlan(inventory, {
    service: true,
    data: true,
    user: true,
    onecliDelete: inventory.onecli.mine,
  });
  const artifacts = actions.map((action) => artifactForAction(inventory, action));
  artifacts.push(
    sharedArtifact('checkout-root', 'checkout', 'NanoClaw source checkout', inventory.projectRoot),
    sharedArtifact(
      'onecli-shared-vault',
      'shared-vault',
      'OneCLI app, vault, and credentials',
      '~/.local/share/onecli',
    ),
    sharedArtifact('host-shared-config', 'shared-config', 'Host-wide NanoClaw configuration', '~/.config/nanoclaw'),
  );
  for (const backup of inventory.envBackups) {
    artifacts.push({
      id: `credential-backup-${shortHash(backup.path)}`,
      kind: 'credential-backup',
      label: backup.what,
      location: backup.path,
      disposition: 'external',
    });
  }
  for (const backup of inventory.legacyEnvBackups ?? []) {
    artifacts.push({
      id: `legacy-credential-backup-${shortHash(backup.path)}`,
      kind: 'credential-backup-inside-checkout',
      label: 'Legacy credential backup inside checkout',
      location: backup.path,
      disposition: 'uninspectable',
    });
  }
  for (const agent of inventory.onecli.orphans) {
    artifacts.push({
      id: `onecli-orphan-${agent.uuid}`,
      kind: 'onecli-agent',
      label: agent.name || agent.identifier,
      location: `onecli-agent:${agent.uuid}`,
      disposition: 'uninspectable',
    });
  }
  for (const [index, message] of inventory.notes.entries()) {
    artifacts.push({
      id: `uninspectable-${index + 1}`,
      kind: 'uninspectable',
      label: message,
      location: inventory.projectRoot,
      disposition: 'uninspectable',
    });
  }

  return {
    id: randomUUID(),
    groups: [
      protocolGroup('service', GROUPS.service.title, GROUPS.service.desc),
      protocolGroup('data', GROUPS.data.title, GROUPS.data.desc),
      protocolGroup('user', GROUPS.user.title, GROUPS.user.desc),
      protocolGroup('onecli', GROUPS.onecli.title, GROUPS.onecli.desc),
    ],
    artifacts,
  };
}

function protocolGroup(id: UninstallGroup, label: string, description: string): UninstallPlan['groups'][number] {
  return { id, label, description, default: 'preserve', choices: ['preserve', 'remove'] };
}

function sharedArtifact(id: string, kind: string, label: string, location: string): Artifact {
  return { id, kind, label, location, disposition: 'shared' };
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function artifactForAction(inventory: Inventory, action: RemovalAction): Artifact {
  const identityMissing = 'identityRequired' in action && action.identityRequired === true && !action.expectedIdentity;
  const processListMissing = action.kind === 'pkill-host' && inventory.service.hostProcessIds === undefined;
  const containerListMissing = action.kind === 'rm-containers' && inventory.service.containerRuntimeAvailable === false;
  const absent =
    (action.kind === 'rm-containers' && !containerListMissing && inventory.service.containerIds.length === 0) ||
    (action.kind === 'pkill-host' && inventory.service.hostProcessIds?.length === 0);
  return {
    id: artifactId(action),
    kind: action.kind,
    label: actionLabel(action),
    location: actionLocation(action),
    disposition:
      identityMissing || processListMissing || containerListMissing
        ? 'uninspectable'
        : absent
          ? 'alreadyAbsent'
          : 'owned',
    decisionGroup: groupForAction(inventory, action),
  };
}

function groupForAction(inventory: Inventory, action: RemovalAction): UninstallGroup {
  if (action.kind === 'delete-onecli-agent') return 'onecli';
  if (['unload-service', 'kill-pid', 'pkill-host', 'rm-containers', 'rmi', 'rm-ncl-symlink'].includes(action.kind)) {
    return 'service';
  }
  if (
    (action.kind === 'delete-path' || action.kind === 'delete-runtime-path') &&
    inventory.user.some((item) => item.path === action.item.path)
  )
    return 'user';
  return 'data';
}

function actionLocation(action: RemovalAction): string {
  switch (action.kind) {
    case 'unload-service':
      return action.unitPath;
    case 'kill-pid':
      return action.pidFile;
    case 'pkill-host':
      return action.pattern;
    case 'rm-containers':
      return `${action.runtime}:${action.labelFilter}`;
    case 'rmi':
      return action.image;
    case 'rm-ncl-symlink':
      return action.linkPath;
    case 'delete-onecli-agent':
      return `onecli-agent:${action.agent.uuid}`;
    case 'backup-env':
      return action.envPath;
    case 'delete-path':
    case 'delete-runtime-path':
      return action.item.path;
  }
}

function actionLabel(action: RemovalAction): string {
  if (action.kind === 'delete-onecli-agent') return `OneCLI agent ${action.agent.name || action.agent.identifier}`;
  if (action.kind === 'delete-path' || action.kind === 'delete-runtime-path') return action.item.what;
  if (action.kind === 'backup-env') return 'Secrets and API keys (.env, backed up first)';
  return action.kind.replaceAll('-', ' ');
}

function remainingArtifacts(inventory: Inventory): Artifact[] {
  return protocolPlan(inventory).artifacts.filter((artifact) => artifact.disposition !== 'alreadyAbsent');
}

function receiptFor(
  outcome: 'success' | 'incomplete',
  results: UninstallActionResult[],
  inventory: Inventory,
): UninstallReceipt {
  return {
    version: 1,
    outcome,
    results,
    remaining: remainingArtifacts(inventory),
    checkoutRemoval: checkoutRemovalFor(inventory),
    completedAt: new Date().toISOString(),
  };
}

function checkoutRemovalFor(inventory: Inventory): { safe: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const service = inventory.service;
  if (service.launchdPlist) blockers.push(`background service remains: ${service.launchdPlist}`);
  if (service.systemdUserUnit) blockers.push(`background service remains: ${service.systemdUserUnit}`);
  if (service.systemdSystemUnit) blockers.push(`system service remains: ${service.systemdSystemUnit}`);
  if (service.pidFile) blockers.push(`pidfile remains: ${service.pidFile}`);
  if (service.hostProcessIds === undefined) blockers.push('host process identity could not be inspected');
  else if (service.hostProcessIds.length > 0) blockers.push('checkout-owned host process remains');
  if (service.containerIds.length > 0) blockers.push('checkout-owned container remains');
  if (service.nclSymlink) blockers.push(`ncl symlink remains: ${service.nclSymlink}`);
  if (service.containerRuntimeAvailable === false) blockers.push('container runtime state could not be inspected');

  for (const item of [...inventory.data, ...inventory.runtime, ...inventory.user]) {
    try {
      fs.lstatSync(item.path);
      blockers.push(`checkout artifact remains: ${item.path}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') blockers.push(`checkout artifact could not be inspected: ${item.path}`);
    }
  }
  for (const item of inventory.legacyEnvBackups ?? []) {
    blockers.push(`credential backup remains inside checkout: ${item.path}`);
  }
  return { safe: blockers.length === 0, blockers };
}

/** Unwrap a confirm result; Ctrl-C / Esc cancels the whole uninstall — nothing deleted. */
function answered<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Uninstall cancelled. Nothing was deleted.');
    process.exit(0);
  }
  return value as T;
}

async function confirmGroup(prompt: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  return answered(await p.confirm({ message: prompt, initialValue: false }));
}

/**
 * Group 4 has two sub-decisions the single-prompt loop can't express:
 * MINE is one yes/no; ORPHANS get a separate default-No prompt with an
 * explicit cross-copy warning. --yes deletes MINE but never ORPHANS
 * (enforced in resolveOnecliDeletions); anything kept is reported with
 * the exact manual delete command (by vault uuid).
 */
async function decideOnecli(inv: Inventory, yes: boolean, keptNotes: string[]): Promise<VaultAgent[]> {
  const { mine, orphans } = inv.onecli;
  if (mine.length === 0 && orphans.length === 0) return [];

  const rows = [
    ...mine.map((a) => ({ what: 'OneCLI agent', where: `${a.name} — ${a.identifier}` })),
    ...orphans.map((a) => ({ what: 'OneCLI agent (orphan)', where: `${a.name} — ${a.identifier}` })),
  ];
  note(groupBody(GROUPS.onecli.desc, rows), GROUPS.onecli.title);

  let deleteMine = false;
  if (mine.length > 0 && !yes) {
    deleteMine = answered(
      await p.confirm({
        message: `Delete this copy's ${mine.length} OneCLI agent(s)?`,
        initialValue: false,
      }),
    );
    if (!deleteMine) keptNotes.push('OneCLI agents (this copy): kept by your choice.');
  }

  let deleteOrphans = false;
  if (orphans.length > 0) {
    if (yes) {
      p.log.warn(
        `${orphans.length} other NanoClaw-style agent(s) in the vault are not linked to this copy;\n--yes does NOT delete them (they may belong to another copy).`,
      );
    } else {
      p.log.warn(
        `Found ${orphans.length} other NanoClaw-style agent(s) in the vault not linked to this copy —\nthey may belong to ANOTHER NanoClaw copy on this machine.`,
      );
      deleteOrphans = answered(await p.confirm({ message: 'Delete them too?', initialValue: false }));
    }
    if (yes || !deleteOrphans) {
      keptNotes.push(`OneCLI orphan agents (${orphans.length}): left in place — remove manually if they're yours:`);
      for (const a of orphans) {
        keptNotes.push(`  onecli agents delete --id ${a.uuid}   # ${a.name} — ${a.identifier}`);
      }
    }
  }

  return resolveOnecliDeletions({
    mine,
    orphans,
    assumeYes: yes,
    deleteMine,
    deleteOrphans,
  });
}

function serviceRows(inv: Inventory, home: string): { what: string; where: string }[] {
  const s = inv.service;
  const rows: { what: string; where: string }[] = [];
  if (s.launchdPlist) rows.push({ what: 'Background service', where: tilde(s.launchdPlist, home) });
  if (s.systemdUserUnit) rows.push({ what: 'Background service', where: tilde(s.systemdUserUnit, home) });
  if (s.systemdSystemUnit) rows.push({ what: 'Background service (system)', where: s.systemdSystemUnit });
  if (s.pidFile) rows.push({ what: 'Running process', where: 'nanoclaw.pid' });
  if (s.hostProcessIds && s.hostProcessIds.length > 0) {
    rows.push({
      what: 'Running host processes',
      where: `${s.hostProcessIds.length} process(es)`,
    });
  }
  if (s.containerIds.length > 0) {
    rows.push({ what: 'Running containers', where: `${s.containerIds.length} container(s)` });
  }
  if (s.image) rows.push({ what: 'Container image', where: s.image });
  if (s.nclSymlink) rows.push({ what: 'Command-line tool (ncl)', where: tilde(s.nclSymlink, home) });
  return rows;
}

function groupBody(desc: string, rows: { what: string; where: string }[]): string {
  const width = Math.max(...rows.map((r) => r.what.length), 'WHAT'.length);
  const lines = [desc, '', `${'WHAT'.padEnd(width + 2)}WHERE`];
  for (const r of rows) lines.push(`${r.what.padEnd(width + 2)}${r.where}`);
  return lines.join('\n');
}

function emptyGroupTitles(svcCount: number, dataCount: number, userCount: number, inv: Inventory): string[] {
  const empty: string[] = [];
  if (svcCount === 0) empty.push(GROUPS.service.title);
  if (dataCount === 0) empty.push(GROUPS.data.title);
  if (userCount === 0) empty.push(GROUPS.user.title);
  if (inv.onecli.mine.length === 0 && inv.onecli.orphans.length === 0) {
    empty.push(GROUPS.onecli.title);
  }
  return empty;
}

function printLeftAlone(notes: string[]): void {
  const lines = [
    '• OneCLI app, vault & credentials: ~/.local/share/onecli, ~/.local/bin/onecli',
    '• Host-wide config: ~/.config/nanoclaw/ (mount/sender allowlists)',
    '• PATH line in ~/.bashrc and ~/.zshrc',
    '• Other NanoClaw copies on this machine',
    ...notes.map((n) => `• ${n}`),
  ];
  note(lines.join('\n'), 'Left alone (shared / not ours)');
}

export function uninstallSelectionError(
  inventory: Pick<Inventory, 'onecli'>,
  decisions: Pick<Decisions, 'service' | 'data' | 'user'>,
): string | undefined {
  return (
    validateDecisions(decisions) ??
    (!inventory.onecli.available && decisions.data
      ? 'OneCLI agents could not be inspected. Restore OneCLI and rerun uninstall before deleting app data.'
      : undefined)
  );
}

export function uninstallIncomplete(results: readonly Pick<UninstallActionResult, 'outcome'>[]): boolean {
  return results.some((result) => ['failed', 'untouched'].includes(result.outcome));
}

export function sameOwnershipSelectors(
  before: Inventory,
  after: Inventory,
  options: { selectorsOnly?: boolean } = {},
): boolean {
  const beforeIdentity = before.identity;
  const afterIdentity = after.identity;
  const selectors =
    path.resolve(before.projectRoot) === path.resolve(after.projectRoot) &&
    before.slug === after.slug &&
    before.containerRuntime === after.containerRuntime &&
    Boolean(beforeIdentity?.root) &&
    Boolean(afterIdentity?.root) &&
    beforeIdentity?.root === afterIdentity?.root &&
    beforeIdentity?.containerSelector === afterIdentity?.containerSelector;
  // The machine rescan compares two scans of its own making and only needs the
  // selectors to agree. The terminal post-approval gate keeps the full
  // comparison, including artifact identity resolution and scoped-root equality.
  if (options.selectorsOnly) return selectors;
  return (
    selectors &&
    Object.values(beforeIdentity?.exactPaths ?? {}).every(Boolean) &&
    Object.values(beforeIdentity?.scopedRoots ?? {}).every(Boolean) &&
    JSON.stringify(beforeIdentity?.scopedRoots) === JSON.stringify(afterIdentity?.scopedRoots)
  );
}
