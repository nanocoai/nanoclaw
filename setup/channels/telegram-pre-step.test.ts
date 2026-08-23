/**
 * The wizard's "add another Telegram bot" pre-step.
 *
 * What breaks without it: an operator who reruns setup with a Telegram bot
 * already configured is walked through the first-bot flow again (re-pasting
 * the same token) and never reaches the add-telegram skill's
 * when:add_another=yes fences; or the wizard asks the skill's add_another /
 * bot_name prompts a second time after the pre-step already did.
 * Kill conditions: drop `registerTelegramPreStep(...)` from companions.ts
 * (registry case); rename the returned keys or drop the TELEGRAM_BOT_TOKEN_<NAME>
 * check (unit cases); drop `instance: res.vars.instance` from the wire call or
 * the `execStream` forwarding in run-channel-skill.ts (flow cases); read the
 * token with readEnvKey instead of readEnvFile (quoted-token flow case).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Validate = (v: string | undefined) => string | Error | undefined;

// Prompts are driven from queues (the pre-step owns a select + a text prompt);
// readEnvKey reads the real .env of the scratch cwd, so nothing else is mocked.
const ui = vi.hoisted(() => ({
  selectAnswers: [] as string[],
  textAnswers: [] as string[],
  selects: [] as string[],
  validators: [] as Array<Validate>,
}));
vi.mock('../lib/bright-select.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/bright-select.js')>();
  return {
    ...actual,
    brightSelect: vi.fn(async (opts: { message: string }) => {
      ui.selects.push(opts.message);
      return ui.selectAnswers.shift();
    }),
  };
});
vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    text: vi.fn(async (opts: { validate?: Validate }) => {
      if (opts.validate) ui.validators.push(opts.validate);
      return ui.textAnswers.shift();
    }),
  };
});

import { getChannelPreStep } from './companions.js';
import { runChannelSkillWithPreStep } from './run-channel-skill.js';
import { registerTelegramPreStep } from './telegram-pre-step.js';

const originalCwd = process.cwd();
const roots: string[] = [];

function scratchRoot(env: string): string {
  const root = mkdtempSync(join(tmpdir(), 'tg-prestep-'));
  writeFileSync(join(root, '.env'), env);
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
  roots.push(root);
  process.chdir(root);
  return root;
}

function registeredStep() {
  const register = vi.fn();
  registerTelegramPreStep(register);
  expect(register).toHaveBeenCalledExactlyOnceWith('telegram', expect.any(Function));
  return register.mock.calls[0][1] as (agentName: string) => Promise<Record<string, string> | undefined>;
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  ui.selectAnswers = [];
  ui.textAnswers = [];
  ui.selects = [];
  ui.validators = [];
});

describe('telegram pre-step', () => {
  it('no TELEGRAM_BOT_TOKEN: undefined and nothing asked (the first-bot walkthrough)', async () => {
    scratchRoot('OTHER=x\nTELEGRAM_BOT_TOKEN=\n');
    await expect(registeredStep()('Nano')).resolves.toBeUndefined();
    expect(ui.selects).toEqual([]);
    expect(ui.validators).toEqual([]);
  });

  it('existing token + "Use the existing bot": add_another=no, no name asked', async () => {
    scratchRoot('TELEGRAM_BOT_TOKEN=123:abc\n');
    ui.selectAnswers = ['keep'];
    await expect(registeredStep()('Nano')).resolves.toEqual({ add_another: 'no', bot_token: '123:abc' });
    expect(ui.selects).toHaveLength(1);
    expect(ui.validators).toEqual([]);
  });

  it('existing token + "Add another bot": add_another=yes with the trimmed name', async () => {
    scratchRoot('TELEGRAM_BOT_TOKEN=123:abc\n');
    ui.selectAnswers = ['add'];
    ui.textAnswers = [' mega '];
    await expect(registeredStep()('Nano')).resolves.toEqual({
      add_another: 'yes',
      bot_name: 'mega',
      bot_token: '123:abc',
    });
  });

  it("the name validator rejects empty, malformed and token-key-taken names (the skill's own rule)", async () => {
    // `mega` is listed but has no token key: free. `gh-bot` has its key: taken.
    scratchRoot('TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_INSTANCES=mega, gh-bot\nTELEGRAM_BOT_TOKEN_GH_BOT=456:def\n');
    ui.selectAnswers = ['add'];
    ui.textAnswers = ['research'];
    await registeredStep()('Nano');
    const validate = ui.validators[0];
    expect(validate('')).toBeTruthy();
    expect(validate(undefined)).toBeTruthy();
    expect(validate('Mega')).toBeTruthy();
    expect(validate('-x')).toBeTruthy();
    expect(validate('gh-bot')).toContain('TELEGRAM_BOT_TOKEN_GH_BOT');
    expect(validate('mega')).toBeUndefined();
    expect(validate('research')).toBeUndefined();
  });

  it('companions.ts registers it for the telegram channel', () => {
    expect(getChannelPreStep('telegram')).toBeTypeOf('function');
  });
});

// The real add-telegram SKILL.md, driven through the wizard entry point with
// the registered pre-step. Only the prompts are faked: the pre-step's select +
// text above, the engine's resolveInput below (which records what the skill
// still asks). Local shell (the TELEGRAM_BOT_TOKEN probe, tr, the collision
// check, echo) runs for real against the scratch .env; git, pnpm, the restart
// and the getMe curl are stubbed; the effect:step commands (set-env writes,
// pairing) are recorded by a stubbed execStream that answers the pairing fields.
const OLD_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // valid shape: the reuse offer covers bot_token
const NEW_TOKEN = '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PAIR_DEFAULT = 'pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main';

function wizardRoot(env: string): string {
  const root = scratchRoot(env);
  cpSync(join(originalCwd, '.claude/skills/add-telegram'), join(root, '.claude/skills/add-telegram'), {
    recursive: true,
  });
  mkdirSync(join(root, 'src/channels'), { recursive: true });
  writeFileSync(join(root, 'src/channels/index.ts'), '');
  // The pair-telegram loader appends inside setup/index.ts's dormant marker region.
  mkdirSync(join(root, 'setup'));
  writeFileSync(
    join(root, 'setup/index.ts'),
    ['const STEPS = {', '  // >>> nanoclaw:setup-steps', '  // <<< nanoclaw:setup-steps', '};', ''].join('\n'),
  );
  return root;
}

async function runTelegramWizard(root: string) {
  const execs: string[] = [];
  const steps: string[] = [];
  const asked: string[] = [];
  const confirms: string[] = [];
  const notes: string[] = []; // rendered nc:operator blocks, in order: what the operator is told
  const wired: Array<{ instance?: string }> = [];
  await runChannelSkillWithPreStep('telegram', 'Bob Smith', {
    projectRoot: root,
    exec: (cmd: string): string => {
      execs.push(cmd);
      if (/^(git|pnpm|bash)\b/.test(cmd)) return '';
      if (cmd.startsWith('curl')) return cmd.includes(NEW_TOKEN) ? 'mega_bot' : 'nanoclaw_bot';
      return execFileSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf-8' });
    },
    execStream: async (cmd) => {
      steps.push(cmd);
      return { ok: true, fields: { PLATFORM_ID: 'telegram:555', ADMIN_USER_ID: '555' } };
    },
    resolveRemote: () => 'origin',
    resolveInput: async (name) => {
      asked.push(name);
      return name === 'bot_token_2' ? NEW_TOKEN : undefined;
    },
    confirm: async (message: string) => {
      confirms.push(message);
      return true;
    },
    onEvent: (e) => {
      if (e.type === 'operator') notes.push(e.text);
    }, // replaces the default note / URL-offer / gate policy: no browser open, quiet run
    agentName: 'Nano',
    role: 'owner',
    fail: async (step, msg) => {
      throw new Error(`fail(${step}): ${msg}`);
    },
    wire: (a) => {
      wired.push(a);
      return true;
    },
  });
  expect(wired).toHaveLength(1);
  return { execs, steps, asked, confirms, notes, wired, envAfter: readFileSync(join(root, '.env'), 'utf-8') };
}

describe('wizard flow through the registered pre-step (add-telegram SKILL.md)', () => {
  it('existing token + add another: the pre-bound answers satisfy the prompts, the second-bot fences run, the wire gets instance telegram-mega', async () => {
    const env = `TELEGRAM_BOT_TOKEN=${OLD_TOKEN}\n`;
    const root = wizardRoot(env);
    ui.selectAnswers = ['add'];
    ui.textAnswers = ['mega'];

    const r = await runTelegramWizard(root);

    expect(r.asked).toEqual(['bot_token_2']); // add_another, bot_name and bot_token were pre-bound
    expect(r.confirms).toEqual([]); // no "Found an existing TELEGRAM_BOT_TOKEN. Use it?" after the operator already chose
    expect(r.steps).toEqual([
      `pnpm exec tsx setup/index.ts --step set-env -- --key TELEGRAM_BOT_TOKEN_MEGA --value ${NEW_TOKEN}`,
      expect.stringContaining('--step set-env -- --key TELEGRAM_INSTANCES --value "$('),
      `${PAIR_DEFAULT} --instance telegram-mega`,
    ]);
    expect(r.execs.filter((c) => /restart\.sh/.test(c))).toHaveLength(1);
    // BotFather walkthrough for the second bot only, then its own pairing note.
    expect(r.notes).toEqual([
      expect.stringMatching(/^Create the second Telegram bot/),
      expect.stringMatching(/^Open @mega_bot /),
    ]);
    expect(r.envAfter).toBe(env); // the first bot's fences never rewrite TELEGRAM_BOT_TOKEN
    expect(r.wired[0]).toMatchObject({
      channel: 'telegram',
      userId: 'telegram:555',
      platformId: 'telegram:555',
      instance: 'telegram-mega',
    });
  });

  it('existing token + keep: no name prompt, no second-bot fence, the wire targets the default instance', async () => {
    const env = `TELEGRAM_BOT_TOKEN=${OLD_TOKEN}\n`;
    const root = wizardRoot(env);
    ui.selectAnswers = ['keep'];

    const r = await runTelegramWizard(root);

    expect(ui.validators).toEqual([]);
    expect(r.asked).toEqual([]);
    expect(r.confirms).toEqual([]);
    expect(r.notes).toEqual([expect.stringMatching(/^Open @nanoclaw_bot /)]); // no "Create the Telegram bot" after choosing to keep it
    expect(r.steps).toEqual([PAIR_DEFAULT]);
    expect(r.envAfter).toBe(env);
    expect(r.wired[0].instance).toBeUndefined();
  });

  it('a hand-quoted stored token is pre-bound unquoted (what the host reads), so the prompt validate passes and nothing is asked', async () => {
    const env = `TELEGRAM_BOT_TOKEN="${OLD_TOKEN}"\n`;
    const root = wizardRoot(env);
    ui.selectAnswers = ['keep'];

    const r = await runTelegramWizard(root);

    expect(r.asked).toEqual([]); // old code: bot_token stays quoted, fails validate-at-bind, the run fails
    expect(r.steps).toEqual([PAIR_DEFAULT]);
    expect(r.envAfter).toBe(env);
  });
});
