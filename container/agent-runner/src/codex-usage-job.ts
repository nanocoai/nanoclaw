import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat } from './db/connection.js';
import type { RoutingContext } from './formatter.js';

const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_BUFFER = 1024 * 1024;
const DEFAULT_USAGE_COMMAND = ['codex', 'usage', '--json'] as const;
const USAGE_DIR = '.nanoclaw/codex-usage';

export interface CodexUsageSnapshot {
  schema_version: 'codex-usage-snapshot.v1';
  phase: 'pre' | 'post';
  job_id: string;
  captured_at: string;
  command: string[];
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  parsed_json?: unknown;
  numeric_values: Record<string, number>;
}

export interface CodexUsageJob {
  id: string;
  cwd: string;
  routing: RoutingContext;
  prePath: string;
  pre: CodexUsageSnapshot;
}

export interface CodexUsageDelta {
  job_id: string;
  pre_path: string;
  post_path: string;
  command: string[];
  deltas: Record<string, number>;
  unavailable_reason?: string;
}

type UsageCommandRunner = (
  command: string[],
  cwd: string,
) => Promise<Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>>;

let commandRunner: UsageCommandRunner = runCodexUsageCommand;

function log(msg: string): void {
  console.error(`[codex-usage-job] ${msg}`);
}

function generateId(): string {
  return `codex-usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Test seam only. Production uses the Codex CLI command runner. */
export function setCodexUsageCommandRunnerForTest(runner: UsageCommandRunner | null): void {
  commandRunner = runner ?? runCodexUsageCommand;
}

export async function startCodexUsageJob(args: {
  providerName: string;
  cwd: string;
  routing: RoutingContext;
}): Promise<CodexUsageJob | null> {
  if (args.providerName.toLowerCase() !== 'codex') return null;

  const id = generateId();
  const pre = await captureSnapshot('pre', id, args.cwd);
  const prePath = writeSnapshot(args.cwd, id, 'pre', pre);
  log(`pre usage snapshot stored: ${prePath}`);
  return { id, cwd: args.cwd, routing: args.routing, prePath, pre };
}

export async function finishCodexUsageJob(job: CodexUsageJob | null): Promise<CodexUsageDelta | null> {
  if (!job) return null;

  const post = await captureSnapshot('post', job.id, job.cwd);
  const postPath = writeSnapshot(job.cwd, job.id, 'post', post);
  const delta = calculateUsageDelta(job.pre, post, job.prePath, postPath);
  writeSnapshot(job.cwd, job.id, 'delta', {
    schema_version: 'codex-usage-delta.v1',
    ...delta,
    calculated_at: new Date().toISOString(),
  });
  reportUsageDelta(job.routing, delta);
  log(`post usage snapshot stored: ${postPath}`);
  return delta;
}

export function calculateUsageDelta(
  pre: CodexUsageSnapshot,
  post: CodexUsageSnapshot,
  prePath: string,
  postPath: string,
): CodexUsageDelta {
  const deltas: Record<string, number> = {};
  for (const [key, postValue] of Object.entries(post.numeric_values)) {
    const preValue = pre.numeric_values[key];
    if (preValue === undefined) continue;
    const delta = postValue - preValue;
    if (Number.isFinite(delta)) deltas[key] = delta;
  }

  return {
    job_id: pre.job_id,
    pre_path: prePath,
    post_path: postPath,
    command: post.command,
    deltas,
    unavailable_reason: buildUnavailableReason(pre, post, deltas),
  };
}

async function captureSnapshot(phase: 'pre' | 'post', jobId: string, cwd: string): Promise<CodexUsageSnapshot> {
  const command = getUsageCommand();
  let result: Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>;
  try {
    result = await commandRunner(command, cwd);
  } catch (err) {
    result = {
      exit_code: null,
      stdout: '',
      stderr: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const parsed = parseJson(result.stdout);
  return {
    schema_version: 'codex-usage-snapshot.v1',
    phase,
    job_id: jobId,
    captured_at: new Date().toISOString(),
    command,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    parsed_json: parsed,
    numeric_values: parsed === undefined ? {} : flattenNumericValues(parsed),
  };
}

function getUsageCommand(): string[] {
  const configured = process.env.NANOCLAW_CODEX_USAGE_COMMAND_JSON;
  if (!configured) return [...DEFAULT_USAGE_COMMAND];
  try {
    const parsed = JSON.parse(configured);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to default. The snapshot will record the exact command used.
  }
  return [...DEFAULT_USAGE_COMMAND];
}

function runCodexUsageCommand(
  command: string[],
  cwd: string,
): Promise<Pick<CodexUsageSnapshot, 'exit_code' | 'stdout' | 'stderr' | 'error'>> {
  const [bin, ...args] = command;
  touchHeartbeat();
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: SNAPSHOT_TIMEOUT_MS,
        maxBuffer: SNAPSHOT_MAX_BUFFER,
        env: { ...process.env, TERM: process.env.TERM === 'dumb' ? 'xterm-256color' : process.env.TERM },
      },
      (error, stdout, stderr) => {
        touchHeartbeat();
        const maybeCode =
          error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
        resolve({
          exit_code: maybeCode ?? (error ? null : 0),
          stdout,
          stderr,
          error: error ? error.message : undefined,
        });
      },
    );
  });
}

function writeSnapshot(cwd: string, jobId: string, phase: 'pre' | 'post' | 'delta', data: unknown): string {
  const dir = path.join(cwd, USAGE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, `${safePathSegment(jobId)}-${phase}.json`);
  fs.writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`);
  return fullPath;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function parseJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lastJsonLine = trimmed
      .split('\n')
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith('{') || line.startsWith('['));
    if (!lastJsonLine) return undefined;
    try {
      return JSON.parse(lastJsonLine);
    } catch {
      return undefined;
    }
  }
}

function flattenNumericValues(value: unknown, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value === 'number' && Number.isFinite(value)) {
    out[prefix || 'value'] = value;
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => Object.assign(out, flattenNumericValues(item, `${prefix}[${index}]`)));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    Object.assign(out, flattenNumericValues(child, childPrefix));
  }
  return out;
}

function buildUnavailableReason(
  pre: CodexUsageSnapshot,
  post: CodexUsageSnapshot,
  deltas: Record<string, number>,
): string | undefined {
  if (Object.keys(deltas).length > 0) return undefined;
  if (pre.error || post.error) {
    return [pre.error && `pre: ${pre.error}`, post.error && `post: ${post.error}`].filter(Boolean).join('; ');
  }
  if (Object.keys(pre.numeric_values).length === 0 || Object.keys(post.numeric_values).length === 0) {
    return 'Codex CLI usage output did not contain comparable numeric JSON fields';
  }
  return 'Codex CLI usage output had no overlapping numeric fields';
}

function reportUsageDelta(routing: RoutingContext, delta: CodexUsageDelta): void {
  if (routing.channelType !== 'discord' || !routing.platformId) {
    log('usage delta not sent to Discord: current routing is not a Discord channel');
    return;
  }
  writeMessageOut({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: formatUsageDelta(delta) }),
  });
}

export function formatUsageDelta(delta: CodexUsageDelta): string {
  const lines = [`Codex usage for job ${delta.job_id}:`];
  const entries = Object.entries(delta.deltas).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    lines.push(`- Usage delta unavailable: ${delta.unavailable_reason ?? 'no comparable usage fields'}`);
  } else {
    for (const [key, value] of entries) lines.push(`- ${key}: ${formatNumber(value)}`);
  }
  lines.push(`- pre: ${delta.pre_path}`);
  lines.push(`- post: ${delta.post_path}`);
  return lines.join('\n');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
