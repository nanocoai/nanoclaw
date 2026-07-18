// The WhatsApp shared-number risk gate, asserted against the add-whatsapp
// SKILL.md itself (the port of the deleted bespoke setup flow). The skill
// document owns the gate: the number-ownership question and the ban-risk
// interception come before any install command, shared mode requires explicit
// acknowledgement, and entering the bot's own number as the "dedicated" chat
// number routes back through the interception. These tests drive the document
// end-to-end with pre-supplied answers and a recording exec, so a future edit
// that reorders the gate or drops the warning goes red.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it } from 'vitest';

import { applySkill, fullyApplied, type ApplyResult } from '../../scripts/skill-apply.js';

const SKILL_DIR = path.join(process.cwd(), '.claude/skills/add-whatsapp');
const BOT_PHONE = '19995550000';
const WARNING = 'temporarily suspend or permanently ban that number';

interface Recorded {
  seq: Array<{ type: 'exec' | 'operator'; text: string }>;
  res: ApplyResult;
}

// Drive the real SKILL.md through the engine. Commands that need a live
// checkout or network (git, pnpm, the restart) are recorded and succeed
// silently; local shell (echo/node/[ ]/mkdir) runs for real so captures and
// the effect:check predicates behave exactly as in production. The env-write
// bodies are recorded only — their replace semantics are covered by
// whatsapp.test.ts.
async function run(inputs: Record<string, string>): Promise<Recorded> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-wa-flow-'));
  fs.mkdirSync(path.join(root, 'src/channels'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/channels/index.ts'), '');
  const seq: Recorded['seq'] = [];
  const res = await applySkill(SKILL_DIR, root, {
    inputs,
    exec: (cmd: string) => {
      seq.push({ type: 'exec', text: cmd });
      if (/^(git|pnpm|bash)\b/.test(cmd) || cmd.startsWith('grep') || cmd.startsWith('touch')) return '';
      return execFileSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf-8' });
    },
    execStream: async () => ({ ok: true, fields: { PHONE: BOT_PHONE } }),
    resolveRemote: () => 'origin',
    onEvent: (e) => {
      if (e.type === 'operator') seq.push({ type: 'operator', text: e.text });
    },
  });
  fs.rmSync(root, { recursive: true, force: true });
  return { seq, res };
}

const warnings = (r: Recorded) => r.seq.filter((s) => s.type === 'operator' && s.text.includes(WARNING));

describe('WhatsApp shared-number risk gate (add-whatsapp SKILL.md)', () => {
  let shared: Recorded;
  let dedicated: Recorded;

  beforeEach(async () => {
    shared = await run({
      number_mode: 'shared',
      shared_confirm: 'continue',
      auth_method: 'qr',
      agent_name: 'Nano',
      selfchat_engage: 'mention',
    });
    dedicated = await run({
      number_mode: 'dedicated',
      auth_method: 'qr',
      chat_phone: '14155551234',
      agent_name: 'Nano',
    });
  });

  it('shows the ban-risk warning for a shared number, before any install command runs', () => {
    expect(warnings(shared)).toHaveLength(1);
    const warnAt = shared.seq.findIndex((s) => s.type === 'operator' && s.text.includes(WARNING));
    const firstExec = shared.seq.findIndex((s) => s.type === 'exec');
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(firstExec).toBeGreaterThan(warnAt);
  });

  it('explicit acknowledgement resolves shared mode: false flag, self-chat address, @-name pattern', () => {
    expect(fullyApplied(shared.res)).toBe(true);
    expect(shared.res.vars.mode).toBe('shared');
    expect(shared.res.vars.platform_id).toBe(`${BOT_PHONE}@s.whatsapp.net`);
    expect(shared.res.vars.engage_pattern).toBe('^@Nano\\b');
    const envWrites = shared.seq.filter((s) => s.type === 'exec' && s.text.includes('ASSISTANT_HAS_OWN_NUMBER'));
    expect(envWrites).toHaveLength(1);
    expect(envWrites[0].text).toContain('ASSISTANT_HAS_OWN_NUMBER=false');
  });

  it('does not show the warning for a dedicated number', () => {
    expect(warnings(dedicated)).toHaveLength(0);
    expect(fullyApplied(dedicated.res)).toBe(true);
    expect(dedicated.res.vars.mode).toBe('dedicated');
    expect(dedicated.res.vars.platform_id).toBe('14155551234@s.whatsapp.net');
    const envWrites = dedicated.seq.filter((s) => s.type === 'exec' && s.text.includes('ASSISTANT_HAS_OWN_NUMBER'));
    expect(envWrites).toHaveLength(1);
    expect(envWrites[0].text).toContain('ASSISTANT_HAS_OWN_NUMBER=true');
  });

  it('declining the risk at the warning switches to dedicated mode (warning shown once)', async () => {
    const declined = await run({
      number_mode: 'shared',
      shared_confirm: 'dedicated',
      auth_method: 'qr',
      chat_phone: '14155551234',
      agent_name: 'Nano',
    });
    expect(warnings(declined)).toHaveLength(1);
    expect(declined.res.vars.mode).toBe('dedicated');
    expect(fullyApplied(declined.res)).toBe(true);
  });

  it('entering the bot\'s own number as the "dedicated" chat number intercepts: no restart, run fails over', async () => {
    const selfShared = await run({
      number_mode: 'dedicated',
      auth_method: 'qr',
      chat_phone: BOT_PHONE,
      agent_name: 'Nano',
    });
    expect(fullyApplied(selfShared.res)).toBe(false);
    // The interception check bounced, and its surrounding prose tells the
    // agent to re-run the warning and fix the flag for the actual mode.
    expect(selfShared.res.agentTasks.length).toBeGreaterThan(0);
    const check = selfShared.res.agentTasks[0];
    expect(check.prose).toContain('shared-number setup');
    expect(check.prose).toContain('ASSISTANT_HAS_OWN_NUMBER=false');
    // The run-health gate held the restart back.
    const restarted = selfShared.seq.some((s) => s.type === 'exec' && s.text.includes('restart.sh'));
    expect(restarted).toBe(false);
  });
});
