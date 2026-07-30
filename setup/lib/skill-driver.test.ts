import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSkill, hostExec, hostExecStream, labelOrdinals, literalChoices, promptValidator, clackResolveInput, type RunSkillOptions } from './skill-driver.js';
import { fullyApplied, type ApplyEvent } from '../../scripts/skill-apply.js';

// Shared test state for the clack + claude-handoff mocks (hoisted so the vi.mock
// factories — which run before imports — can close over it). `answers` is the
// queue each mocked text/password prompt pops from; `handoffSpy` stands in for
// the interactive Claude handoff; `lastValidate` captures the validate callback
// the resolveInput impl handed clack so we can prove the `?` help-escape is wired.
const ce = vi.hoisted(() => ({
  handoffSpy: vi.fn(async (_ctx: { channel: string; step: string; stepDescription: string }) => true),
  answers: [] as string[],
  lastValidate: { fn: undefined as undefined | ((v: string) => string | Error | void | undefined) },
  lastSelectOptions: { values: undefined as undefined | string[] },
}));

// Keep isHelpEscape + validateWithHelpEscape real (clackResolveInput uses them);
// only the interactive handoff is replaced with a spy so the test never spawns Claude.
vi.mock('./claude-handoff.js', async (importActual) => {
  const actual = await importActual<typeof import('./claude-handoff.js')>();
  return { ...actual, offerClaudeHandoff: ce.handoffSpy };
});

// Drive clackResolveInput's prompts from the `answers` queue and record the
// validate callback it passes through, instead of opening a real TTY prompt.
vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  const fromQueue = async (o: { validate?: (v: string) => string | Error | void | undefined }): Promise<string> => {
    ce.lastValidate.fn = o?.validate;
    return ce.answers.shift() ?? '';
  };
  const fromQueueSelect = async (o: { options: Array<{ value: string }> }): Promise<string> => {
    ce.lastSelectOptions.values = o.options.map((x) => x.value);
    return ce.answers.shift() ?? o.options[0].value;
  };
  return { ...actual, text: vi.fn(fromQueue), password: vi.fn(fromQueue), select: vi.fn(fromQueueSelect) };
});

// A small SKILL.md exercising the three things the driver wires: an operator
// block (emitted as an operator event), a secret prompt (collected via
// resolveInput), and a wire run (executed via exec) consuming the captured input.
const SKILL = `# driver demo

## Set up
Tell the user:
\`\`\`nc:operator
Go create the app and copy the token.
\`\`\`
\`\`\`nc:prompt token secret
Paste the token.
\`\`\`

## Wire
\`\`\`nc:run effect:wire
ncl wire --token {{token}}
\`\`\`
`;

function scratch(): { root: string; skill: string } {
  const root = mkdtempSync(join(tmpdir(), 'driver-'));
  const skill = mkdtempSync(join(tmpdir(), 'driver-skill-'));
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(skill, 'SKILL.md'), SKILL);
  return { root, skill };
}

describe('thin skill driver', () => {
  it('resolves prompts via resolveInput, emits operator events, and execs wiring', async () => {
    const { root, skill } = scratch();
    const asked: Array<{ name: string; secret: boolean }> = [];
    const told: string[] = [];
    const ran: string[] = [];
    const opts: RunSkillOptions = {
      projectRoot: root,
      resolveInput: async (name, meta) => {
        asked.push({ name, secret: meta.secret });
        return 'T0KEN';
      },
      // An injected onEvent REPLACES the default policy handler (the injector owns its I/O).
      onEvent: (e: ApplyEvent) => {
        if (e.type === 'operator') told.push(e.text);
      },
      exec: (c) => void ran.push(c),
    };
    const res = await runSkill(skill, opts);

    expect(asked).toEqual([{ name: 'token', secret: true }]); // the prompt was driven through resolveInput, meta intact
    expect(told).toEqual(['Go create the app and copy the token.']); // operator relayed through the event
    expect(ran).toContain('ncl wire --token T0KEN'); // wiring executed with the answer substituted in
    expect(res.operatorMessages).toEqual(['Go create the app and copy the token.']);
  });

  it('runs fully from inputs — resolveInput never touched', async () => {
    const { root, skill } = scratch();
    const ran: string[] = [];
    const res = await runSkill(skill, { projectRoot: root, inputs: { token: 'FROM-INPUTS' }, exec: (c) => void ran.push(c) });
    expect(fullyApplied(res)).toBe(true);
    expect(ran).toContain('ncl wire --token FROM-INPUTS');
  });

  it('emits step events through an injected onEvent — the wire run under its heading', async () => {
    const { root, skill } = scratch();
    const starts: Array<{ kind: string; label: string | null }> = [];
    await runSkill(skill, {
      projectRoot: root,
      inputs: { token: 'T' },
      exec: () => {},
      onEvent: (e) => {
        if (e.type === 'step-start') starts.push({ kind: e.kind, label: e.label });
      },
    });
    // the demo SKILL's only mutating step is `nc:run effect:wire` under `## Wire`
    expect(starts).toEqual([{ kind: 'run', label: 'Wire' }]);
  });

  it('hostExec puts the project bin/ on PATH so a bare command resolves to it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-bin-'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/greet'), '#!/usr/bin/env bash\necho hi-from-bin\n');
    chmodSync(join(root, 'bin/greet'), 0o755);
    const out = await hostExec(root)('greet'); // bare name, not ./bin/greet
    expect(String(out).trim()).toBe('hi-from-bin');
  });

  it('hostExec returns stdout so a capture run can bind it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-cap-'));
    expect(String(await hostExec(root)('echo D0CHANNEL')).trim()).toBe('D0CHANNEL');
  });

  it('hostExec recomposes a failure as `exit <code>: <first stderr line>` with the full stderr kept below', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-fail-'));
    const run = (): Promise<string> => hostExec(root)('echo "boom: first line" >&2; echo "stack line two" >&2; exit 7');
    await expect(run).rejects.toThrow(/^exit 7: boom: first line/); // one-line consumers read this
    await expect(run).rejects.toThrow(/stack line two/); // full stderr survives for the agentTask reason
  });

  it('hostExec tees each command + stdout/stderr to the raw log, success and failure alike', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-tee-'));
    const rawLog = join(root, 'raw.log');
    const exec = hostExec(root, rawLog);
    await exec('echo out-line; echo warn-line >&2');
    await expect(exec('echo dying-gasp >&2; exit 3')).rejects.toThrow(/exit 3/);
    const log = readFileSync(rawLog, 'utf8');
    expect(log).toContain('$ echo out-line; echo warn-line >&2');
    expect(log).toContain('out-line');
    expect(log).toContain('warn-line'); // stderr captured, not echoed to the wizard
    expect(log).toContain('$ echo dying-gasp >&2; exit 3');
    expect(log).toContain('dying-gasp'); // the failing command's output survives too
  });

  it('hostExecStream runs a step and captures the terminal status block fields (for effect:step)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-step-'));
    const out = await hostExecStream(root)(
      'echo show-this-to-the-operator; echo "=== NANOCLAW SETUP: PAIR ==="; echo "STATUS: success"; echo "PLATFORM_ID: telegram:42"; echo "=== END ==="',
    );
    expect(out.ok).toBe(true);
    expect(out.fields.PLATFORM_ID).toBe('telegram:42');
  });

  it('hostExecStream children run with LOG_LEVEL=warn — host logger info noise stays off the wizard', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-loglevel-'));
    const prev = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL; // simulate an operator who didn't set one
    try {
      const out = await hostExecStream(root)(
        'echo "=== NANOCLAW SETUP: ENV ==="; echo "STATUS: success"; echo "LVL: $LOG_LEVEL"; echo "=== END ==="',
      );
      expect(out.fields.LVL).toBe('warn');
    } finally {
      if (prev !== undefined) process.env.LOG_LEVEL = prev;
    }
  });

  function reuseScratch(): { root: string; skill: string } {
    const root = mkdtempSync(join(tmpdir(), 'reuse-'));
    const skill = mkdtempSync(join(tmpdir(), 'reuse-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(root, '.env'), 'SLACK_BOT_TOKEN=xoxb-existing-token\n');
    // a skill whose env-set maps bot_token → SLACK_BOT_TOKEN (the reuse linkage)
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# reuse demo\n\n```nc:prompt bot_token secret\nPaste the token.\n```\n```nc:env-set\nSLACK_BOT_TOKEN={{bot_token}}\n```\n```nc:run effect:wire\nuse {{bot_token}}\n```\n',
    );
    return { root, skill };
  }

  it('reuse:true offers an existing .env credential via the confirm seam and skips the prompt when accepted', async () => {
    const { root, skill } = reuseScratch();
    const asked: string[] = [];
    const cmds: string[] = [];
    await runSkill(skill, {
      projectRoot: root,
      reuse: true,
      confirm: async () => true, // yes, reuse the existing value
      resolveInput: async (n) => {
        asked.push(n);
        return 'NEWLY-PASTED';
      },
      exec: (c) => void cmds.push(c),
    });
    expect(asked).not.toContain('bot_token'); // reused from .env → never prompted
    expect(cmds).toContain('use xoxb-existing-token'); // the reused value flowed downstream
  });

  it('reuse: declining keeps the prompt', async () => {
    const { root, skill } = reuseScratch();
    const asked: string[] = [];
    const cmds: string[] = [];
    await runSkill(skill, {
      projectRoot: root,
      reuse: true,
      confirm: async () => false, // no, ask me
      resolveInput: async (n) => {
        asked.push(n);
        return 'NEWLY-PASTED';
      },
      exec: (c) => void cmds.push(c),
    });
    expect(asked).toContain('bot_token'); // declined → prompted
    expect(cmds).toContain('use NEWLY-PASTED');
  });

  // A cred a HELPER SCRIPT owns (written by effect:external, not nc:env-set) has no
  // env-set→ENV_KEY linkage to infer. An explicit `nc:prompt … reuse:<ENV_KEY>`
  // restores the masked reuse offer — the imessage Photon case.
  function helperReuseScratch(): { root: string; skill: string } {
    const root = mkdtempSync(join(tmpdir(), 'reuse-helper-'));
    const skill = mkdtempSync(join(tmpdir(), 'reuse-helper-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    // present in .env, but NOT written by any nc:env-set in the skill below
    writeFileSync(join(root, '.env'), 'IMESSAGE_SERVER_URL=https://photon.example.com\n');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# helper reuse demo\n\n```nc:prompt server_url validate:^https?:// reuse:IMESSAGE_SERVER_URL\nYour Photon server URL.\n```\n```nc:run effect:external\nbash configure.sh "{{server_url}}"\n```\n',
    );
    return { root, skill };
  }

  it('reuse: offers an existing .env value for a HELPER-owned cred (no env-set linkage)', async () => {
    const { root, skill } = helperReuseScratch();
    const asked: string[] = [];
    const cmds: string[] = [];
    const confirmed: string[] = [];
    await runSkill(skill, {
      projectRoot: root,
      reuse: true,
      confirm: async (msg) => {
        confirmed.push(msg);
        return true; // yes, reuse the existing helper-owned value
      },
      resolveInput: async (n) => {
        asked.push(n);
        return 'https://typed.example';
      },
      exec: (c) => void cmds.push(c),
    });
    expect(confirmed.some((m) => /IMESSAGE_SERVER_URL/.test(m))).toBe(true); // the reuse: link surfaced the offer
    expect(asked).not.toContain('server_url'); // accepted → never re-prompted
    expect(cmds).toContain('bash configure.sh "https://photon.example.com"'); // reused value flowed downstream
  });

  // §5.4 pre-filter: a stale .env value that would fail the prompt's declared
  // validate-at-bind is NEVER offered — the operator is prompted fresh instead
  // of the reused input rejecting loudly with no interactive recovery.
  it('reuse: a stale .env value failing the prompt validate is never offered — prompted fresh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reuse-stale-'));
    const skill = mkdtempSync(join(tmpdir(), 'reuse-stale-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(root, '.env'), 'SLACK_BOT_TOKEN=legacy-not-a-bot-token\n'); // fails ^xoxb-
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# stale reuse demo\n\n```nc:prompt bot_token secret validate:^xoxb-\nPaste the token.\n```\n```nc:env-set\nSLACK_BOT_TOKEN={{bot_token}}\n```\n```nc:run effect:wire\nuse {{bot_token}}\n```\n',
    );
    const asked: string[] = [];
    const confirmed: string[] = [];
    const res = await runSkill(skill, {
      projectRoot: root,
      reuse: true,
      confirm: async (m) => {
        confirmed.push(m);
        return true;
      },
      resolveInput: async (n) => {
        asked.push(n);
        return 'xoxb-fresh-token';
      },
      exec: () => {},
    });
    expect(confirmed).toHaveLength(0); // the stale value was silently not offered
    expect(asked).toContain('bot_token'); // prompted fresh
    expect(fullyApplied(res)).toBe(true); // no §4 dead-end
  });

  it('reuse pre-filter mirrors bind order: normalize-then-validate, so a normalizable value still offers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reuse-norm-'));
    const skill = mkdtempSync(join(tmpdir(), 'reuse-norm-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(root, '.env'), 'BASE_URL=https://x.example/\n'); // trailing slash — valid only after rstrip-slash
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# norm reuse demo\n\n```nc:prompt base_url normalize:rstrip-slash validate:^https://[^/]+$\nYour base URL.\n```\n```nc:env-set\nBASE_URL={{base_url}}\n```\n',
    );
    const confirmed: string[] = [];
    const res = await runSkill(skill, {
      projectRoot: root,
      reuse: true,
      confirm: async (m) => {
        confirmed.push(m);
        return true;
      },
      resolveInput: async () => undefined,
      exec: () => {},
    });
    expect(confirmed.some((m) => /BASE_URL/.test(m))).toBe(true); // offered — normalized form passes
    expect(fullyApplied(res)).toBe(true); // engine normalizes at bind, so it binds cleanly too
  });

  // The default onEvent policy handler (never injected here — injecting onEvent
  // would replace the policy, §5.0): note → URL offer (confirm → openUrl) →
  // natural-barrier confirm, all through the injectable confirm/openUrl seams.
  it('default handler: offers the operator-body URL, then the barrier confirm — in that order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offer-'));
    const skill = mkdtempSync(join(tmpdir(), 'offer-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# offer demo\n\n## Portal step\nTell the user:\n```nc:operator\nOpen https://example.com/setup and finish the app.\n```\n\n## Build\n```nc:run effect:build\necho build\n```\n',
    );
    const confirms: string[] = [];
    const opened: string[] = [];
    const res = await runSkill(skill, {
      projectRoot: root,
      exec: () => {},
      confirm: async (m) => {
        confirms.push(m);
        return true;
      },
      openUrl: async (u) => void opened.push(u),
    });
    expect(opened).toEqual(['https://example.com/setup']); // offered + accepted → opened
    expect(confirms).toEqual([
      'Open https://example.com/setup in your browser?',
      "Done with the steps above? Continue when you're ready.", // run barrier, completed flavor
    ]);
    expect(fullyApplied(res)).toBe(true);
  });

  it('default handler: readiness flavor before an effect:step; decline = proceed (never an abort)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-step-'));
    const skill = mkdtempSync(join(tmpdir(), 'gate-step-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# gate demo\n\n## Pair\nTell the user:\n```nc:operator\nA pairing code is about to appear.\n```\n```nc:run effect:step capture:pid=PID\npair-now\n```\n',
    );
    const confirms: string[] = [];
    const res = await runSkill(skill, {
      projectRoot: root,
      exec: () => {},
      execStream: async () => ({ ok: true, fields: { PID: 'p1' } }),
      confirm: async (m) => {
        confirms.push(m);
        return false; // DECLINE everything — the barrier is a pause, not a branch
      },
      openUrl: async () => {},
    });
    expect(confirms).toEqual(['Ready? The next step starts immediately.']); // no URL in the body → only the barrier
    expect(res.vars.pid).toBe('p1'); // the step still ran — decline proceeded
    expect(fullyApplied(res)).toBe(true);
  });

  it('default handler: declining the URL offer skips the open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offer-no-'));
    const skill = mkdtempSync(join(tmpdir(), 'offer-no-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# offer decline demo\n\n```nc:operator\nGo to https://example.com/app and make the app.\n```\n',
    );
    const opened: string[] = [];
    await runSkill(skill, {
      projectRoot: root,
      exec: () => {},
      confirm: async () => false,
      openUrl: async (u) => void opened.push(u),
    });
    expect(opened).toHaveLength(0); // declined → never opened
  });

  it('clackResolveInput intercepts a lone "?" → hands off to Claude with context, then re-asks', async () => {
    const prevTTY = process.stdout.isTTY;
    process.stdout.isTTY = true; // the `?` help-escape only fires at a real terminal
    try {
      ce.handoffSpy.mockClear();
      ce.answers = ['?', 'real-token']; // first answer is the help-escape, second is the real value
      const ans = await clackResolveInput({ channel: 'telegram', step: 'paste-token' })('token', {
        question: 'Paste your token.',
        secret: false,
        validate: '^[0-9a-zA-Z-]+$',
      });
      expect(ans).toBe('real-token'); // re-asked after the handoff, returns the second answer
      expect(ce.handoffSpy).toHaveBeenCalledTimes(1);
      expect(ce.handoffSpy.mock.calls[0][0]).toEqual({
        channel: 'telegram',
        step: 'paste-token',
        stepDescription: 'Paste your token.',
      });
      // The validate handed to clack lets `?` through (so the escape reaches us)
      // but still rejects a value that fails the prompt's own regex.
      expect(ce.lastValidate.fn?.('?')).toBeUndefined();
      expect(ce.lastValidate.fn?.('has space')).toBeTruthy();
    } finally {
      process.stdout.isTTY = prevTTY;
    }
  });

  it('clackResolveInput renders an either/or validate as an arrow-key select over the literal choices', async () => {
    ce.answers = ['webhook'];
    ce.lastSelectOptions.values = undefined;
    const ans = await clackResolveInput()('connection', {
      question: 'How should Slack deliver events?',
      secret: false,
      validate: '^(socket|webhook)$',
    });
    expect(ans).toBe('webhook');
    expect(ce.lastSelectOptions.values).toEqual(['socket', 'webhook']); // the options came from the regex
  });

  it('clackResolveInput passes a normal answer straight through — no handoff', async () => {
    ce.handoffSpy.mockClear();
    ce.answers = ['just-a-token'];
    const ans = await clackResolveInput({ channel: 'telegram', step: 'paste-token' })('token', {
      question: 'Paste your token.',
      secret: false,
    });
    expect(ans).toBe('just-a-token');
    expect(ce.handoffSpy).not.toHaveBeenCalled();
  });

  it('promptValidator honors flags:i and derives its rejection message from the question prose', () => {
    const question = 'Paste your public base URL (looks like `https://abcd1234.ngrok.io`).';
    const ci = promptValidator('^https://', 'i', question);
    expect(ci).toBeDefined();
    expect(ci!('HTTPS://example.com')).toBeUndefined(); // case-insensitive match passes
    // the message is the generic lead-in + the QUESTION prose — the prose
    // describes the expected shape, so no authored error: string exists anymore
    expect(ci!('ftp://example.com')).toBe(`That doesn't match the expected format. ${question}`);
    expect(promptValidator(undefined, undefined, question)).toBeUndefined(); // no regex ⇒ no validator
  });
});

// An either/or `nc:prompt` renders as a select — the choices come from the
// validate regex itself (no grammar addition). Only a fully-anchored
// pure-literal alternation qualifies; anything with real regex syntax stays a
// text prompt (SSF-003).
describe('literalChoices (either/or prompt → select)', () => {
  it('extracts the choices from a pure-literal alternation', () => {
    expect(literalChoices('^(socket|webhook)$')).toEqual(['socket', 'webhook']);
    expect(literalChoices('^(qr|pairing-code)$')).toEqual(['qr', 'pairing-code']);
    expect(literalChoices('^(SingleTenant|MultiTenant)$')).toEqual(['SingleTenant', 'MultiTenant']);
  });

  it('leaves prefixes, format unions, and non-alternations as text prompts', () => {
    expect(literalChoices('^xoxb-')).toBeNull(); // unanchored prefix
    expect(literalChoices('^https?://')).toBeNull(); // regex metachars
    expect(literalChoices('^(\\+\\d{8,15}|[^\\s@]+@[^\\s@]+\\.[^\\s@]+)$')).toBeNull(); // imessage phone|email union
    expect(literalChoices('^[0-9a-zA-Z-]+$')).toBeNull(); // char class, no alternation
    expect(literalChoices('^(solo)$')).toBeNull(); // one option is not a choice
    expect(literalChoices(undefined)).toBeNull();
  });
});

// Two steps under one heading share a spinner caption (build + test both read
// "Build and validate") — the ordinal suffix marks them as a sequence, not a
// stuttered duplicate. Solo captions stay unsuffixed.
describe('labelOrdinals (repeated-caption disambiguation)', () => {
  const MD = [
    '# demo',
    '',
    '## Build and validate',
    '```nc:run effect:build',
    'pnpm run build',
    '```',
    '```nc:run effect:test',
    'pnpm exec vitest run x.test.ts',
    '```',
    '',
    '## Restart',
    '```nc:run effect:restart',
    'bash restart.sh',
    '```',
    '',
  ].join('\n');

  it('suffixes (1/2)/(2/2) on the shared caption and leaves the solo one alone', () => {
    const ords = labelOrdinals(MD);
    const buildLine = 4; // opening fence of the build run (1-based)
    const testLine = 7;
    const restartLine = 12;
    expect(ords.get(buildLine)).toBe(' (1/2)');
    expect(ords.get(testLine)).toBe(' (2/2)');
    expect(ords.has(restartLine)).toBe(false); // unique caption — no suffix
  });

  it('the real add-telegram build+test pair (the live stutter) gets ordinals', () => {
    const md = readFileSync(join(process.cwd(), '.claude/skills/add-telegram/SKILL.md'), 'utf8');
    const suffixes = [...labelOrdinals(md).values()];
    expect(suffixes).toContain(' (1/2)');
    expect(suffixes).toContain(' (2/2)');
  });
});
