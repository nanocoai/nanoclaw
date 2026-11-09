import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  abandonUpdate,
  acknowledgeRequirement,
  cleanupUpdate,
  cutoverUpdate,
  finishUpdate,
  loadState,
  prepareUpdate,
  pruneTransactions,
  resumePreparedUpdate,
  rollbackUpdate,
  summarizeState,
  validateUpdate,
  type UpdateState,
  type PruneReport,
} from './update/transaction.js';
import {
  AheadOfReleaseError,
  readChannelSetting,
  resolveUpdateTarget,
  writeChannelSetting,
  type UpdateTarget,
} from './update/channel.js';

interface ParsedArgs {
  command: string;
  projectRoot: string;
  id?: string;
  upstreamRef?: string;
  remote?: string;
  channel?: string;
  strategy?: UpdateState['strategy'];
  commits?: string[];
  requirement?: string;
  status?: 'succeeded' | 'failed';
  rollback?: string;
  dryRun?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (!command) throw new Error('Missing command');
  const parsed: ParsedArgs = { command, projectRoot: process.cwd() };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === '--project-root') parsed.projectRoot = path.resolve(value);
    else if (flag === '--id') parsed.id = value;
    else if (flag === '--upstream-ref') parsed.upstreamRef = value;
    else if (flag === '--remote') parsed.remote = value;
    else if (flag === '--channel') parsed.channel = value;
    else if (flag === '--strategy') {
      if (!['merge', 'rebase', 'cherry-pick'].includes(value)) throw new Error(`Unknown strategy: ${value}`);
      parsed.strategy = value as UpdateState['strategy'];
    } else if (flag === '--commits') parsed.commits = value.split(',').filter(Boolean);
    else if (flag === '--requirement') parsed.requirement = value;
    else if (flag === '--status') {
      if (value !== 'succeeded' && value !== 'failed') throw new Error(`Unknown status: ${value}`);
      parsed.status = value;
    } else if (flag === '--rollback') parsed.rollback = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return parsed;
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}

interface ChannelReport {
  schema: 'nanoclaw-update-channel/v1';
  channel: string;
}

async function execute(args: ParsedArgs): Promise<UpdateState | PruneReport | ChannelReport> {
  if (args.command === 'set-channel') {
    // Load only set-env.ts: upsertEnvVar exists from 2.2 on, unlike the gateway modules.
    const setEnv = pathToFileURL(path.join(args.projectRoot, 'setup/set-env.ts')).href;
    const { upsertEnvVar } = (await import(setEnv)) as Partial<typeof import('../setup/set-env.js')>;
    if (typeof upsertEnvVar !== 'function') throw new Error('This install predates set-channel; update it first');
    process.chdir(args.projectRoot);
    const channel = writeChannelSetting(args.projectRoot, requireValue(args.channel, '--channel'), upsertEnvVar);
    return { schema: 'nanoclaw-update-channel/v1', channel };
  }
  if (args.command === 'prepare') {
    // --upstream-ref is the pre-channel interface older installed skills still use: merge exactly that ref.
    if (args.upstreamRef !== undefined && (args.remote !== undefined || args.channel !== undefined)) {
      throw new Error('Pass --remote [--channel], or --upstream-ref, not both');
    }
    let upstreamRef = args.upstreamRef;
    let target: UpdateTarget | undefined;
    if (upstreamRef === undefined) {
      target = resolveUpdateTarget({
        projectRoot: args.projectRoot,
        remote: requireValue(args.remote, '--remote or --upstream-ref'),
        // A cherry-pick takes only the listed commits, so the release backward check does not apply.
        channel: args.strategy === 'cherry-pick' ? 'edge' : readChannelSetting(args.projectRoot, args.channel),
      });
      upstreamRef = target.ref;
    }
    return prepareUpdate({
      projectRoot: args.projectRoot,
      upstreamRef,
      // A cherry-pick takes only the listed commits, so it never lands on the channel's ref.
      channel: args.strategy === 'cherry-pick' ? undefined : target?.channel,
      strategy: args.strategy,
      commits: args.commits,
    });
  }
  const id = requireValue(args.id, '--id');
  if (args.command === 'resume') return resumePreparedUpdate(args.projectRoot, id);
  if (args.command === 'validate') return validateUpdate(args.projectRoot, id);
  if (args.command === 'cutover') return cutoverUpdate(args.projectRoot, id);
  if (args.command === 'ack') {
    return acknowledgeRequirement(
      args.projectRoot,
      id,
      requireValue(args.requirement, '--requirement'),
      requireValue(args.status, '--status'),
      args.rollback,
    );
  }
  if (args.command === 'finish') return finishUpdate(args.projectRoot, id);
  if (args.command === 'rollback') return rollbackUpdate(args.projectRoot, id);
  if (args.command === 'cleanup') return cleanupUpdate(args.projectRoot, id);
  if (args.command === 'prune') return pruneTransactions(args.projectRoot, id, args.dryRun ?? false);
  if (args.command === 'abandon') return abandonUpdate(args.projectRoot, id);
  if (args.command === 'status') return loadState(args.projectRoot, id);
  throw new Error(`Unknown command: ${args.command}`);
}

async function main(): Promise<void> {
  try {
    const result = await execute(parseArgs(process.argv.slice(2)));
    const output = result.schema === 'nanoclaw-update/v1' ? summarizeState(result) : result;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (result.schema === 'nanoclaw-update/v1' && result.phase === 'conflict') process.exitCode = 2;
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify(
        {
          schema: 'nanoclaw-update-error/v1',
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof AheadOfReleaseError ? { code: err.code, channel: err.channel, tag: err.tag } : {}),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

/**
 * Realpath BOTH sides of the main-module check: `import.meta.url` is already
 * realpathed by the loader, but a symlink-spelled argv (macOS `mktemp -d`
 * lives under the /var → /private/var symlink) is not — the guard was false
 * and the controller exited 0 having done NOTHING, which reads as success to
 * whatever invoked it. Fixed here, not only in the recipe, so it rides the
 * self-update seam to every existing install.
 */
function isMainModule(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(argv))).href;
  } catch {
    // realpath can only fail if the argv path is gone; fall back to the
    // plain comparison rather than silently deciding "not main" on error.
    return import.meta.url === pathToFileURL(path.resolve(argv)).href;
  }
}

if (isMainModule()) {
  void main();
}
