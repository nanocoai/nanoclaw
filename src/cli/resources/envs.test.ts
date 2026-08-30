/**
 * Env verbs through the real dispatch path: registry lookup, guard decision
 * (group-scope whitelist), parseArgs, handler, formatHuman. The service is a
 * real DevEnvService over the mock driver — only the runtime is simulated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import type { DbDriver } from '../../db/index.js';
import {
  DevEnvService,
  EnvExposureService,
  resetDevEnvService,
  resetEnvExposureService,
  type ExposureBinding,
  type ExposureDraft,
  type ExposureGrant,
  type ExposureProvider,
  type ExposureRow,
} from '../../dev-env/index.js';
import { MockDevEnvDriver, MockDevEnvRuntime, instanceName } from '../../dev-env/mock-driver.js';
import { sessionDir } from '../../session-manager.js';
import { registerResourceHelpCommands } from '../commands/help.js';
import { getResources } from '../crud.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, ResponseFrame } from '../frame.js';
import { lookup } from '../registry.js';
// Side-effect import: registers the envs resource and its commands.
import './envs.js';
import { parseDurationMs, resolveDevTreeOption } from './envs.js';

// Mint `help` and `envs-help` the same way the command barrel does at boot —
// the help surfaces read only the crud resources map, which is what's under
// test in the 'help surfaces' block below.
registerResourceHelpCommands();

const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 's1',
  agentGroupId: 'g-agent',
  messagingGroupId: 'mg1',
};

let runtime: MockDevEnvRuntime;
let now: number;

async function makeService(manual = false): Promise<DevEnvService> {
  const driver = new MockDevEnvDriver({
    installScope: 'cli-suite',
    runtime,
    knownStamps: ['sample-app'],
    manualCompletion: manual,
  });
  return new DevEnvService({
    db: await initTestDbOnce(),
    driver,
    installScope: 'cli-suite',
    now: () => now,
  });
}

let db: DbDriver | null = null;
async function initTestDbOnce(): Promise<DbDriver> {
  if (!db) {
    db = await initTestDb();
    await runMigrations(db);
  }
  return db;
}

/**
 * A runtime transition fires the seam's synchronous callback, but the settle
 * it triggers is registry I/O — so the env's row moves a tick after the
 * runtime did. Same helper as the session driver's watch events
 * (`settled` in drivers/conformance.test.ts).
 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The exposure surface's provider, stubbed: this suite is about the VERBS —
 * the approval declaration, derived ownership, the render — and a transport
 * has no part in any of them (which is the seam working).
 */
class StubExposureProvider implements ExposureProvider {
  readonly kind = 'stub';
  reportUrl(draft: ExposureDraft): { url: string; detail: Record<string, string> } {
    return { url: `https://${draft.name}.stub.invalid/`, detail: {} };
  }
  async realize(binding: ExposureBinding): Promise<{ url: string }> {
    return { url: binding.grant.url };
  }
  async revoke(_grant: ExposureGrant): Promise<void> {}
  async heal(_bindings: ExposureBinding[]): Promise<void> {}
}

/** Claim through the CLI and publish something for it to serve. */
async function claimServing(ctx: CallerContext = HOST): Promise<string> {
  const env = dataOf(await run('envs-claim', { stamp: 'sample-app', lifetime: 'pinned' }, ctx));
  runtime.publishService(instanceName({ envId: env.envId as string, instanceId: env.instanceId as string }), {
    service: 'default/backlot',
    address: '10.43.0.9',
    port: 8080,
  });
  return env.envId as string;
}

beforeEach(async () => {
  runtime = new MockDevEnvRuntime();
  now = 1_000_000;
  const service = await makeService();
  resetDevEnvService(service);
  const exposures = new EnvExposureService({
    db: await initTestDbOnce(),
    envs: service,
    provider: new StubExposureProvider(),
    // Same reason the provider is a stub: the scheme probe opens a real socket
    // to the resolved address, and `claimServing` publishes one the mock
    // runtime invented. The verbs under test do not read the answer.
    probeBackendTls: async () => false,
  });
  exposures.wireLifecycle();
  resetEnvExposureService(exposures);
});

afterEach(async () => {
  resetDevEnvService(null);
  resetEnvExposureService(null);
  await closeDb();
  db = null;
});

let n = 0;
async function run(command: string, args: Record<string, unknown>, ctx: CallerContext): Promise<ResponseFrame> {
  n += 1;
  return dispatch({ id: `r${n}`, command, args }, ctx);
}

function dataOf(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(`expected ok frame, got: ${frame.error.code} ${frame.error.message}`);
  return frame.data as Record<string, unknown>;
}

describe('envs-claim', () => {
  it('host claims: active env with endpoints, rendered human', async () => {
    const frame = await run('envs-claim', { stamp: 'sample-app', lifetime: 'pinned' }, HOST);
    const env = dataOf(frame);
    expect(env.state).toBe('active');
    expect(env.ownerRef).toBe('operator');
    expect((env.endpoints as Record<string, string>).app).toMatch(/^http:/);
    expect(frame.ok && frame.human).toContain('endpoints:');
  });

  it('an agent claims as its own group — owner derived, never trusted', async () => {
    const env = dataOf(await run('envs-claim', { stamp: 'sample-app' }, AGENT));
    expect(env.ownerRef).toBe('g-agent');
    expect((env.lifetime as { mode: string }).mode).toBe('bound');
  });

  it('an agent naming another owner is refused', async () => {
    const frame = await run('envs-claim', { stamp: 'sample-app', owner: 'g-other' }, AGENT);
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('own group');
  });

  it('ttl claims require --ttl, and it must carry a unit', async () => {
    const missing = await run('envs-claim', { stamp: 'sample-app', lifetime: 'ttl' }, HOST);
    expect(missing.ok).toBe(false);

    const unitless = await run('envs-claim', { stamp: 'sample-app', lifetime: 'ttl', ttl: '600' }, HOST);
    expect(unitless.ok).toBe(false);

    const env = dataOf(await run('envs-claim', { stamp: 'sample-app', lifetime: 'ttl', ttl: '2h' }, HOST));
    expect((env.lifetime as { expiresAtMs: number }).expiresAtMs).toBe(now + 2 * 3_600_000);
  });

  it('a still-provisioning claim says so and points at envs-get (D18)', async () => {
    resetDevEnvService(await makeService(true));
    const frame = await run('envs-claim', { stamp: 'sample-app', lifetime: 'pinned' }, HOST);
    const env = dataOf(frame);
    expect(env.state).toBe('claiming');
    expect(frame.ok && frame.human).toContain('still provisioning');

    runtime.complete(instanceName({ envId: env.envId as string, instanceId: env.instanceId as string }));
    await settled();
    const after = dataOf(await run('envs-get', { id: env.envId }, HOST));
    expect(after.state).toBe('active');
  });

  it('when dev-env is not enabled the error says how to enable it', async () => {
    resetDevEnvService(null);
    const frame = await run('envs-claim', { stamp: 'sample-app' }, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('NANOCLAW_DEV_ENV_DRIVER');
  });
});

describe('claim --options via --stdin-json (the already-parsed object form)', () => {
  // The stdin-json merge hands structured values through as-is, so a frame —
  // fresh or replayed after approval — can carry --options as an object, not
  // JSON text. Same bug family as the stamps --config incident
  // (appr-1787499645710-fkkq95); same fix: both forms, one structural check.
  it('an object rides to the driver exactly like inline JSON text', async () => {
    const env = dataOf(
      await run('envs-claim', { stamp: 'sample-app', lifetime: 'pinned', options: { flavor: 'x' } }, HOST),
    );
    const instance = runtime.instances.get(
      instanceName({ envId: env.envId as string, instanceId: env.instanceId as string }),
    )!;
    expect(instance.options.flavor).toBe('x');
  });

  it('a non-object is refused whichever way it arrives; non-string values keep their own refusal', async () => {
    // 7 and ['x'] are the stdin-json shapes (already parsed); '"scalar"' and
    // '[]' are their inline-text twins. One refusal, naming both routes.
    for (const bad of [7, '"scalar"', ['x'], '[]']) {
      const frame = await run('envs-claim', { stamp: 'sample-app', options: bad }, HOST);
      expect(frame.ok, JSON.stringify(bad)).toBe(false);
      if (!frame.ok) {
        expect(frame.error.message).toContain(
          '--options must be a JSON object of string values (inline or via --stdin-json)',
        );
      }
    }
    const numbered = await run('envs-claim', { stamp: 'sample-app', options: { flavor: 7 } }, HOST);
    expect(numbered.ok).toBe(false);
    if (!numbered.ok) expect(numbered.error.message).toContain('must be a string');
  });
});

describe('the claim readiness push contract (D18)', () => {
  it("an agent's in-flight claim records the claiming session and promises the push", async () => {
    resetDevEnvService(await makeService(true));
    const frame = await run('envs-claim', { stamp: 'sample-app' }, AGENT);
    const env = dataOf(frame);
    expect(env.state).toBe('claiming');
    // The push address is DERIVED from the transport-authenticated caller,
    // exactly like ownership — never a named argument an agent could aim.
    expect(env.claimantSessionId).toBe('s1');
    expect(frame.ok && frame.human).toContain('you will be notified');
  });

  it('a host claim keeps the poll contract — no session, no promise', async () => {
    resetDevEnvService(await makeService(true));
    const frame = await run('envs-claim', { stamp: 'sample-app', lifetime: 'pinned' }, HOST);
    const env = dataOf(frame);
    expect(env.state).toBe('claiming');
    expect(env.claimantSessionId).toBeNull();
    expect(frame.ok && frame.human).toContain('still provisioning');
    expect(frame.ok && frame.human).not.toContain('you will be notified');
  });

  it('a warm agent claim answers active and promises nothing — there is no wait to relieve', async () => {
    const frame = await run('envs-claim', { stamp: 'sample-app' }, AGENT);
    const env = dataOf(frame);
    expect(env.state).toBe('active');
    expect(env.claimantSessionId).toBeNull();
    expect(frame.ok && frame.human).not.toContain('you will be notified');
  });
});

describe('failed envs carry their reason (ISSUES #20)', () => {
  it('envs-get renders kind and detail; envs-list carries the short marker on the status line', async () => {
    // The whoami acceptance: `envs get <failed-id>` printed the one status
    // line and nothing else — the failure's why existed nowhere a reader
    // could reach.
    resetDevEnvService(await makeService(true));
    const env = dataOf(await run('envs-claim', { stamp: 'sample-app', lifetime: 'pinned' }, HOST));
    runtime.failProvisioning(instanceName({ envId: env.envId as string, instanceId: env.instanceId as string }), {
      kind: 'instantiation-failed',
      retryable: false,
      detail: 'vcluster kubeconfig secret never appeared',
    });
    await settled();

    const got = await run('envs-get', { id: env.envId }, HOST);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect((got.data as Record<string, unknown>).failureKind).toBe('instantiation-failed');
      expect(got.human).toContain('failed (instantiation-failed)');
      expect(got.human).toContain('vcluster kubeconfig secret never appeared');
    }

    const list = await run('envs-list', {}, HOST);
    expect(list.ok && list.human).toContain('failed (instantiation-failed)');
  });
});

describe('ownership boundary', () => {
  it("a foreign env answers exactly like a missing one — 'not yours' must not confirm 'exists'", async () => {
    const foreign = dataOf(await run('envs-claim', { stamp: 'sample-app', lifetime: 'pinned' }, HOST));

    const gotForeign = await run('envs-get', { id: foreign.envId }, AGENT);
    const gotMissing = await run('envs-get', { id: 'env-does-not-exist' }, AGENT);

    expect(gotForeign.ok).toBe(false);
    expect(gotMissing.ok).toBe(false);
    if (!gotForeign.ok && !gotMissing.ok) {
      expect(gotForeign.error.message.replace(String(foreign.envId), 'X')).toBe(
        gotMissing.error.message.replace('env-does-not-exist', 'X'),
      );
    }
  });

  it('an agent releases its own env; release is idempotent', async () => {
    const env = dataOf(await run('envs-claim', { stamp: 'sample-app' }, AGENT));
    const released = dataOf(await run('envs-release', { id: env.envId }, AGENT));
    expect(released.state).toBe('released');
    expect(runtime.instances.size).toBe(0);

    const again = await run('envs-release', { id: env.envId }, AGENT);
    expect(again.ok).toBe(true);
  });

  it('envs-list scopes: the agent sees its own, the operator sees all', async () => {
    await run('envs-claim', { stamp: 'sample-app', lifetime: 'pinned' }, HOST);
    await run('envs-claim', { stamp: 'sample-app' }, AGENT);

    const agentSees = dataOf(await run('envs-list', {}, AGENT)) as unknown as unknown[];
    const hostSees = dataOf(await run('envs-list', {}, HOST)) as unknown as unknown[];
    expect(agentSees).toHaveLength(1);
    expect(hostSees).toHaveLength(2);
  });
});

describe('envs-extend', () => {
  it('extends a ttl env from now; refuses non-ttl envs', async () => {
    const env = dataOf(await run('envs-claim', { stamp: 'sample-app', lifetime: 'ttl', ttl: '1h' }, HOST));
    now += 30 * 60_000;
    const extended = dataOf(await run('envs-extend', { id: env.envId, ttl: '2h' }, HOST));
    expect((extended.lifetime as { expiresAtMs: number }).expiresAtMs).toBe(now + 2 * 3_600_000);

    const pinned = dataOf(await run('envs-claim', { stamp: 'sample-app', lifetime: 'pinned' }, HOST));
    const refused = await run('envs-extend', { id: pinned.envId, ttl: '1h' }, HOST);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('only ttl envs');
  });
});

describe('exposing a port (C14)', () => {
  it('expose carries the approval declaration; unexpose and the reads stay open', () => {
    // The declaration IS the policy: dispatch + the command guard turn
    // `access: 'approval'` into hold-for-admin for agent callers (pinned
    // upstream in dispatch.test.ts). Opening a hole in a perimeter is the one
    // mutation on this resource that earns it; CLOSING one must not, or the
    // ceremony becomes a reason to leave it open. What the admin signs is the
    // command frame — env id and port — not the URL, which the approved replay
    // mints afterwards.
    expect(lookup('envs-expose')?.access).toBe('approval');
    for (const cmd of ['envs-unexpose', 'envs-get', 'envs-list', 'envs-claim', 'envs-release']) {
      expect(lookup(cmd)?.access, cmd).toBe('open');
    }
  });

  it('grants a name and a URL, and both show on the env afterwards', async () => {
    const envId = await claimServing();
    const frame = await run('envs-expose', { id: envId, port: 8080 }, HOST);
    const row = dataOf(frame) as unknown as ExposureRow;

    expect(row).toMatchObject({ state: 'live', service: 'default/backlot', port: 8080, provider: 'stub' });
    expect(frame.ok && frame.human).toContain(row.url);
    // The lifetime line, where the reader of the grant actually gets it: the
    // admin card is rendered from the command frame and cannot carry this,
    // because the URL does not exist until the approved replay runs.
    expect(frame.ok && frame.human).toContain('until it is revoked');

    const got = await run('envs-get', { id: envId }, HOST);
    expect(got.ok && got.human).toContain(`exposed: ${row.name} → ${row.url}`);
    const listed = await run('envs-list', {}, HOST);
    expect(listed.ok && listed.human).toContain(`exposed: ${row.name}`);
  });

  it('takes --port as text or as an already-parsed number, and refuses anything else', async () => {
    const envId = await claimServing();
    expect(dataOf(await run('envs-expose', { id: envId, port: 8080 }, HOST)).port).toBe(8080);
    await run('envs-unexpose', { id: envId }, HOST);
    expect(dataOf(await run('envs-expose', { id: envId, port: '8080' }, HOST)).port).toBe(8080);

    const other = await claimServing();
    const bad = await run('envs-expose', { id: other, port: 'http' }, HOST);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain('TCP port number');
  });

  it('unexpose closes it, idempotently, and says so when there is nothing to close', async () => {
    const envId = await claimServing();
    const row = dataOf(await run('envs-expose', { id: envId, port: 8080 }, HOST)) as unknown as ExposureRow;

    // `unexpose` with no --name closes ALL of the env's grants and answers
    // with the list; asserting the length keeps this about the one grant this
    // test made rather than "at least one of whatever was live".
    const closed = await run('envs-unexpose', { id: envId }, HOST);
    const ended = dataOf(closed).exposures as ExposureRow[];
    expect(ended).toHaveLength(1);
    expect(ended[0].revokeCause).toBe('requested');
    expect(closed.ok && closed.human).toContain(row.name);

    const again = await run('envs-unexpose', { id: envId }, HOST);
    expect(again.ok).toBe(true);
    expect(again.ok && again.human).toContain('exposes nothing');
  });

  it('an exposed port dies with its env — release revokes it, unasked', async () => {
    const envId = await claimServing();
    await run('envs-expose', { id: envId, port: 8080 }, HOST);
    await run('envs-release', { id: envId }, HOST);

    const got = await run('envs-get', { id: envId }, HOST);
    expect(got.ok && got.human).not.toContain('exposed:');
    expect(dataOf(await run('envs-unexpose', { id: envId }, HOST)).exposures).toEqual([]);
  });

  it('a foreign env answers exactly like a missing one, on expose as on get', async () => {
    const foreign = await claimServing();
    const gotForeign = await run('envs-expose', { id: foreign, port: 8080 }, AGENT);
    const gotMissing = await run('envs-expose', { id: 'env-does-not-exist', port: 8080 }, AGENT);
    expect(gotForeign.ok).toBe(false);
    expect(gotMissing.ok).toBe(false);
    if (!gotForeign.ok && !gotMissing.ok) {
      expect(gotForeign.error.message.replace(foreign, 'X')).toBe(
        gotMissing.error.message.replace('env-does-not-exist', 'X'),
      );
    }
  });

  it('when no provider is configured the error names the switch instead of pretending', async () => {
    const envId = await claimServing();
    resetEnvExposureService(null);
    const frame = await run('envs-expose', { id: envId, port: 8080 }, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('NANOCLAW_DEV_ENV_EXPOSURE_PROVIDER');
    // ...and the reads keep working, merging nothing.
    expect((await run('envs-get', { id: envId }, HOST)).ok).toBe(true);
  });
});

describe('help surfaces', () => {
  const VERB_LINE = 'verbs: claim, get, list, release, extend, expose, unexpose';

  it('envs is a crud-registered resource — getResources and `ncl help` both list it', async () => {
    expect(getResources().map((r) => r.plural)).toContain('envs');

    const frame = await run('help', {}, HOST);
    expect(frame.ok).toBe(true);
    if (frame.ok) {
      expect(String(frame.data)).toContain('envs');
      expect(String(frame.data)).toContain(VERB_LINE);
    }
  });

  it('a group-scoped agent sees envs in `ncl help` (GROUP_SCOPE_RESOURCES already whitelists it)', async () => {
    const frame = await run('help', {}, AGENT);
    expect(frame.ok).toBe(true);
    if (frame.ok) expect(String(frame.data)).toContain(VERB_LINE);
  });

  it('`ncl envs help` renders the resource overview; `ncl envs help claim` the deep verb help', async () => {
    const overview = await run('envs-help', {}, HOST);
    expect(overview.ok).toBe(true);
    if (overview.ok) {
      const text = String(overview.data);
      expect(text).toContain('envs: ');
      for (const verb of ['claim', 'get', 'list', 'release', 'extend', 'expose', 'unexpose']) {
        expect(text).toContain(verb);
      }
    }

    // `ncl envs help claim` arrives as 'envs-help-claim' and resolves through
    // the dispatcher's longest-prefix fallback (id = 'claim').
    const deep = await run('envs-help-claim', {}, HOST);
    expect(deep.ok).toBe(true);
    if (deep.ok) expect(String(deep.data)).toContain('ncl envs claim');
  });

  it('--help on a verb answers with its deep help and executes nothing', async () => {
    const frame = await run('envs-claim', { help: true }, HOST);
    expect(frame.ok).toBe(true);
    if (frame.ok) expect(String(frame.data)).toContain('ncl envs claim');

    const listed = dataOf(await run('envs-list', {}, HOST)) as unknown as unknown[];
    expect(listed).toHaveLength(0);
  });

  it('an unknown envs verb names the real ones (resource probe reads the crud map)', async () => {
    const frame = await run('envs-bogus', {}, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) {
      expect(frame.error.code).toBe('unknown-command');
      expect(frame.error.message).toContain('verbs for envs: claim, get, list, release, extend, expose, unexpose');
    }
  });
});

describe('parseDurationMs', () => {
  it('parses unit-suffixed durations and rejects everything else', () => {
    expect(parseDurationMs('90s')).toBe(90_000);
    expect(parseDurationMs('15m')).toBe(900_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs('1d')).toBe(86_400_000);
    for (const bad of ['600', '2 h', 'h2', '1.5h', '', '2w']) {
      expect(() => parseDurationMs(bad), bad).toThrow(/invalid duration/);
    }
  });
});

describe('dev-tree option resolution (the hot-loop flavor boundary)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'envs-devtree-'));
    fs.mkdirSync(path.join(workspace, 'nanoclaw'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const baseFor = () => workspace;

  it('resolves a workspace-relative tree to the real host path under the reserved key', () => {
    const resolved = resolveDevTreeOption(AGENT, { 'dev-tree': 'nanoclaw', keep: 'me' }, baseFor)!;
    expect(resolved.devTreePath).toBe(fs.realpathSync(path.join(workspace, 'nanoclaw')));
    expect(resolved['dev-tree']).toBeUndefined(); // the agent form never crosses the seam
    expect(resolved.keep).toBe('me'); // other options ride along untouched
  });

  it('options without dev-tree pass through byte-identical, and undefined stays undefined', () => {
    const options = { flavor: 'x' };
    expect(resolveDevTreeOption(AGENT, options, baseFor)).toBe(options);
    expect(resolveDevTreeOption(AGENT, undefined, baseFor)).toBeUndefined();
  });

  it('refuses the reserved resolved key on input — only this resolver mints it', () => {
    expect(() => resolveDevTreeOption(AGENT, { devTreePath: '/etc' }, baseFor)).toThrow(/reserved/);
    // reserved even without a dev-tree key beside it, and for host callers too
    expect(() => resolveDevTreeOption(HOST, { devTreePath: '/etc' }, baseFor)).toThrow(/reserved/);
  });

  it('refuses host callers: no code session, no derivable tree', () => {
    expect(() => resolveDevTreeOption(HOST, { 'dev-tree': 'nanoclaw' }, baseFor)).toThrow(/sandbox-only/);
  });

  it('refuses absolute paths, lexical escapes, and symlink escapes — the workspace is agent-writable', () => {
    expect(() => resolveDevTreeOption(AGENT, { 'dev-tree': '/etc' }, baseFor)).toThrow(/never an absolute/);
    expect(() => resolveDevTreeOption(AGENT, { 'dev-tree': '../outside' }, baseFor)).toThrow(/inside your workspace/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'envs-devtree-outside-'));
    try {
      fs.symlinkSync(outside, path.join(workspace, 'sneaky'));
      expect(() => resolveDevTreeOption(AGENT, { 'dev-tree': 'sneaky' }, baseFor)).toThrow(/inside your workspace/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a missing tree and a file where a directory must be', () => {
    expect(() => resolveDevTreeOption(AGENT, { 'dev-tree': 'gone' }, baseFor)).toThrow(/no such directory/);
    // The not-found refusal must explain the SCOPE, not just deny: a checkout
    // under /workspace/agent (the durable group folder — a different host
    // mount) is visible to the agent but unreachable by session-dir
    // arithmetic, and "no such directory" alone would read as gaslighting.
    expect(() => resolveDevTreeOption(AGENT, { 'dev-tree': 'agent/nanoclaw' }, baseFor)).toThrow(
      /\/workspace\/agent is the durable group folder/,
    );
    fs.writeFileSync(path.join(workspace, 'file.txt'), 'x');
    expect(() => resolveDevTreeOption(AGENT, { 'dev-tree': 'file.txt' }, baseFor)).toThrow(/must name a directory/);
  });

  it('through dispatch: the driver sees the resolved node path, derived from the CALLER-context session — never agent-named', async () => {
    // The real base arithmetic: the exact host dir the sandbox mounts at /workspace.
    const realWorkspace = sessionDir(AGENT.caller === 'agent' ? AGENT.agentGroupId : '', 's1');
    fs.mkdirSync(path.join(realWorkspace, 'nanoclaw'), { recursive: true });
    try {
      const frame = await run(
        'envs-claim',
        { stamp: 'sample-app', options: JSON.stringify({ 'dev-tree': 'nanoclaw' }) },
        AGENT,
      );
      const env = dataOf(frame);
      const instance = runtime.instances.get(
        instanceName({ envId: env.envId as string, instanceId: env.instanceId as string }),
      )!;
      expect(instance.options.devTreePath).toBe(fs.realpathSync(path.join(realWorkspace, 'nanoclaw')));
      expect(instance.options['dev-tree']).toBeUndefined();
    } finally {
      fs.rmSync(realWorkspace, { recursive: true, force: true });
    }
  });

  it('through dispatch: naming the reserved key is refused at the boundary', async () => {
    const frame = await run(
      'envs-claim',
      { stamp: 'sample-app', options: JSON.stringify({ devTreePath: '/etc' }) },
      AGENT,
    );
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('reserved');
  });

  it('--dev is pure sugar for the reserved option (C16): one resolution path, same resolved key', async () => {
    const realWorkspace = sessionDir(AGENT.caller === 'agent' ? AGENT.agentGroupId : '', 's1');
    fs.mkdirSync(path.join(realWorkspace, 'backlot'), { recursive: true });
    try {
      const frame = await run('envs-claim', { stamp: 'sample-app', dev: 'backlot' }, AGENT);
      const env = dataOf(frame);
      const instance = runtime.instances.get(
        instanceName({ envId: env.envId as string, instanceId: env.instanceId as string }),
      )!;
      // The flag rode the SAME resolver: workspace-derived, reserved-key form.
      expect(instance.options.devTreePath).toBe(fs.realpathSync(path.join(realWorkspace, 'backlot')));
      expect(instance.options['dev-tree']).toBeUndefined();
    } finally {
      fs.rmSync(realWorkspace, { recursive: true, force: true });
    }
  });

  it('--dev beside an --options dev-tree is refused — two names for one tree', async () => {
    const frame = await run(
      'envs-claim',
      { stamp: 'sample-app', dev: 'a', options: JSON.stringify({ 'dev-tree': 'b' }) },
      AGENT,
    );
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('pass one');
  });
});
