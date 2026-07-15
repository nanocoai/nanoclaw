import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runChannelSkill } from './run-channel-skill.js';
import { runSkill } from '../lib/skill-driver.js';
import { fullyApplied } from '../../scripts/skill-apply.js';
import { parseDirectives } from '../../scripts/skill-directives.js';
import { BACK_TO_CHANNEL_SELECTION, backGate } from '../lib/back-nav.js';

// Drive the first-prompt back gate (back-nav's brightSelect) from a queue
// instead of opening a real TTY select. Hoisted so the vi.mock factory — which
// runs before imports — can close over it. The existing Option-A tests never
// opt into offerBack (and pass `role` so askOperatorRole's brightSelect isn't
// reached either), so the mock is inert for them.
const bs = vi.hoisted(() => ({ answers: [] as string[] }));
vi.mock('../lib/bright-select.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/bright-select.js')>();
  return { ...actual, brightSelect: vi.fn(async () => bs.answers.shift() ?? 'continue') };
});

// Drives the real add-slack skill through the adapter with every side effect
// injected (no real ncl/git/clack/init-first-agent): confirms it runs the skill
// (install + creds + resolve), reads the resolved owner_handle + platform_id from
// the result, and hands them to the shared wire with a composed user-id.
describe('runChannelSkill adapter (Option A)', () => {
  it('resolves via the skill, then wires through init-first-agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const cmds: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.includes('auth.test')) return '@bot in Acme\n'; // identity capture
      // the resolve run: conversations.open piped through jq → "slack:<channel>"
      if (c.includes('conversations.open')) return 'slack:D0SLACK\n';
    };
    const wired: Array<Record<string, unknown>> = [];

    await runChannelSkill('slack', 'Bob Smith', {
      projectRoot: root,
      exec,
      resolveRemote: () => 'origin',
      agentName: 'Nano',
      role: 'owner',
      // the secrets + handle a human would supply; the skill resolves platform_id.
      // Values are valid-shaped for the prompts' validate: regexes — validate-at-bind
      // now enforces them on `inputs` too (they used to bypass validation).
      inputs: { connection: 'webhook', bot_token: 'xoxb-x', signing_secret: '0123456789abcdef', owner_handle: 'U12345678' },
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    // the channel-specific resolve ran
    expect(cmds.some((c) => c.includes('auth.test'))).toBe(true);
    expect(cmds.some((c) => c.includes('conversations.open'))).toBe(true);
    // ...and the shared wire got the composed user-id + resolved platform_id
    expect(wired).toHaveLength(1);
    expect(wired[0]).toMatchObject({
      channel: 'slack',
      userId: 'slack:U12345678', // channel + owner_handle
      platformId: 'slack:D0SLACK', // captured from conversations.open
      displayName: 'Bob Smith',
      agentName: 'Nano',
      role: 'owner',
    });
    // the adapter no longer emits any ncl wiring itself — that's init-first-agent's job
    expect(cmds.some((c) => c.startsWith('ncl '))).toBe(false);
  });

  // Teams wires inline only when a fresh create resolved the owner DM
  // (wireIfResolved). This fixture answers the have_creds probe with "yes"
  // (credentials already in .env), so every creation + resolve step — the
  // teams-login step, teams app create, the env writes, the DM-open chain,
  // the install-link operator — is when:-skipped, the wire inputs stay
  // unresolved, and the run drops through to restart without wiring.
  it('wireIfResolved (Teams): existing credentials skip the whole CLI create flow, never reach the shared wire', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-teams-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), 'TEAMS_APP_ID=existing\nTEAMS_APP_PASSWORD=existing-password\n');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const log: string[] = [];
    const wired: unknown[] = [];

    await runChannelSkill('teams', 'Acme Corp', {
      projectRoot: root,
      exec: (c) => {
        log.push(`exec:${c}`);
        if (c.includes('TEAMS_APP_ID=.')) return 'yes'; // the have_creds probe
      },
      resolveRemote: () => 'origin',
      reuse: false,
      wireIfResolved: true,
      // The injectable interaction seams — the default handler consults them for
      // the URL offer and the natural-barrier confirms, so no real clack confirm
      // (which would hang in CI) and no real browser open is reached.
      confirm: async (m) => {
        log.push(`confirm:${m}`);
        return true;
      },
      openUrl: async () => undefined,
      // NO inputs: the public_url prompt is when:have_creds=no-guarded, so the
      // drop-through path must never ask for it. If the guard regressed, the
      // prompt would defer (resolveInput undefined) and fail() would be called.
      resolveInput: async () => undefined,
      fail: async (step, msg) => {
        throw new Error(`fail() called on drop-through path: ${step} — ${msg}`);
      },
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    // the adapter install ran, but no bot was created and no login step fired…
    expect(log.some((c) => c.includes('pnpm add @chat-adapter/teams'))).toBe(true);
    expect(log.some((c) => c.includes('app create'))).toBe(false);
    expect(log.some((c) => c.includes('app update'))).toBe(false); // icon step is creation-side too
    expect(log.some((c) => c.includes('login'))).toBe(false);
    // …no logout either — the drop-through path never signed in, and must not
    // sign out a session the operator may be using for something else…
    expect(log.some((c) => c.includes('logout'))).toBe(false);
    // …the Teams CLI install is also skipped (nothing to create)…
    expect(log.some((c) => c.includes('npm install -g @microsoft/teams.cli'))).toBe(false);
    // …the service still restarts (adapter + existing credentials load)…
    expect(log.some((c) => c.includes('restart.sh'))).toBe(true);
    // …the pre-existing .env values were left alone…
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('TEAMS_APP_ID=existing');
    // …and the shared wire was never reached (no owner_handle/platform_id needed)
    expect(wired).toHaveLength(0);
  });

  // The probe's shell one-liner is dispatched by substring in the fixtures
  // above — its actual semantics (EITHER key present ⇒ yes; a partial pair
  // must NOT trigger a second `teams app create`) are asserted here by running
  // the REAL command from the REAL SKILL.md against real .env states. Parsed
  // from the document so the test can't drift from what ships.
  it('Teams have_creds probe: either credential key present answers yes', () => {
    const md = readFileSync(join(process.cwd(), '.claude/skills/add-teams/SKILL.md'), 'utf8');
    const probe = parseDirectives(md).find(
      (d) => d.kind === 'run' && d.attrs.capture === 'have_creds',
    );
    expect(probe).toBeDefined();
    const cmd = probe!.body.join('\n');

    const cases: Array<[string | null, string]> = [
      ['TEAMS_APP_ID=a\nTEAMS_APP_PASSWORD=b\n', 'yes'],
      ['TEAMS_APP_ID=a\n', 'yes'], // partial pair: creating another app would corrupt it
      ['TEAMS_APP_PASSWORD=b\n', 'yes'],
      ['OTHER=x\n', 'no'],
      ['TEAMS_APP_ID=\n', 'no'], // empty value counts as unset (mirrors env-set)
      [null, 'no'], // no .env at all
    ];
    for (const [env, expected] of cases) {
      const dir = mkdtempSync(join(tmpdir(), 'rcs-probe-'));
      if (env !== null) writeFileSync(join(dir, '.env'), env);
      const out = execSync(cmd, { cwd: dir, shell: '/bin/bash', encoding: 'utf8' }).trim();
      expect(out, `env=${JSON.stringify(env)}`).toBe(expected);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The fresh-create leg of the same document, driven at the runSkill level so
  // the effect:step gets an injected streaming exec (runChannelSkill exposes no
  // execStream seam — CI must never spawn a real `teams login`). Proves the
  // CLI-first chain end-to-end: login step → create's JSON multi-capture → the
  // env writes → the substituted install link surviving into the URL offer.
  it('Teams fresh create: login step + JSON capture drive the env writes and the install-link offer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-teams-create-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const INSTALL_LINK =
      'https://teams.microsoft.com/l/app/tapp-123?installAppPackage=true&appTenantId=tenant-1';
    const log: string[] = [];
    const opened: string[] = [];
    const steps: string[] = [];

    // The DM-open chain's expected results. The exec mock returns each
    // command's FINAL stdout (post-jq), matching what the engine captures.
    const EXPECTED_PLATFORM_ID = `teams:${Buffer.from('a:1conv').toString('base64url')}:${Buffer.from('https://smba.trafficmanager.net/teams/').toString('base64url')}`;

    const res = await runSkill('.claude/skills/add-teams', {
      projectRoot: root,
      exec: (c) => {
        log.push(`exec:${c}`);
        if (c.includes('TEAMS_APP_ID=.')) return 'no'; // the have_creds probe: nothing configured yet
        if (c.includes(' app create ')) {
          // the --json shape teams.cli@3.0.2 prints (credentials keys are UPPERCASE)
          return JSON.stringify({
            appName: 'NanoClaw',
            teamsAppId: 'tapp-123',
            botId: '12345678-1234-1234-1234-123456789abc',
            installLink: INSTALL_LINK,
            portalLink: 'https://dev.teams.microsoft.com/apps/tapp-123',
            credentials: {
              CLIENT_ID: '12345678-1234-1234-1234-123456789abc',
              CLIENT_SECRET: 'a-much-longer-app-secret',
              TENANT_ID: '87654321-4321-4321-4321-cba987654321',
            },
          });
        }
        // owner identity from the CLI session (status --json fence, plain exec)
        if (c.includes('status --json')) {
          return JSON.stringify({ loggedIn: true, username: 'dan@acme.example', tenantId: 'tenant-1', userObjectId: 'aad-owner-1' });
        }
        if (c.includes('login.microsoftonline.com')) return 'eyJfake.bot.token';
        // /members is a sub-path of /v3/conversations — match it FIRST
        if (c.includes('/members')) return JSON.stringify({ id: '29:owner-xyz', name: 'Dan Mill' });
        if (c.includes('/v3/conversations')) return 'a:1conv';
        if (c.includes('node -e')) return EXPECTED_PLATFORM_ID;
      },
      execStream: async (cmd) => {
        steps.push(cmd);
        return { ok: true, fields: { STATUS: 'success' } };
      },
      resolveRemote: () => 'origin',
      inputs: { public_url: 'https://acme.example', app_name: 'NanoClaw', wire_owner: 'yes', signout: 'yes' },
      confirm: async (m) => {
        log.push(`confirm:${m}`);
        return true;
      },
      openUrl: async (u) => void opened.push(u),
    });

    // the CLI installed globally (npm runs keytar's install script; pnpm's
    // build-script policy would leave the credential store unbuildable)…
    expect(log.some((c) => c.includes('npm install -g @microsoft/teams.cli@3.0.2'))).toBe(true);
    // …the login ran as a streaming step, never a plain exec (the CLI is
    // invoked by absolute path — $(npm prefix -g)/bin/teams — so match loosely)…
    expect(steps.some((c) => c.includes('/bin/teams" login'))).toBe(true);
    expect(log.some((c) => c.startsWith('exec:') && c.includes(' login'))).toBe(false);
    // …create got the collected public URL on the real /webhook/teams route,
    // the prompted name, and the unconditional single-tenant default…
    expect(log.some((c) => c.includes('--endpoint "https://acme.example/webhook/teams"'))).toBe(true);
    expect(log.some((c) => c.includes('--name "NanoClaw"') && c.includes('--sign-in-audience myOrg'))).toBe(true);
    // …the mascot icons were applied to the created app (captured teams app id,
    // both committed assets) before the install-link operator…
    expect(
      log.some(
        (c) =>
          c.includes(' app update tapp-123') &&
          c.includes('--color-icon setup/assets/teams/color.png') &&
          c.includes('--outline-icon setup/assets/teams/outline.png'),
      ),
    ).toBe(true);
    // …the DM-open chain resolved the wire inputs: the owner's 29: id from the
    // conversation members (first non-bot member) and the adapter-encoded
    // platform id from the created conversation…
    expect(res.vars.owner_handle).toBe('29:owner-xyz');
    expect(res.vars.owner_name).toBe('Dan Mill');
    expect(res.vars.platform_id).toBe(EXPECTED_PLATFORM_ID);
    // …the M365 session was signed out on the operator's "yes" (the adapter
    // runs on the .env app credentials; staying signed in is now a choice)…
    expect(log.some((c) => c.includes('/bin/teams" logout'))).toBe(true);
    // …the captured credentials landed in .env with the safe SingleTenant pairing…
    const env = readFileSync(join(root, '.env'), 'utf8');
    expect(env).toContain('TEAMS_APP_ID=12345678-1234-1234-1234-123456789abc');
    expect(env).toContain('TEAMS_APP_PASSWORD=a-much-longer-app-secret');
    expect(env).toContain('TEAMS_APP_TENANT_ID=87654321-4321-4321-4321-cba987654321');
    expect(env).toContain('TEAMS_APP_TYPE=SingleTenant');
    // …the install-link operator offered the SUBSTITUTED link (policy §5.2 runs on
    // the rendered body — an unsubstituted {{var}} would have been excluded)…
    expect(opened).toContain(INSTALL_LINK);
    // …a natural-barrier confirm fired between the install operator and restart…
    const gateAt = log.findIndex((c) => c.startsWith('confirm:') && !c.startsWith('confirm:Open '));
    const restartAt = log.findIndex((c) => c.includes('restart.sh'));
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(restartAt);
    // …and the whole document applied with nothing deferred or bounced.
    expect(res.deferred).toEqual([]);
    expect(res.agentTasks).toEqual([]);
    expect(fullyApplied(res)).toBe(true);
  });

  // A no at the wiring confirm then "other-account" collects a different
  // user's Entra object ID, rebinds the wiring target, and re-enters the yes
  // branch: the conversation is created with the PROVIDED id (not the CLI
  // account's), and the wire inputs resolve to that person — the assistant
  // messages the desired user first. There is no skip: someone is always wired.
  it('Teams fresh create, wiring another account by Entra object ID: the chain runs against the target user', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-teams-target-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const TARGET_AAD = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
    const EXPECTED_PLATFORM_ID = `teams:${Buffer.from('a:2conv').toString('base64url')}:${Buffer.from('https://smba.trafficmanager.net/teams/').toString('base64url')}`;
    const log: string[] = [];
    const res = await runSkill('.claude/skills/add-teams', {
      projectRoot: root,
      exec: (c) => {
        log.push(`exec:${c}`);
        if (c.includes('TEAMS_APP_ID=.')) return 'no';
        if (c.includes(' app create ')) {
          return JSON.stringify({
            teamsAppId: 'tapp-123',
            installLink: 'https://teams.microsoft.com/l/app/tapp-123',
            credentials: { CLIENT_ID: 'app-1', CLIENT_SECRET: 'a-much-longer-app-secret', TENANT_ID: 'tenant-1' },
          });
        }
        if (c.includes('status --json')) {
          return JSON.stringify({ loggedIn: true, username: 'dan@acme.example', userObjectId: 'aad-owner-1' });
        }
        // the rebind fence: printf its own substituted JSON back
        if (c.includes('"wire":"yes"')) return `{"aad":"${TARGET_AAD}","wire":"yes"}`;
        if (c.includes('login.microsoftonline.com')) return 'eyJfake.bot.token';
        if (c.includes('/members')) return JSON.stringify({ id: '29:target-xyz', name: 'Desired Person' });
        if (c.includes('/v3/conversations')) return 'a:2conv';
        if (c.includes('node -e')) return EXPECTED_PLATFORM_ID;
      },
      execStream: async () => ({ ok: true, fields: { STATUS: 'success' } }),
      resolveRemote: () => 'origin',
      inputs: {
        public_url: 'https://acme.example',
        app_name: 'NanoClaw',
        wire_owner: 'no',
        wire_target: 'other-account',
        target_aad_id: TARGET_AAD,
        signout: 'yes',
      },
      confirm: async () => true,
      openUrl: async () => {},
    });

    // The conversation was created with the PROVIDED id, not the CLI account's…
    const create = log.find((c) => c.includes('/v3/conversations') && !c.includes('/members'));
    expect(create).toContain(TARGET_AAD);
    expect(create).not.toContain('aad-owner-1');
    // …and the wire inputs resolved to the target user.
    expect(res.vars.owner_handle).toBe('29:target-xyz');
    expect(res.vars.owner_name).toBe('Desired Person');
    expect(res.vars.platform_id).toBe(EXPECTED_PLATFORM_ID);
    expect(res.agentTasks).toEqual([]);
    expect(fullyApplied(res)).toBe(true);
  });

  // A hesitant no recovered via "logged-in-account": the rebind flips the
  // branch back to yes with the CLI account's own id — same outcome as a yes
  // at the first ask, no ID ever typed or shown.
  it('Teams fresh create, no then logged-in-account: the chain runs against the CLI account', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-teams-loggedin-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const log: string[] = [];
    const res = await runSkill('.claude/skills/add-teams', {
      projectRoot: root,
      exec: (c) => {
        log.push(`exec:${c}`);
        if (c.includes('TEAMS_APP_ID=.')) return 'no'; // probe first — it also contains "echo yes"
        if (c.trim() === 'echo yes') return 'yes'; // the logged-in-account rebind
        if (c.includes(' app create ')) {
          return JSON.stringify({
            teamsAppId: 'tapp-123',
            installLink: 'https://teams.microsoft.com/l/app/tapp-123',
            credentials: { CLIENT_ID: 'app-1', CLIENT_SECRET: 'a-much-longer-app-secret', TENANT_ID: 'tenant-1' },
          });
        }
        if (c.includes('status --json')) {
          return JSON.stringify({ loggedIn: true, username: 'dan@acme.example', userObjectId: 'aad-owner-1' });
        }
        if (c.includes('login.microsoftonline.com')) return 'eyJfake.bot.token';
        if (c.includes('/members')) return JSON.stringify({ id: '29:owner-xyz', name: 'Dan Mill' });
        if (c.includes('/v3/conversations')) return 'a:3conv';
        if (c.includes('node -e')) return 'teams:b64:b64';
      },
      execStream: async () => ({ ok: true, fields: { STATUS: 'success' } }),
      resolveRemote: () => 'origin',
      inputs: {
        public_url: 'https://acme.example',
        app_name: 'NanoClaw',
        wire_owner: 'no',
        wire_target: 'logged-in-account',
        signout: 'yes',
      },
      confirm: async () => true,
      openUrl: async () => {},
    });

    // The conversation was created with the CLI account's own id…
    const create = log.find((c) => c.includes('/v3/conversations') && !c.includes('/members'));
    expect(create).toContain('aad-owner-1');
    // …and the wire inputs resolved exactly as a first-ask yes would.
    expect(res.vars.owner_handle).toBe('29:owner-xyz');
    expect(res.vars.platform_id).toBe('teams:b64:b64');
    expect(res.agentTasks).toEqual([]);
    expect(fullyApplied(res)).toBe(true);
  });


  // The resolved leg of wireIfResolved, driven with a minimal fixture skill
  // (the real teams document needs a streaming exec runChannelSkill doesn't
  // expose): when the skill binds owner_handle + platform_id, the adapter asks
  // nothing extra (agentName/role injected) and reaches the shared wire with
  // the composed teams user id.
  const wireChannel = 'wiretest';
  const wireSkillDir = join(process.cwd(), '.claude/skills', `add-${wireChannel}`);
  afterEach(() => rmSync(wireSkillDir, { recursive: true, force: true }));

  it('wireIfResolved: a run that resolves owner_handle + platform_id wires through init-first-agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-wiretest-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(root, '.env'), '');
    mkdirSync(wireSkillDir, { recursive: true });
    writeFileSync(
      join(wireSkillDir, 'SKILL.md'),
      [
        `# add ${wireChannel}`,
        '',
        '## Resolve',
        '```nc:run capture:owner_handle effect:fetch',
        'echo-owner',
        '```',
        '```nc:run capture:platform_id effect:fetch',
        'echo-platform',
        '```',
        '',
      ].join('\n'),
    );

    const wired: Array<Record<string, unknown>> = [];
    await runChannelSkill(wireChannel, 'Dan Mill', {
      projectRoot: root,
      exec: (c) => {
        if (c === 'echo-owner') return '29:owner-xyz\n';
        if (c === 'echo-platform') return 'teams:enc-conv:enc-url\n';
      },
      resolveRemote: () => 'origin',
      wireIfResolved: true,
      agentName: 'Nano',
      role: 'owner',
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    expect(wired).toHaveLength(1);
    expect(wired[0]).toMatchObject({
      channel: wireChannel,
      userId: `${wireChannel}:29:owner-xyz`,
      platformId: 'teams:enc-conv:enc-url',
      displayName: 'Dan Mill',
      agentName: 'Nano',
      role: 'owner',
    });
  });

  // The engine reads `.claude/skills/add-<channel>/SKILL.md` relative to cwd (the
  // repo root in tests — same as the real add-slack the test above drives), so a
  // bounce-fixture skill is created there and torn down afterward.
  const failChannel = 'failtest';
  const failSkillDir = join(process.cwd(), '.claude/skills', `add-${failChannel}`);
  afterEach(() => rmSync(failSkillDir, { recursive: true, force: true }));

  // When the skill doesn't fully apply (a directive bounced to an agent), the
  // generic "couldn't finish" message is replaced by the bounced step's OWN
  // prose: the section heading becomes fail()'s headline and the surrounding
  // prose becomes the dimmed hint (which fail() also forwards to the Claude
  // handoff). Asserted via an injected fail spy (the real fail() process.exits).
  it('threads the bounced step prose into fail() when the skill does not fully apply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rcs-fail-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(root, '.env'), '');
    // A skill whose only directive bounces — the engine has no handler for
    // nc:hand-wire, so it degrades to an agent and the run is not fully applied.
    mkdirSync(failSkillDir, { recursive: true });
    writeFileSync(
      join(failSkillDir, 'SKILL.md'),
      [
        `# add ${failChannel}`,
        '',
        '## Register the webhook by hand',
        'Open the Faily dashboard and paste the webhook URL into the bot settings.',
        '```nc:hand-wire',
        'register webhook',
        '```',
        '',
      ].join('\n'),
    );

    const failCalls: Array<{ step: string; msg: string; hint?: string }> = [];
    const fakeFail = (step: string, msg: string, hint?: string): Promise<never> => {
      failCalls.push({ step, msg, hint });
      // The real fail() process.exits and never returns; emulate that by aborting
      // the flow so control doesn't fall through to the resolve/wire steps.
      return Promise.reject(new Error('__failed__'));
    };

    await expect(
      runChannelSkill(failChannel, 'Bob', {
        projectRoot: root,
        exec: () => {},
        resolveRemote: () => 'origin',
        agentName: 'Nano',
        role: 'owner',
        reuse: false,
        inputs: {},
        fail: fakeFail,
        wire: () => true,
      }),
    ).rejects.toThrow('__failed__');

    expect(failCalls).toHaveLength(1);
    expect(failCalls[0].step).toBe(`${failChannel}-install`);
    expect(failCalls[0].msg).toBe('Register the webhook by hand'); // heading → headline
    expect(failCalls[0].hint).toContain('Open the Faily dashboard'); // prose → hint
    expect(failCalls[0].hint).not.toBe('See logs/setup-steps/ for details, then retry setup.'); // not the generic
  });
});

// M5 backGate — the first-prompt "← Back to channel selection" gate. It's a
// brightSelect (mocked above) wrapped in ensureAnswer; on back it returns the
// existing BACK_TO_CHANNEL_SELECTION sentinel that setup/auto.ts already catches.
describe('backGate (first-prompt back-to-channel-selection)', () => {
  it('returns the sentinel on back and continue otherwise', async () => {
    bs.answers = ['back'];
    expect(await backGate('Slack DMs')).toBe(BACK_TO_CHANNEL_SELECTION);

    bs.answers = ['continue'];
    expect(await backGate('Slack DMs')).toBe('continue');
  });

  // offerBack runs the gate at the very top — before resolveAgentName/role, the
  // skill run, and the wire. Picking back returns the sentinel without touching
  // any side effect (no exec, no wire).
  it('runChannelSkill with offerBack returns the sentinel before running the skill', async () => {
    bs.answers = ['back'];
    const cmds: string[] = [];
    const wired: unknown[] = [];

    const result = await runChannelSkill('slack', 'Bob Smith', {
      offerBack: true,
      exec: (c) => void cmds.push(c),
      resolveRemote: () => 'origin',
      agentName: 'Nano',
      role: 'owner',
      inputs: { connection: 'webhook', bot_token: 'xoxb-x', signing_secret: '0123456789abcdef', owner_handle: 'U12345678' },
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    expect(result).toBe(BACK_TO_CHANNEL_SELECTION);
    expect(cmds).toHaveLength(0); // the skill never ran
    expect(wired).toHaveLength(0); // the wire was never reached
  });
});
