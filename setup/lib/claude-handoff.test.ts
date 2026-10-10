import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { AssistContext } from './claude-assist.js';

// Shared state for the hoisted mock factories. `confirms` is the queue each
// mocked p.confirm pops from; the claude-assist spies stand in for the real
// install/sign-in flow so no test can ever prompt or spawn anything.
const ce = vi.hoisted(() => ({
  confirms: [] as boolean[],
  confirmMessages: [] as string[],
  warnings: [] as string[],
  ensureClaudeReady: vi.fn(async () => true),
  isClaudeReady: vi.fn(() => false),
  offerClaudeAssist: vi.fn(async () => false),
}));

vi.mock('./claude-assist.js', async (importActual) => {
  const actual = await importActual<typeof import('./claude-assist.js')>();
  return {
    ...actual,
    ensureClaudeReady: ce.ensureClaudeReady,
    isClaudeReady: ce.isClaudeReady,
    offerClaudeAssist: ce.offerClaudeAssist,
  };
});

vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    confirm: vi.fn(async (o: { message: string }) => {
      ce.confirmMessages.push(o.message);
      return ce.confirms.shift() ?? false;
    }),
    log: {
      ...actual.log,
      warn: vi.fn((msg: string) => ce.warnings.push(msg)),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
});

// ensureAnswer only unwraps clack's cancel symbol; pass values through so the
// test doesn't drag the full runner module (and its transitive imports) in.
vi.mock('./runner.js', () => ({ ensureAnswer: (v: unknown) => v }));

import { offerClaudeOnFailure } from './claude-handoff.js';
import { setPickedProvider } from './picked-provider.js';
import { registerSetupProvider, type FailureAssistResult } from '../providers/registry.js';

const CTX: AssistContext = { stepName: 'container-build', msg: 'boom' };

// Each provider registered once — the registry is module-global and throws on
// duplicates, so tests use one entry per behavior instead of re-registering.
const hookCalls: string[] = [];
const hookFor = (name: string, outcome: FailureAssistResult) => {
  registerSetupProvider({
    value: name,
    label: name,
    hint: '',
    offerFailureAssist: async () => {
      hookCalls.push(name);
      return outcome;
    },
  });
};
hookFor('tp-launch', 'launched');
hookFor('tp-decline', 'declined');
hookFor('tp-unavailable', 'unavailable');
registerSetupProvider({ value: 'tp-nohook', label: 'tp-nohook', hint: '' });

beforeEach(() => {
  ce.confirms.length = 0;
  ce.confirmMessages.length = 0;
  ce.warnings.length = 0;
  hookCalls.length = 0;
  vi.clearAllMocks();
  ce.ensureClaudeReady.mockResolvedValue(true);
  ce.isClaudeReady.mockReturnValue(false);
  ce.offerClaudeAssist.mockResolvedValue(false);
});

afterEach(() => {
  setPickedProvider(undefined);
  delete process.env.NANOCLAW_SKIP_CLAUDE_ASSIST;
  delete process.env.NANOCLAW_SETUP_ASSIST_MODE;
  delete process.env.NANOCLAW_AGENT_PROVIDER;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const roots: string[] = [];
/** A project root whose `.env` carries the install-wide default an earlier run stamped. */
function stampedRoot(provider: string): string {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, '.env'), `DEFAULT_AGENT_PROVIDER=${provider}\n`);
  return root;
}
/** A fresh checkout: no `.env` yet, so nothing has chosen a runtime. */
function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-handoff-'));
  roots.push(root);
  return root;
}

describe('offerClaudeOnFailure provider dispatch', () => {
  it('a preset provider (NANOCLAW_AGENT_PROVIDER) counts before the picker has run', async () => {
    process.env.NANOCLAW_AGENT_PROVIDER = 'tp-nohook';
    const ran = await offerClaudeOnFailure(CTX, '/tmp');
    expect(ran).toBe(false);
    expect(ce.warnings).toHaveLength(1);
    expect(ce.warnings[0]).toContain('tp-nohook');
    expect(ce.ensureClaudeReady).not.toHaveBeenCalled();
    expect(ce.confirmMessages).toEqual([]);
  });

  it('a provider stamped in .env by an earlier run counts on re-entry', async () => {
    const root = stampedRoot('tp-launch');
    const ran = await offerClaudeOnFailure(CTX, root);
    expect(ran).toBe(true);
    expect(hookCalls).toEqual(['tp-launch']);
    expect(ce.ensureClaudeReady).not.toHaveBeenCalled();
  });

  it('a stamped claude default keeps the Claude handoff', async () => {
    const root = stampedRoot('claude');
    ce.confirms.push(false);
    await offerClaudeOnFailure(CTX, root);
    expect(ce.ensureClaudeReady).toHaveBeenCalledOnce();
    expect(ce.confirmMessages).toEqual(['Want to debug this with Claude?']);
  });

  it('an explicit claude pick this run wins over a non-claude default an earlier run stamped', async () => {
    const root = stampedRoot('tp-launch');
    setPickedProvider('claude');
    ce.confirms.push(false);
    const ran = await offerClaudeOnFailure(CTX, root);
    expect(ran).toBe(false);
    expect(hookCalls).toEqual([]);
    expect(ce.warnings).toEqual([]);
    expect(ce.ensureClaudeReady).toHaveBeenCalledOnce();
    expect(ce.confirmMessages).toEqual(['Want to debug this with Claude?']);
  });

  it('a claude pick this run keeps the Claude handoff, before .env is stamped', async () => {
    setPickedProvider('claude');
    ce.confirms.push(false); // decline "Want to debug this with Claude?"
    const ran = await offerClaudeOnFailure(CTX, freshRoot());
    expect(ran).toBe(false);
    expect(ce.ensureClaudeReady).toHaveBeenCalledOnce();
    expect(ce.confirmMessages).toEqual(['Want to debug this with Claude?']);
    expect(ce.warnings).toEqual([]);
  });

  it('nothing chosen yet (fresh run failing before the picker) + Claude not set up: guarded skip, never the installer', async () => {
    const ran = await offerClaudeOnFailure(CTX, freshRoot());
    expect(ran).toBe(false);
    expect(ce.warnings).toHaveLength(1);
    expect(ce.warnings[0]).toContain('no agent runtime has been chosen yet');
    // ensureClaudeReady owns the install/sign-in prompts — it must not run.
    expect(ce.ensureClaudeReady).not.toHaveBeenCalled();
    expect(ce.confirmMessages).toEqual([]);
    expect(hookCalls).toEqual([]);
  });

  it('nothing chosen yet + Claude already installed and signed in: offer stands', async () => {
    ce.isClaudeReady.mockReturnValue(true);
    ce.confirms.push(false); // decline the offer
    const ran = await offerClaudeOnFailure(CTX, freshRoot());
    expect(ran).toBe(false);
    expect(ce.warnings).toEqual([]);
    expect(ce.confirmMessages).toEqual(['Want to debug this with Claude?']);
  });

  it("provider hook 'launched' wins; the Claude path is never consulted", async () => {
    setPickedProvider('tp-launch');
    const ran = await offerClaudeOnFailure(CTX, '/tmp');
    expect(ran).toBe(true);
    expect(hookCalls).toEqual(['tp-launch']);
    expect(ce.ensureClaudeReady).not.toHaveBeenCalled();
    expect(ce.confirmMessages).toEqual([]);
  });

  it("provider hook 'declined' ends the offer; no Claude fallback", async () => {
    setPickedProvider('tp-decline');
    const ran = await offerClaudeOnFailure(CTX, '/tmp');
    expect(ran).toBe(false);
    expect(hookCalls).toEqual(['tp-decline']);
    expect(ce.ensureClaudeReady).not.toHaveBeenCalled();
    expect(ce.confirmMessages).toEqual([]);
  });

  it("provider hook 'unavailable' + Claude not set up: skip with a note, never install", async () => {
    setPickedProvider('tp-unavailable');
    const ran = await offerClaudeOnFailure(CTX, '/tmp');
    expect(ran).toBe(false);
    expect(hookCalls).toEqual(['tp-unavailable']);
    expect(ce.warnings).toHaveLength(1);
    expect(ce.warnings[0]).toContain('tp-unavailable');
    // ensureClaudeReady owns the install/sign-in prompts — it must not run.
    expect(ce.ensureClaudeReady).not.toHaveBeenCalled();
    expect(ce.confirmMessages).toEqual([]);
  });

  it('provider without a hook + Claude not set up: same guarded skip', async () => {
    setPickedProvider('tp-nohook');
    const ran = await offerClaudeOnFailure(CTX, '/tmp');
    expect(ran).toBe(false);
    expect(ce.warnings).toHaveLength(1);
    expect(ce.ensureClaudeReady).not.toHaveBeenCalled();
  });

  it('unregistered provider pick still gets the guarded skip, not the installer', async () => {
    setPickedProvider('somefutureprovider');
    const ran = await offerClaudeOnFailure(CTX, '/tmp');
    expect(ran).toBe(false);
    expect(ce.warnings).toHaveLength(1);
    expect(ce.ensureClaudeReady).not.toHaveBeenCalled();
  });

  it('provider without a hook + Claude already installed and signed in: offer stands', async () => {
    setPickedProvider('tp-nohook');
    ce.isClaudeReady.mockReturnValue(true);
    ce.confirms.push(false); // decline the offer
    const ran = await offerClaudeOnFailure(CTX, '/tmp');
    expect(ran).toBe(false);
    expect(ce.confirmMessages).toEqual(['Want to debug this with Claude?']);
  });

  it('NANOCLAW_SKIP_CLAUDE_ASSIST=1 silences everything, including provider hooks', async () => {
    process.env.NANOCLAW_SKIP_CLAUDE_ASSIST = '1';
    setPickedProvider('tp-launch');
    const ran = await offerClaudeOnFailure(CTX, '/tmp');
    expect(ran).toBe(false);
    expect(hookCalls).toEqual([]);
    expect(ce.confirmMessages).toEqual([]);
  });

  it('NANOCLAW_SETUP_ASSIST_MODE still routes a claude install to the non-interactive assist', async () => {
    process.env.NANOCLAW_SETUP_ASSIST_MODE = 'true';
    await offerClaudeOnFailure(CTX, stampedRoot('claude'));
    expect(ce.offerClaudeAssist).toHaveBeenCalledOnce();
  });

  it('NANOCLAW_SETUP_ASSIST_MODE does not reach the assist before a runtime is chosen', async () => {
    process.env.NANOCLAW_SETUP_ASSIST_MODE = 'true';
    const ran = await offerClaudeOnFailure(CTX, freshRoot());
    expect(ran).toBe(false);
    expect(ce.offerClaudeAssist).not.toHaveBeenCalled();
    expect(ce.warnings).toHaveLength(1);
  });
});
