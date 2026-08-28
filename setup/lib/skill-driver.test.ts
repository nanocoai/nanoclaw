import { describe, it, expect, vi } from 'vitest';
import * as p from '@clack/prompts';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSkill,
  hostExec,
  hostExecStream,
  labelOrdinals,
  literalChoices,
  promptValidator,
  clackResolveInput,
  applyOutcome,
  plainDuration,
  type RunSkillOptions,
} from './skill-driver.js';
import { fullyApplied, type ApplyEvent, type ApplyResult } from '../../scripts/skill-apply.js';
import { clearSensitiveValuesForTest, registerSensitiveValue } from './redaction.js';
import type { SetupDriver } from './setup-driver.js';

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
    const ran: Array<{ command: string; args: string[] }> = [];
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
      exec: (command, args = []) => void ran.push({ command, args }),
    };
    const res = await runSkill(skill, opts);

    expect(asked).toEqual([{ name: 'token', secret: true }]); // the prompt was driven through resolveInput, meta intact
    expect(told).toEqual(['Go create the app and copy the token.']); // operator relayed through the event
    expect(ran).toContainEqual({ command: 'ncl wire --token "${1}"', args: ['T0KEN'] });
    expect(res.operatorMessages).toEqual(['Go create the app and copy the token.']);
  });

  it('runs fully from inputs — resolveInput never touched', async () => {
    const { root, skill } = scratch();
    const ran: Array<{ command: string; args: string[] }> = [];
    const res = await runSkill(skill, {
      projectRoot: root,
      inputs: { token: 'FROM-INPUTS' },
      exec: (command, args = []) => void ran.push({ command, args }),
    });
    expect(fullyApplied(res)).toBe(true);
    expect(ran).toContainEqual({ command: 'ncl wire --token "${1}"', args: ['FROM-INPUTS'] });
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

  it('leaves terminal command logs unchanged by protocol redaction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-secret-'));
    const rawLog = join(root, 'raw.log');
    const secret = 'token-value';
    registerSensitiveValue(secret);
    try {
      const out = await hostExec(root, rawLog)(`printf '%s' 'prefix ${secret} suffix'`);
      expect(out).toBe(`prefix ${secret} suffix`);
      expect(readFileSync(rawLog, 'utf8')).toContain(secret);
      expect(readFileSync(rawLog, 'utf8')).not.toContain('[REDACTED]');
    } finally {
      clearSensitiveValuesForTest();
    }
  });

  it('keeps machine-mode captured output in memory and out of raw logs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-machine-capture-'));
    const rawLog = join(root, 'raw.log');
    const previous = process.env.NANOCLAW_PROTOCOL;
    process.env.NANOCLAW_PROTOCOL = 'nanoclaw.driver.v1';
    try {
      const out = await hostExec(root, rawLog)("printf 'minted-credenti%s' al");
      expect(out).toBe('minted-credential');
      expect(readFileSync(rawLog, 'utf8')).not.toContain('minted-credential');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_PROTOCOL;
      else process.env.NANOCLAW_PROTOCOL = previous;
    }
  });

  it('keeps machine-mode secret runs out of child argv, env, and raw logs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-machine-secret-'));
    const bin = join(root, 'bin');
    const probe = join(root, 'probe.json');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'onecli'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ args, env: process.env, file, value: fs.readFileSync(file, 'utf8') }));
`,
    );
    chmodSync(join(bin, 'onecli'), 0o755);
    const secret = 'machine-secret-value';
    const rawLog = join(root, 'raw.log');
    const previous = process.env.DRIVER_SECRET_PROBE;
    process.env.DRIVER_SECRET_PROBE = secret;
    try {
      const driver = { mode: 'ndjson' } as SetupDriver;
      await hostExec(root, rawLog, driver, new Set([secret]))('onecli secrets create --value "${1}"', [secret]);
      const observed = JSON.parse(readFileSync(probe, 'utf8')) as {
        args: string[];
        env: NodeJS.ProcessEnv;
        file: string;
        value: string;
      };
      expect(observed.args).toContain('--file');
      expect(observed.args).not.toContain('--value');
      expect(observed.args).not.toContain(secret);
      expect(observed.env.DRIVER_SECRET_PROBE).toBeUndefined();
      expect(observed.value).toBe(secret);
      expect(existsSync(observed.file)).toBe(false);
      expect(readFileSync(rawLog, 'utf8')).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.DRIVER_SECRET_PROBE;
      else process.env.DRIVER_SECRET_PROBE = previous;
    }
  });

  it('keeps curl secrets in a private config and out of child argv, env, and raw logs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-machine-curl-secret-'));
    const bin = join(root, 'bin');
    const probe = join(root, 'curl.json');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'curl'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--config') + 1];
fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ args, env: process.env, file, config: fs.readFileSync(file, 'utf8') }));
process.stdout.write('ok');
`,
    );
    chmodSync(join(bin, 'curl'), 0o755);
    const telegram = 'telegram-machine-secret';
    const slack = 'slack-machine-secret';
    const rawLog = join(root, 'raw.log');
    process.env.DRIVER_TELEGRAM_SECRET = telegram;
    process.env.DRIVER_SLACK_SECRET = slack;
    try {
      const driver = { mode: 'ndjson' } as SetupDriver;
      await hostExec(
        root,
        rawLog,
        driver,
        new Set([telegram, slack]),
      )('curl -sf -X POST https://example.com/channel -H "Authorization: Bot ${1}" --data-urlencode "token=${2}"', [
        telegram,
        slack,
      ]);
      const observed = JSON.parse(readFileSync(probe, 'utf8')) as {
        args: string[];
        env: NodeJS.ProcessEnv;
        file: string;
        config: string;
      };
      expect(observed.args).toEqual(['--config', observed.file]);
      expect(JSON.stringify(observed.env)).not.toContain(telegram);
      expect(JSON.stringify(observed.env)).not.toContain(slack);
      expect(observed.config).toContain(`Authorization: Bot ${telegram}`);
      expect(observed.config).toContain(`token=${slack}`);
      expect(existsSync(observed.file)).toBe(false);
      expect(readFileSync(rawLog, 'utf8')).not.toContain(telegram);
      expect(readFileSync(rawLog, 'utf8')).not.toContain(slack);
    } finally {
      delete process.env.DRIVER_TELEGRAM_SECRET;
      delete process.env.DRIVER_SLACK_SECRET;
    }
  });

  it('rejects unsupported machine secret interpolation before spawning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-machine-secret-reject-'));
    const errors: string[] = [];
    const driver = {
      mode: 'ndjson',
      error: (code: string): never => {
        errors.push(code);
        throw new Error(code);
      },
    } as unknown as SetupDriver;
    await expect(
      hostExec(root, undefined, driver, new Set(['machine-secret']))('printf "%s" "${1}"', ['machine-secret']),
    ).rejects.toThrow('secret_transport_unsupported');
    expect(errors).toEqual(['secret_transport_unsupported']);
  });

  it('stops a machine capture when combined child output exceeds its byte limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-machine-output-limit-'));
    const errors: string[] = [];
    const driver = {
      mode: 'ndjson',
      error: (code: string): never => {
        errors.push(code);
        throw new Error(code);
      },
    } as unknown as SetupDriver;

    await expect(
      hostExec(root, undefined, driver)(`node -e 'process.stdout.write("x".repeat(300000))'`),
    ).rejects.toThrow('skill_output_limit');
    expect(errors).toEqual(['skill_output_limit']);
  });

  it('keeps machine-mode streaming secret runs out of child argv and env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-machine-stream-secret-'));
    const bin = join(root, 'bin');
    const probe = join(root, 'probe.json');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'onecli'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ args, env: process.env, file, value: fs.readFileSync(file, 'utf8') }));
process.stdout.write('=== NANOCLAW SETUP: TEST ===\\nSTATUS: success\\n=== END ===\\n');
`,
    );
    chmodSync(join(bin, 'onecli'), 0o755);
    const secret = 'machine-stream-secret';
    const previous = process.env.DRIVER_STREAM_SECRET;
    process.env.DRIVER_STREAM_SECRET = secret;
    try {
      const driver = { mode: 'ndjson' } as SetupDriver;
      const result = await hostExecStream(
        root,
        driver,
        new Set([secret]),
      )('onecli secrets create --value "${1}"', [secret]);
      const observed = JSON.parse(readFileSync(probe, 'utf8')) as {
        args: string[];
        env: NodeJS.ProcessEnv;
        file: string;
        value: string;
      };
      expect(result.ok).toBe(true);
      expect(observed.args).toContain('--file');
      expect(observed.args).not.toContain(secret);
      expect(observed.env.DRIVER_STREAM_SECRET).toBeUndefined();
      expect(observed.value).toBe(secret);
      expect(existsSync(observed.file)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DRIVER_STREAM_SECRET;
      else process.env.DRIVER_STREAM_SECRET = previous;
    }
  });

  it('hostExecStream runs a step and captures the terminal status block fields (for effect:step)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-step-'));
    const out = await hostExecStream(root)(
      'echo show-this-to-the-operator; echo "=== NANOCLAW SETUP: PAIR ==="; echo "STATUS: success"; echo "PLATFORM_ID: telegram:42"; echo "=== END ==="',
    );
    expect(out.ok).toBe(true);
    expect(out.fields.PLATFORM_ID).toBe('telegram:42');
  });

  it('stops a machine streaming step before an unterminated line can grow without bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-machine-stream-limit-'));
    const errors: string[] = [];
    const driver = {
      mode: 'ndjson',
      error: (code: string): never => {
        errors.push(code);
        throw new Error(code);
      },
    } as unknown as SetupDriver;

    await expect(hostExecStream(root, driver)(`node -e 'process.stdout.write("x".repeat(300000))'`)).rejects.toThrow(
      'skill_output_limit',
    );
    expect(errors).toEqual(['skill_output_limit']);
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

  it('maps Photon embedded blocks to replaceable sensitive displays', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-photon-'));
    const seen: string[] = [];
    const driver = {
      mode: 'ndjson',
      display: (display: { id: string; sensitive: boolean }) => seen.push(`display:${display.id}:${display.sensitive}`),
      clearDisplay: (id: string) => seen.push(`clear:${id}`),
    } as unknown as SetupDriver;
    const out = await hostExecStream(
      root,
      driver,
    )(
      [
        "printf '%s\\n' '=== NANOCLAW SETUP: PHOTON_DEVICE ===' 'URL: https://example.com/device' 'CODE: ABCD-1234' '=== END ==='",
        "printf '%s\\n' '=== NANOCLAW SETUP: PHOTON_DEVICE_CLEAR ===' '=== END ==='",
        "printf '%s\\n' '=== NANOCLAW SETUP: PHOTON_OPT_IN ===' 'PHONE: +15551234567' 'LINE: +15558887777' '=== END ==='",
        "printf '%s\\n' '=== NANOCLAW SETUP: PHOTON_OPT_IN_CLEAR ===' '=== END ==='",
        "printf '%s\\n' '=== NANOCLAW SETUP: PHOTON ===' 'STATUS: success' 'PHONE: +15551234567' '=== END ==='",
      ].join('; '),
    );
    expect(out.ok).toBe(true);
    expect(seen).toEqual([
      'display:photon-device:true',
      'clear:photon-device',
      'display:photon-opt-in:true',
      'clear:photon-opt-in',
    ]);
  });

  it('renders Teams device login as an external action in machine mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'driver-teams-'));
    const prefix = join(root, 'global');
    const bin = join(root, 'bin');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(prefix)}\n`);
    writeFileSync(
      join(prefix, 'bin', 'teams'),
      "#!/bin/sh\nprintf 'Open https://microsoft.com/devicelogin\\nEnter code ABCD-EFGH\\n=== NANOCLAW SETUP: TEAMS-LOGIN ===\\nSTATUS: success\\n=== END ===\\n'\n",
    );
    chmodSync(join(bin, 'npm'), 0o755);
    chmodSync(join(prefix, 'bin', 'teams'), 0o755);
    const actions: Array<{ kind: string; url?: string }> = [];
    const displays: Array<{ id: string; kind: string; sensitive: boolean; content?: string }> = [];
    const cleared: string[] = [];
    const driver = {
      mode: 'ndjson',
      externalAction: async (action: { kind: string; url?: string }, verify: () => boolean | Promise<boolean>) => {
        actions.push(action);
        expect(await verify()).toBe(true);
        return 'attempted' as const;
      },
      display: (display: { id: string; kind: string; sensitive: boolean; content?: string }) => displays.push(display),
      clearDisplay: (id: string) => cleared.push(id),
    } as unknown as SetupDriver;
    const result = await hostExecStream(
      root,
      driver,
    )('"$(npm prefix -g 2>/dev/null)/bin/teams" login && echo \'"loggedIn": true\'');
    expect(result.ok).toBe(true);
    expect(actions).toEqual([
      {
        id: 'teams-login-open-url',
        kind: 'openURL',
        title: 'Open Microsoft device login',
        url: 'https://microsoft.com/devicelogin',
      },
    ]);
    expect(displays).toEqual([
      expect.objectContaining({ id: 'teams-login-url', kind: 'url', sensitive: true }),
      expect.objectContaining({ id: 'teams-login-code', kind: 'code', content: 'ABCD-EFGH', sensitive: true }),
    ]);
    expect(cleared).toEqual(['teams-login-url', 'teams-login-code']);
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
    const calls: Array<{ command: string; args: string[] }> = [];
    await runSkill(skill, {
      projectRoot: root,
      reuse: true,
      confirm: async () => true, // yes, reuse the existing value
      resolveInput: async (n) => {
        asked.push(n);
        return 'NEWLY-PASTED';
      },
      exec: (command, args = []) => void calls.push({ command, args }),
    });
    expect(asked).not.toContain('bot_token'); // reused from .env → never prompted
    expect(calls).toContainEqual({ command: 'use "${1}"', args: ['xoxb-existing-token'] });
  });

  it('does not expose credential fragments in a machine reuse prompt', async () => {
    const { root, skill } = reuseScratch();
    const prompts: string[] = [];
    const driver = {
      mode: 'ndjson',
      prompt: async (spec: { message: string }) => {
        prompts.push(spec.message);
        return true;
      },
    } as unknown as SetupDriver;

    await runSkill(skill, {
      projectRoot: root,
      reuse: true,
      driver,
      exec: () => {},
    });

    expect(prompts).toContain('Found an existing SLACK_BOT_TOKEN. Use it?');
    expect(prompts.join('\n')).not.toContain('xoxb-e');
    expect(prompts.join('\n')).not.toContain('oken');
  });

  it('reuse: declining keeps the prompt', async () => {
    const { root, skill } = reuseScratch();
    const asked: string[] = [];
    const calls: Array<{ command: string; args: string[] }> = [];
    await runSkill(skill, {
      projectRoot: root,
      reuse: true,
      confirm: async () => false, // no, ask me
      resolveInput: async (n) => {
        asked.push(n);
        return 'NEWLY-PASTED';
      },
      exec: (command, args = []) => void calls.push({ command, args }),
    });
    expect(asked).toContain('bot_token'); // declined → prompted
    expect(calls).toContainEqual({ command: 'use "${1}"', args: ['NEWLY-PASTED'] });
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
    const calls: Array<{ command: string; args: string[] }> = [];
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
      exec: (command, args = []) => void calls.push({ command, args }),
    });
    expect(confirmed.some((m) => /IMESSAGE_SERVER_URL/.test(m))).toBe(true); // the reuse: link surfaced the offer
    expect(asked).not.toContain('server_url'); // accepted → never re-prompted
    expect(calls).toContainEqual({
      command: 'bash configure.sh "${1}"',
      args: ['https://photon.example.com'],
    });
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

  it('machine driver preserves URL-offer and natural-barrier policy before the side effect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-policy-'));
    const skill = mkdtempSync(join(tmpdir(), 'machine-policy-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# machine policy\n\n```nc:operator\nOpen https://example.com/setup and finish.\n```\n```nc:run effect:build\necho build\n```\n',
    );
    const calls: string[] = [];
    const driver = {
      mode: 'ndjson',
      operation: 'setup',
      prompt: async (spec: { message: string }) => {
        calls.push(`prompt:${spec.message}`);
        return true;
      },
      display: (display: { kind: string }) => {
        calls.push(`display:${display.kind}`);
      },
      note: () => {
        calls.push('note');
      },
      progress: (_id: string, state: string) => {
        calls.push(`progress:${state}`);
      },
      throwIfCancelled: () => {},
    } as unknown as SetupDriver;

    await runSkill(skill, {
      projectRoot: root,
      driver,
      exec: () => {
        calls.push('exec');
      },
    });

    expect(calls).toEqual([
      'note',
      'prompt:Open https://example.com/setup in your browser?',
      'display:url',
      "prompt:Done with the steps above? Continue when you're ready.",
      'progress:pending',
      'progress:running',
      'exec',
      'progress:succeeded',
    ]);
  });

  it('stops before a later skill side effect when the driver is cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-cancel-'));
    const skill = mkdtempSync(join(tmpdir(), 'machine-cancel-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# cancel\n\n```nc:run effect:build\nfirst\n```\n```nc:run effect:wire\nsecond\n```\n',
    );
    let cancelled = false;
    const commands: string[] = [];
    const driver = {
      mode: 'ndjson',
      operation: 'setup',
      progress: () => {},
      throwIfCancelled: () => {
        if (cancelled) throw new Error('driver cancelled');
      },
    } as unknown as SetupDriver;

    await expect(
      runSkill(skill, {
        projectRoot: root,
        driver,
        exec: (command) => {
          commands.push(command);
          cancelled = true;
        },
      }),
    ).rejects.toThrow('driver cancelled');

    expect(commands).toEqual(['first']);
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

describe('applyOutcome (the CLI verdict a nesting effect:step reads)', () => {
  const base: ApplyResult = {
    deferred: [],
    agentTasks: [],
    journal: [],
    vars: {},
    operatorMessages: [],
  } as unknown as ApplyResult;

  it('a full apply is success / exit 0', () => {
    expect(applyOutcome(base)).toEqual({ status: 'success', exitCode: 0 });
  });

  it('deferred input or a bounced directive is failed / exit 1 — never a silent success to the caller', () => {
    expect(applyOutcome({ ...base, deferred: ['token'] })).toEqual({ status: 'failed', exitCode: 1 });
    expect(
      applyOutcome({
        ...base,
        agentTasks: [{ line: 3, kind: 'run', reason: 'exit 1: boom' }] as ApplyResult['agentTasks'],
      }),
    ).toEqual({ status: 'failed', exitCode: 1 });
  });
});

describe('non-TTY step lines (CI logs, a nested apply under the parent driver)', () => {
  it('plainDuration mirrors the spinner suffix', () => {
    expect(plainDuration(400)).toBe('(0s)');
    expect(plainDuration(3_200)).toBe('(3s)');
    expect(plainDuration(102_000)).toBe('(1m 42s)');
  });

  it('prints one plain line per finished step when stdout is not a TTY, instead of silence', async () => {
    // vitest's stdout is a pipe, so the default handler takes the non-TTY path.
    expect(process.stdout.isTTY).toBeFalsy();
    const root = mkdtempSync(join(tmpdir(), 'sd-plain-'));
    const skill = join(root, '.claude/skills/plain');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}\n');
    writeFileSync(
      join(skill, 'SKILL.md'),
      ['# Plain', '', '## Build the image', '', '```nc:run effect:build', 'echo build', '```', ''].join('\n'),
    );
    const success = vi.spyOn(p.log, 'success').mockImplementation(() => {});
    const res = await runSkill(skill, { projectRoot: root, exec: () => '' });
    expect(fullyApplied(res)).toBe(true);
    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0][0]).toMatch(/^Build the image \(\d+s\)$/);
    success.mockRestore();
  });
});

describe('headless confirm invariant (terminal driver, stdout not a TTY)', () => {
  // Every terminal-channel install now hands runSkill a driver, so the driver's
  // presence must not decide the confirm seam on its own. A terminal run
  // redirected to a log file has a driver and no TTY, and it has to keep
  // defaultConfirm's invariant: resolve true WITHOUT prompting, so a scripted
  // install with full inputs never stalls at a URL offer or a natural barrier.
  it('terminal driver + non-TTY stdout: confirm proceeds without prompting the driver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'headless-confirm-'));
    const skill = mkdtempSync(join(tmpdir(), 'headless-confirm-skill-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '# headless demo\n\n## Portal step\nTell the user:\n```nc:operator\nOpen https://example.com/setup and finish the app.\n```\n\n## Build\n```nc:run effect:build\necho build\n```\n',
    );
    const prompted: string[] = [];
    const driver = {
      mode: 'terminal',
      operation: 'setup',
      prompt: async (spec: { message: string }) => {
        prompted.push(spec.message);
        return true;
      },
      note: () => {},
      progress: () => {},
      throwIfCancelled: () => {},
    } as unknown as SetupDriver;

    const prevTTY = process.stdout.isTTY;
    process.stdout.isTTY = false; // a headless run: setup redirected to a log file
    const opened: string[] = [];
    const ran: string[] = [];
    try {
      // `confirm` is deliberately NOT injected here: the default seam is the thing under test.
      const res = await runSkill(skill, {
        projectRoot: root,
        driver,
        openUrl: async (u) => void opened.push(u),
        exec: (command) => void ran.push(command),
      });
      expect(prompted).toEqual([]); // never stalled: no URL offer, no barrier question
      expect(opened).toEqual(['https://example.com/setup']); // auto-accepted, so the open still happened
      expect(ran).toEqual(['echo build']); // and the gated side effect still ran
      expect(fullyApplied(res)).toBe(true);
    } finally {
      process.stdout.isTTY = prevTTY;
    }
  });
});
