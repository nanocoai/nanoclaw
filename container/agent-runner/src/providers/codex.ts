import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const CODEX_HOME = process.env.CODEX_HOME || '/home/node/.codex';
const OUTPUT_DIR = '/tmp';

const INVALID_SESSION_RE = /thread\/resume failed: no rollout found|no rollout found for thread id|session.*not found/i;

function log(msg: string): void {
  console.error(`[codex-provider] ${msg}`);
}

function readOptional(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function findSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['thread_id', 'session_id', 'conversation_id']) {
    if (typeof record[key] === 'string') return record[key];
  }
  for (const child of Object.values(record)) {
    const id = findSessionId(child);
    if (id) return id;
  }
  return undefined;
}

export function extractCodexSessionId(jsonl: string): string | undefined {
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const id = findSessionId(JSON.parse(line));
      if (id) return id;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function buildCodexPrompt(input: QueryInput): string {
  const sections: string[] = [];

  if (input.systemContext?.instructions) {
    sections.push(input.systemContext.instructions);
  }

  sections.push(
    'You are running inside NanoClaw using Codex as the active provider.',
    'The agent group folder is /workspace/agent.',
    'Group memory may be available in /workspace/agent/CLAUDE.local.md.',
    'Global memory may be available in /workspace/global/CLAUDE.md and should be treated as read-only unless NanoClaw explicitly grants write access.',
  );

  const composed = readOptional('/workspace/agent/CLAUDE.md');
  if (composed) sections.push('NanoClaw instructions:', composed);

  const local = readOptional('/workspace/agent/CLAUDE.local.md');
  if (local) sections.push('Group memory:', local);

  const global = readOptional('/workspace/global/CLAUDE.md');
  if (global) sections.push('Global memory:', global);

  sections.push('User messages:', input.prompt);
  return sections.join('\n\n');
}

export function buildCodexArgs(continuation: string | undefined, outputPath: string, model?: string): string[] {
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-o',
    outputPath,
  ];
  if (model) common.push('-m', model);

  if (continuation) {
    return ['exec', 'resume', ...common, continuation, '-'];
  }

  return ['exec', ...common, '-C', '/workspace/agent', '-'];
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCodexProcess(
  args: string[],
  prompt: string,
  env: Record<string, string | undefined>,
  setChild: (child: ChildProcess) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: '/workspace/agent',
      env: {
        ...env,
        HOME: '/home/node',
        CODEX_HOME,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    setChild(child);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly supportsActivePush = false;

  private env: Record<string, string | undefined>;
  private model?: string;
  private child: ChildProcess | null = null;

  constructor(options: ProviderOptions = {}) {
    this.env = options.env ?? {};
    this.model = options.model;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return INVALID_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    let ended = false;
    let aborted = false;

    async function* eventsFor(provider: CodexProvider): AsyncGenerator<ProviderEvent> {
      const outputPath = path.join(OUTPUT_DIR, `codex-output-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      const prompt = buildCodexPrompt(input);
      let effectiveContinuation = input.continuation;
      let args = buildCodexArgs(effectiveContinuation, outputPath, provider.model);
      let promise = runCodexProcess(args, prompt, provider.env, (child) => {
        provider.child = child;
      });
      while (true) {
        const tick = sleep(1000).then(() => 'tick' as const);
        const done = promise.then(() => 'done' as const, () => 'done' as const);
        if ((await Promise.race([tick, done])) === 'done') break;
        yield { type: 'activity' };
      }
      let result = await promise;

      if (!aborted && effectiveContinuation && result.code !== 0 && provider.isSessionInvalid(result.stderr)) {
        log(`Invalid continuation ${effectiveContinuation}; starting a fresh Codex thread`);
        effectiveContinuation = undefined;
        args = buildCodexArgs(undefined, outputPath, provider.model);
        promise = runCodexProcess(args, prompt, provider.env, (child) => {
          provider.child = child;
        });
        while (true) {
          const tick = sleep(1000).then(() => 'tick' as const);
          const done = promise.then(() => 'done' as const, () => 'done' as const);
          if ((await Promise.race([tick, done])) === 'done') break;
          yield { type: 'activity' };
        }
        result = await promise;
      }

      provider.child = null;
      if (aborted) return;

      yield { type: 'activity' };

      if (result.code !== 0) {
        throw new Error(`Codex exited with code ${result.code}: ${result.stderr.slice(-1000)}`);
      }

      const continuation = effectiveContinuation || extractCodexSessionId(result.stdout);
      if (continuation) {
        yield { type: 'init', continuation };
      }

      let text: string | null = null;
      try {
        text = fs.readFileSync(outputPath, 'utf8').trim() || null;
      } catch {
        text = null;
      }
      try {
        fs.unlinkSync(outputPath);
      } catch {}

      yield { type: 'result', text };
    }

    return {
      push: () => {
        if (!ended) log('Ignoring push: Codex provider processes one prompt per query');
      },
      end: () => {
        ended = true;
      },
      events: eventsFor(this),
      abort: () => {
        aborted = true;
        this.child?.kill('SIGTERM');
      },
    };
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));
