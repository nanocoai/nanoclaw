// The add-another-bot path, asserted against the add-telegram SKILL.md itself.
// Kill conditions: drop `when:add_another=no` from the default pairing fence
// (the first bot would be re-paired on the add path), stop the TELEGRAM_BOT_TOKEN
// probe from answering `yes` (the question is never asked on a rerun), drop
// `when:has_default_bot=no` from the first-bot BotFather walkthrough (a rerun that
// keeps the bot would tell the operator to create one), change the
// TELEGRAM_BOT_TOKEN_<NAME> / TELEGRAM_INSTANCES writes, the name-collision check
// or the same-bot check (a second token that getMe resolves to the bot already
// configured would be stored as a second instance), and a case below goes red.
// The document is driven end-to-end with pre-supplied answers against a scratch
// .env: local shell (the probe, tr, the sed/sort/paste merge, echo, both checks)
// runs for real; git, pnpm, the restart and the getMe curl are recorded and
// answered by stubs.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { applySkill, fullyApplied, type ApplyResult } from '../../scripts/skill-apply.js';
import { parseDirectives } from '../../scripts/skill-directives.js';

const SKILL_DIR = path.join(process.cwd(), '.claude/skills/add-telegram');
const OLD_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NEW_TOKEN = '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PAIR_DEFAULT = 'pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main';

// How many fences each branch guards, read from the document so the skip
// assertions below track the skill instead of a hardcoded count.
const guarded = (value: string): number =>
  parseDirectives(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8')).filter(
    (d) => d.attrs.when === `add_another=${value}`,
  ).length;

interface Recorded {
  res: ApplyResult;
  execs: string[];
  steps: string[]; // effect:step commands: the set-env writes and the pairing step
  envValues: string[]; // each set-env `--value "$(...)"` merge pipeline, evaluated for real
  envAfter: string;
}

async function run(
  envBefore: string,
  inputs: Record<string, string>,
  // What the stubbed getMe answers per curl: by default each token resolves to its own bot.
  getMe: (cmd: string) => string = (cmd) => (cmd.includes(NEW_TOKEN) ? 'mega_bot' : 'nanoclaw_bot'),
): Promise<Recorded> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tg-flow-'));
  fs.mkdirSync(path.join(root, 'src/channels'), { recursive: true });
  fs.mkdirSync(path.join(root, 'setup'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/channels/index.ts'), '');
  // The pair-telegram loader appends inside setup/index.ts's dormant marker region.
  fs.writeFileSync(
    path.join(root, 'setup/index.ts'),
    ['const STEPS = {', '  // >>> nanoclaw:setup-steps', '  // <<< nanoclaw:setup-steps', '};', ''].join('\n'),
  );
  fs.writeFileSync(path.join(root, '.env'), envBefore);
  const execs: string[] = [];
  const steps: string[] = [];
  const envValues: string[] = [];
  const res = await applySkill(SKILL_DIR, root, {
    inputs,
    exec: (cmd) => {
      execs.push(cmd);
      if (/^(git|pnpm|bash)\b/.test(cmd)) return '';
      if (cmd.startsWith('curl')) return getMe(cmd);
      return execFileSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf-8' });
    },
    execStream: async (cmd) => {
      steps.push(cmd);
      // set-env itself is trunk code (setup/set-env.ts); only its value
      // pipeline is the skill's own, so that is what runs here.
      const m = cmd.match(/--value "(\$\(.*\))"$/);
      if (m) envValues.push(execFileSync('bash', ['-c', `printf %s "${m[1]}"`], { cwd: root, encoding: 'utf-8' }));
      return { ok: true, fields: { PLATFORM_ID: 'telegram:555', ADMIN_USER_ID: '555' } };
    },
    resolveRemote: () => 'origin',
  });
  const envAfter = fs.readFileSync(path.join(root, '.env'), 'utf-8');
  fs.rmSync(root, { recursive: true, force: true });
  return { res, execs, steps, envValues, envAfter };
}

describe('Telegram add-another-bot path (add-telegram SKILL.md)', () => {
  it('first install: add_another is no without asking, the first bot is stored and paired, every add fence skips', async () => {
    const r = await run('', { bot_token: OLD_TOKEN });
    expect(fullyApplied(r.res)).toBe(true);
    expect(r.res.vars).toMatchObject({ has_default_bot: 'no', add_another: 'no' });
    expect(r.res.vars.instance).toBeUndefined();
    expect(r.res.operatorMessages).toEqual([
      expect.stringMatching(/^Create the Telegram bot:/),
      expect.stringMatching(/^Open @nanoclaw_bot /),
    ]);
    expect(r.envAfter).toBe(`TELEGRAM_BOT_TOKEN=${OLD_TOKEN}\n`);
    expect(r.steps).toEqual([PAIR_DEFAULT]);
    expect(r.res.skipped).toContain('prompt: when add_another=ask not met');
    expect(r.res.skipped.filter((s) => s.endsWith('when add_another=yes not met'))).toHaveLength(guarded('yes'));
    expect(guarded('yes')).toBeGreaterThan(0);
  });

  it('rerun, keep the existing bot: the stored token is untouched and the first bot is re-paired', async () => {
    const env = `TELEGRAM_BOT_TOKEN=${OLD_TOKEN}\n`;
    const r = await run(env, { bot_token: OLD_TOKEN, add_another: 'no' });
    expect(fullyApplied(r.res)).toBe(true);
    expect(r.res.vars).toMatchObject({ has_default_bot: 'yes', add_another: 'no' });
    // The bot exists: no BotFather walkthrough, straight to its pairing note.
    expect(r.res.operatorMessages).toEqual([expect.stringMatching(/^Open @nanoclaw_bot /)]);
    expect(r.envAfter).toBe(env);
    expect(r.steps).toEqual([PAIR_DEFAULT]);
    expect(r.res.skipped).toContain('env-set: TELEGRAM_BOT_TOKEN already set');
  });

  it('rerun, add another bot: suffixed token key, merged TELEGRAM_INSTANCES, instance-bound pairing, first bot untouched', async () => {
    const env = `TELEGRAM_BOT_TOKEN=${OLD_TOKEN}\nTELEGRAM_INSTANCES=mega\n`;
    const r = await run(env, { bot_token: OLD_TOKEN, add_another: 'yes', bot_name: 'gh-bot', bot_token_2: NEW_TOKEN });
    expect(fullyApplied(r.res)).toBe(true);
    expect(r.res.vars).toMatchObject({
      add_another: 'yes',
      bot_name: 'gh-bot',
      bot_name_env: 'GH_BOT',
      bot_username_2: 'mega_bot',
      instance: 'telegram-gh-bot',
      platform_id: 'telegram:555',
      owner_handle: '555',
    });
    expect(r.steps).toEqual([
      `pnpm exec tsx setup/index.ts --step set-env -- --key TELEGRAM_BOT_TOKEN_GH_BOT --value ${NEW_TOKEN}`,
      expect.stringContaining('--step set-env -- --key TELEGRAM_INSTANCES --value "$('),
      `${PAIR_DEFAULT} --instance telegram-gh-bot`,
    ]);
    expect(r.envValues).toEqual(['gh-bot,mega']); // existing names kept, new one merged, no duplicates
    expect(r.res.operatorMessages).toEqual([
      expect.stringMatching(/^Create the second Telegram bot/),
      expect.stringMatching(/^Open @mega_bot /),
    ]);
    expect(r.envAfter).toBe(env); // the first bot's fences are no-ops here: env-set never overwrites
    expect(r.res.skipped.filter((s) => s.endsWith('when add_another=no not met'))).toHaveLength(guarded('no'));
    expect(r.execs.filter((c) => /restart\.sh/.test(c))).toHaveLength(1);
  });

  it('rerun, add another bot under a taken name: the collision check refuses before any write, restart or pairing', async () => {
    const env = `TELEGRAM_BOT_TOKEN=${OLD_TOKEN}\nTELEGRAM_INSTANCES=mega\nTELEGRAM_BOT_TOKEN_MEGA=${NEW_TOKEN}\n`;
    const r = await run(env, { bot_token: OLD_TOKEN, add_another: 'yes', bot_name: 'mega', bot_token_2: NEW_TOKEN });
    expect(fullyApplied(r.res)).toBe(false);
    expect(r.res.agentTasks[0]).toMatchObject({ kind: 'run', prose: expect.stringContaining('Add another bot') });
    expect(r.steps).toEqual([]);
    expect(r.execs.some((c) => /restart\.sh/.test(c))).toBe(false);
    expect(r.envAfter).toBe(env);
  });

  it('rerun, add another bot with a token for the bot already configured: the same-bot check refuses before any write, restart or pairing', async () => {
    const env = `TELEGRAM_BOT_TOKEN=${OLD_TOKEN}\n`;
    // A different token string (a BotFather /token regeneration) that getMe resolves to the first bot.
    const r = await run(
      env,
      { bot_token: OLD_TOKEN, add_another: 'yes', bot_name: 'mega', bot_token_2: NEW_TOKEN },
      () => 'nanoclaw_bot',
    );
    expect(fullyApplied(r.res)).toBe(false);
    expect(r.res.vars).toMatchObject({ bot_username: 'nanoclaw_bot', bot_username_2: 'nanoclaw_bot' });
    expect(r.res.agentTasks[0]).toMatchObject({ kind: 'run', prose: expect.stringContaining('same bot') });
    expect(r.steps).toEqual([]);
    expect(r.execs.some((c) => /restart\.sh/.test(c))).toBe(false);
    expect(r.envAfter).toBe(env);
  });
});
