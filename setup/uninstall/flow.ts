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
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { emit as phEmit } from '../lib/diagnostics.js';
import { note } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import {
  resolveOnecliDeletions,
  type RunCommand,
  type VaultAgent,
} from './onecli-agents.js';
import { buildRemovalPlan, type Decisions } from './plan.js';
import { executePlan, type ExecDeps } from './remove.js';
import { scanInstall, tilde, type Inventory } from './scan.js';

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
  return { status: res.status, stdout: res.stdout ?? '' };
};

export async function runUninstallFlow(opts: {
  dryRun: boolean;
  yes: boolean;
  invokedFrom: 'flag' | 'setup-detection';
}): Promise<never> {
  const { dryRun, yes } = opts;

  if (!process.stdin.isTTY && !yes && !dryRun) {
    console.error(
      'Uninstall needs an interactive terminal. Re-run with --yes to delete everything found without prompts, or --dry-run to preview.',
    );
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const home = os.homedir();

  p.intro(k.bold(`Uninstall NanoClaw`));
  // persistId: false — the emit must not create data/install-id, which would
  // both break --dry-run's "changes nothing" promise and resurrect a data/
  // row in the very inventory we are about to scan.
  phEmit('uninstall_started', { invokedFrom: opts.invokedFrom, dryRun, yes }, { persistId: false });

  const spinner = p.spinner();
  spinner.start('Checking what exists for this copy…');
  const inv = scanInstall({
    projectRoot,
    home,
    platform: process.platform,
    runCommand,
  });
  spinner.stop(`Scanned copy ${inv.slug} at ${tilde(projectRoot, home)}.`);

  const svcRows = serviceRows(inv, home);
  const dataRows = [...inv.data, ...inv.runtime].map(({ what, where }) => ({ what, where }));
  const userRows = inv.user.map(({ what, where }) => ({ what, where }));
  const totalFound =
    svcRows.length +
    dataRows.length +
    userRows.length +
    inv.onecli.mine.length +
    inv.onecli.orphans.length;

  if (totalFound === 0) {
    p.outro(
      `✓ Nothing to uninstall — this copy (${inv.slug}) is already clean.\n` +
        k.dim('   (No service, containers, image, data, or OneCLI agents found for this folder.)'),
    );
    process.exit(0);
  }

  if (dryRun) {
    p.log.message(
      k.cyan('PREVIEW ONLY — this shows what would be deleted and changes nothing.'),
    );
    if (svcRows.length > 0) note(groupBody(GROUPS.service.desc, svcRows), GROUPS.service.title);
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
    const empty = emptyGroupTitles(svcRows.length, dataRows.length, userRows.length, inv);
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
  if (svcRows.length > 0) {
    note(groupBody(GROUPS.service.desc, svcRows), GROUPS.service.title);
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

  const keptNotes: string[] = [];
  if (!serviceYes && svcRows.length > 0) keptNotes.push(`${GROUPS.service.title}: kept by your choice.`);
  if (!dataYes && dataRows.length > 0) keptNotes.push(`${GROUPS.data.title}: kept by your choice.`);
  if (!userYes && userRows.length > 0) keptNotes.push(`${GROUPS.user.title}: kept by your choice.`);

  const onecliDelete = await decideOnecli(inv, yes, keptNotes);

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

  const deps: ExecDeps = {
    runCommand,
    log: (line) => p.log.message(line),
    isRoot: process.getuid?.() === 0,
  };
  const { notes: execNotes } = executePlan(head, deps);

  printLeftAlone([...inv.notes, ...keptNotes, ...execNotes]);

  const { notes: tailNotes } = executePlan(tail, {
    ...deps,
    log: (line) => console.log(`  ${line}`),
  });
  for (const n of tailNotes) console.log(`  • ${n}`);
  console.log(`\n✓ Done. NanoClaw copy ${inv.slug} has been uninstalled.`);
  process.exit(0);
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
async function decideOnecli(
  inv: Inventory,
  yes: boolean,
  keptNotes: string[],
): Promise<VaultAgent[]> {
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
      deleteOrphans = answered(
        await p.confirm({ message: 'Delete them too?', initialValue: false }),
      );
    }
    if (yes || !deleteOrphans) {
      keptNotes.push(
        `OneCLI orphan agents (${orphans.length}): left in place — remove manually if they're yours:`,
      );
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

function emptyGroupTitles(
  svcCount: number,
  dataCount: number,
  userCount: number,
  inv: Inventory,
): string[] {
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
