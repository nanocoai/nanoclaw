/**
 * The boundary hook the way claude runs it: a subprocess with the PreToolUse
 * payload on stdin. Postures short-circuit in order (bypass → allow without
 * a request; attached-with-evidence → ask; detached → file-pair round-trip),
 * timeout is deny, and the busy hold is stamped before the wait.
 *
 * Seams are argv flags, mirroring production's one loophole-free channel:
 * the E-t7 review showed env-carried seams ride the agent's own Bash line
 * into nested CLI runs, so the hook no longer reads ANY of them from env —
 * and one regression here pins that a forged env posture stays dead.
 *
 * NEVER import from boundary-hook.ts here — it executes main() on import and
 * would exit this test run (the mailbox-hook canary lesson).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach } from 'bun:test';

import { readAgentState, writeAttachState } from './agent-state.js';
import { decisionPath } from './boundary.js';

const SCRIPT = path.join(import.meta.dir, 'boundary-hook.ts');

let dir: string;
let statePath: string;
let attachPath: string;
let boundaryDir: string;
let decisionsDir: string;
let managedPath: string;

function payload(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput });
}

function spawnHook(
  body: string,
  opts: { extraArgs?: string[]; env?: Record<string, string> } = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      'bun',
      SCRIPT,
      `--state=${statePath}`,
      `--managed-settings=${managedPath}`,
      `--boundary-dir=${boundaryDir}`,
      `--decisions-dir=${decisionsDir}`,
      `--attach-state=${attachPath}`,
      '--ttl-ms=3000',
      '--poll-ms=25',
      // A tmpdir can never be an RO mount; the probe has its own test below.
      '--skip-decisions-probe',
      ...(opts.extraArgs ?? []),
    ],
    {
      stdin: Buffer.from(body),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...(opts.env ?? {}) },
    },
  );
}

async function runHook(
  body: string,
  opts: { extraArgs?: string[]; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string }> {
  const proc = spawnHook(body, opts);
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

function stampManaged(mode: 'auto' | 'bypass'): void {
  // The same byte-shapes the host stamps (src/code-mode/permissions.ts
  // composeManagedSettings) — the posture is read from defaultMode alone.
  const settings =
    mode === 'bypass'
      ? { permissions: { defaultMode: 'bypassPermissions' } }
      : { permissions: { defaultMode: 'default', disableBypassPermissionsMode: 'disable' } };
  fs.writeFileSync(managedPath, JSON.stringify(settings));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-bhook-'));
  statePath = path.join(dir, 'state.json');
  attachPath = path.join(dir, 'attach-state.json');
  boundaryDir = path.join(dir, 'code-boundary');
  decisionsDir = path.join(dir, 'code-boundary-decisions');
  managedPath = path.join(dir, 'managed-settings.json');
  fs.mkdirSync(decisionsDir);
  stampManaged('auto');
});

describe('short-circuits', () => {
  it('non-boundary calls and containers without the managed policy pass silently', async () => {
    const ordinary = await runHook(payload('Bash', { command: 'bun test' }));
    expect(ordinary.exitCode).toBe(0);
    expect(ordinary.stdout).toBe('');
    expect(fs.existsSync(boundaryDir)).toBe(false);

    // No policy stamp mounted = chat mode (or a lost stamp, which also means
    // no managed allow rules exist for a hook allow to matter against).
    fs.rmSync(managedPath);
    const chat = await runHook(payload('Bash', { command: 'ncl envs release env-1' }));
    expect(chat.exitCode).toBe(0);
    expect(chat.stdout).toBe('');
  });

  it('a bypass group is allowed through without a request — the full escape hatch', async () => {
    stampManaged('bypass');
    const res = await runHook(payload('Bash', { command: 'ncl envs release env-1' }));
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(fs.existsSync(boundaryDir)).toBe(false); // no card, no file, no wait
  });

  it('a forged env posture is dead: NANOCLAW_CODE_PERMISSION_MODE=bypass no longer allows', async () => {
    // The E-t7 review's nested-invocation forgery: the agent controls the env
    // of any CLI run it launches from Bash. The posture must come from the
    // host's RO stamp only.
    const proc = spawnHook(payload('Bash', { command: 'ncl envs release env-1' }), {
      env: { NANOCLAW_CODE_PERMISSION_MODE: 'bypass' },
    });
    const requestFile = await waitForRequestFile(); // detached round-trip, not an allow
    const request = JSON.parse(fs.readFileSync(path.join(boundaryDir, requestFile), 'utf8'));
    fs.writeFileSync(decisionPath(decisionsDir, request.id), JSON.stringify({ decision: 'deny', reason: 'nope' }));
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('attached with live human evidence forces the CLI dialog (ask, not silence)', async () => {
    // Silence would leave the attached path to the static prefix rules, which
    // cannot express the substring-shaped boundaries this hook classifies.
    writeAttachState(1, attachPath, { lastInputAt: Date.now() });
    const res = await runHook(payload('Edit', { file_path: '/workspace/group/CLAUDE.md' }));
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(fs.existsSync(boundaryDir)).toBe(false);
  });

  it('an orphaned attach socket (stale evidence) is NOT attached — the approver card path runs', async () => {
    // liveness.ts: exec-shim orphans hold the socket forever after the human's
    // ssh dies. clients=1 with no recent keystroke/connect must escalate.
    writeAttachState(1, attachPath, { lastInputAt: Date.now() - 31 * 60_000, lastConnectAt: Date.now() - 31 * 60_000 });
    const proc = spawnHook(payload('Bash', { command: 'ncl envs release env-9' }));
    const requestFile = await waitForRequestFile();
    const request = JSON.parse(fs.readFileSync(path.join(boundaryDir, requestFile), 'utf8'));
    fs.writeFileSync(decisionPath(decisionsDir, request.id), JSON.stringify({ decision: 'allow', reason: 'clicked' }));
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('the detached round-trip', () => {
  it('writes the request, stamps the busy hold, and returns the decision file verdict', async () => {
    writeAttachState(0, attachPath);
    const proc = spawnHook(payload('Bash', { command: 'ncl envs release env-9' }));

    // The request file appears; answer it like the host would — in the
    // decisions dir, which production RO-mounts so only the host can.
    const requestFile = await waitForRequestFile();
    const request = JSON.parse(fs.readFileSync(path.join(boundaryDir, requestFile), 'utf8'));
    expect(request.toolName).toBe('Bash');
    expect(request.reason).toContain('release');
    expect(Number.isFinite(Date.parse(request.at))).toBe(true);

    // The lease was stamped BEFORE the wait: busy, bounded, in the future.
    const state = readAgentState(statePath)!;
    expect(state.state).toBe('busy');
    expect(Date.parse(state.busyUntil!)).toBeGreaterThan(Date.now());

    fs.writeFileSync(decisionPath(decisionsDir, request.id), JSON.stringify({ decision: 'allow', reason: 'clicked' }));
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    expect(await proc.exited).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    // The hook clears the request it wrote; the decision sits in the RO mount
    // for the host's age sweep (it cannot be deleted from inside).
    expect(fs.readdirSync(boundaryDir)).toEqual([]);
    expect(fs.readdirSync(decisionsDir)).toEqual([`${request.id}.decision.json`]);
  });

  it('a decision file planted in the REQUEST dir is ignored — only the RO dir decides', async () => {
    // The E-t7 self-approval: with both halves under the RW workspace, the
    // agent forged its own allow. The hook must poll the decisions dir only.
    const proc = spawnHook(payload('Write', { file_path: '/home/node/.claude/settings.json' }), {
      extraArgs: ['--ttl-ms=400'],
    });
    const requestFile = await waitForRequestFile();
    const request = JSON.parse(fs.readFileSync(path.join(boundaryDir, requestFile), 'utf8'));
    fs.writeFileSync(decisionPath(boundaryDir, request.id), JSON.stringify({ decision: 'allow', reason: 'forged' }));
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('a deny decision denies', async () => {
    const proc = spawnHook(payload('Write', { file_path: '/home/node/.claude/settings.json' }));
    const requestFile = await waitForRequestFile();
    const request = JSON.parse(fs.readFileSync(path.join(boundaryDir, requestFile), 'utf8'));
    fs.writeFileSync(decisionPath(decisionsDir, request.id), JSON.stringify({ decision: 'deny', reason: 'nope' }));
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('no decision within the TTL is a deny (D17)', async () => {
    const res = await runHook(payload('Bash', { command: 'ncl envs release env-9' }), {
      extraArgs: ['--ttl-ms=200'],
    });
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('no approval');
  });

  it('an unverifiable decisions dir denies without waiting — never polls a forgeable path', async () => {
    // Without --skip-decisions-probe, a plain writable dir must fail the
    // EROFS check (boundary.ts decisionsDirTrusted) and deny immediately.
    const proc = Bun.spawn(
      [
        'bun',
        SCRIPT,
        `--state=${statePath}`,
        `--managed-settings=${managedPath}`,
        `--boundary-dir=${boundaryDir}`,
        `--decisions-dir=${decisionsDir}`,
        `--attach-state=${attachPath}`,
        '--ttl-ms=3000',
        '--poll-ms=25',
      ],
      { stdin: Buffer.from(payload('Bash', { command: 'ncl envs release env-9' })), stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    expect(await proc.exited).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('not the host');
    expect(fs.existsSync(boundaryDir)).toBe(false); // no request behind a dead channel
  });
});

async function waitForRequestFile(): Promise<string> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const files = fs.existsSync(boundaryDir)
      ? fs.readdirSync(boundaryDir).filter((f) => f.endsWith('.request.json'))
      : [];
    if (files.length > 0) return files[0];
    if (Date.now() > deadline) throw new Error('request file never appeared');
    await new Promise((r) => setTimeout(r, 20));
  }
}
