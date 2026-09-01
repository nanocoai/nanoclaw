/**
 * Stamp verbs through the real dispatch path: registry lookup, guard
 * decision, parseArgs, handler, formatHuman — over a real store on a real
 * (test) DB. The approval MECHANICS for `access: 'approval'` are dispatch's,
 * pinned upstream (dispatch.test.ts: hold → requestApproval → approved
 * replay); what is THIS surface's to pin is the declaration — which verbs
 * carry that access — and the handler behavior once the guard passes, which
 * a host caller exercises directly.
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
  RegistryStampSource,
  StampImageStore,
  StampRegistryStore,
  readPools,
  resetDevEnvService,
  resetEnvExposureService,
  resetStampRegistry,
  type DevEnvDriverCapabilities,
  type ExposureBinding,
  type ExposureDraft,
  type ExposureProvider,
  type ExposureRow,
  type ImageResolver,
  type PoolObservation,
  type PoolReading,
} from '../../dev-env/index.js';
// The join test's two real halves — the only place this surface reaches for a
// driver, and deliberately: see 'driver counts to rendered row'.
import { FakeKube } from '../../dev-env/k8s-fake-kube.js';
import { K8sDevEnvDriver } from '../../dev-env/k8s-driver.js';
// The exposure test's env half: a mock driver is enough there, because what it
// pins is the stamps→exposures seam, not a runtime (see the C14 describe).
import { MockDevEnvDriver, MockDevEnvRuntime, instanceName } from '../../dev-env/mock-driver.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, ResponseFrame } from '../frame.js';
import { lookup } from '../registry.js';
// Side-effect import: registers the stamps resource and its commands.
import './stamps.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 's1',
  agentGroupId: 'g-agent',
  messagingGroupId: 'mg1',
};

const APP_CONFIG = JSON.stringify({ app: { image: 'example.invalid/app:1', presence: 'node-local', port: 8080 } });
const DIGEST = `sha256:${'a'.repeat(64)}`;
const PULL_CONFIG = JSON.stringify({ app: { image: 'registry.example.invalid/org/app:1.2', port: 8080 } });

let db: DbDriver;
let store: StampRegistryStore;
let source: RegistryStampSource;
let images: StampImageStore;
/** Swappable per test: the default resolver answers DIGEST for anything. */
let resolveDigest: ImageResolver['resolveDigest'];
let capabilities: DevEnvDriverCapabilities | null;
/** null = no driver answers the node-image probe (the default); otherwise the refs the node lacks. */
let probeMissing: string[] | null;
/** What the driver answers when asked. `unpooled` (the default) = no driver, or one that pools nothing. */
let reading: PoolReading;
/** How many times the render asked. One runtime query per command, whatever a listing renders. */
let observations: number;

/** The counts a stamp is holding, spelled whole — the render reads all four. */
function held(counts: Partial<PoolObservation>): PoolObservation {
  return { warm: 0, filling: 0, draining: 0, failed: 0, ...counts };
}

beforeEach(async () => {
  db = await initTestDb();
  await runMigrations(db);
  store = new StampRegistryStore(db, () => ['nanoclaw', 'sample-app']);
  images = new StampImageStore(db);
  probeMissing = null;
  source = new RegistryStampSource(store, undefined, images, () =>
    probeMissing === null ? null : async (refs) => refs.filter((ref) => probeMissing!.includes(ref)),
  );
  resolveDigest = async () => ({ digest: DIGEST });
  capabilities = { isolation: 'test', sealedEgress: false, imagePull: true, imageBuild: false };
  reading = { state: 'unpooled' };
  observations = 0;
  resetStampRegistry({
    store,
    source,
    images,
    resolveImage: { resolveDigest: (ref, credential) => resolveDigest(ref, credential) },
    driverCapabilities: () => capabilities,
    observePools: () => {
      observations += 1;
      return reading;
    },
  });
});

afterEach(async () => {
  resetStampRegistry(null);
  resetDevEnvService(null);
  resetEnvExposureService(null);
  await closeDb();
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

function humanOf(frame: ResponseFrame): string {
  if (!frame.ok) throw new Error(`expected ok frame, got: ${frame.error.code} ${frame.error.message}`);
  return frame.human ?? '';
}

describe('the approval declaration', () => {
  it('every mutation carries approval access; reads are open', () => {
    // The declaration IS the policy: dispatch + the command guard turn
    // `access: 'approval'` into hold-for-admin for agent callers (pinned in
    // dispatch.test.ts). This surface's job is to declare it on exactly the
    // verbs that change what is claimable.
    for (const cmd of ['stamps-create', 'stamps-update', 'stamps-retire', 'stamps-set-pool']) {
      expect(lookup(cmd)?.access, cmd).toBe('approval');
    }
    // `place` is deliberately open: from failed it re-executes only the
    // origin the approval already signed (the C15 re-place rule), and the
    // placed→pending flip is host-only IN the handler, where the row state
    // can be read — an approval hold would tax the no-new-approval path.
    for (const cmd of ['stamps-get', 'stamps-list', 'stamps-place']) {
      expect(lookup(cmd)?.access, cmd).toBe('open');
    }
  });
});

describe('the pull path (C15)', () => {
  it('create resolves the ref, pins the config, and lands the pending image row', async () => {
    const frame = await run('stamps-create', { id: 'pulled', config: PULL_CONFIG }, HOST);
    const row = dataOf(frame) as { config: { app: { image: string } }; image: { state: string; sourceRef: string } };
    // The approval signs BITS: the stored config carries ref@digest, and the
    // row's source_ref snapshots the same signed identity.
    expect(row.config.app.image).toBe(`registry.example.invalid/org/app:1.2@${DIGEST}`);
    expect(row.image).toMatchObject({ state: 'pending', sourceRef: `registry.example.invalid/org/app:1.2@${DIGEST}` });
    expect(frame.ok && frame.human).toContain('image: pending since');
  });

  it('refuses the unqualified ref (the squatter clamp) and never consults the resolver for it', async () => {
    let resolved = 0;
    resolveDigest = async () => {
      resolved += 1;
      return { digest: DIGEST };
    };
    const frame = await run('stamps-create', { id: 'squat', config: JSON.stringify({ app: { image: 'org/app:1', port: 80 } }) }, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('fully qualified');
    expect(resolved).toBe(0);
  });

  it("carries the registry's own refusal when resolution fails — the approver never sees an unfetchable stamp", async () => {
    resolveDigest = async () => {
      throw new Error('401 Unauthorized: authentication required');
    };
    const frame = await run('stamps-create', { id: 'denied', config: PULL_CONFIG }, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('401 Unauthorized');
  });

  it('verifies an author-pinned digest instead of re-resolving, and refuses a pin the registry disputes', async () => {
    const pinned = JSON.stringify({ app: { image: `registry.example.invalid/org/app@${DIGEST}`, port: 80 } });
    const ok = await run('stamps-create', { id: 'pinned', config: pinned }, HOST);
    expect(ok.ok).toBe(true);

    resolveDigest = async () => ({ digest: `sha256:${'b'.repeat(64)}` });
    const disputed = await run('stamps-create', { id: 'disputed', config: pinned }, HOST);
    expect(disputed.ok).toBe(false);
    if (!disputed.ok) expect(disputed.error.message).toContain('does not confirm');
  });

  it('refuses a pull origin the driver cannot realize, with the capability named', async () => {
    capabilities = { isolation: 'test', sealedEgress: false, imagePull: false, imageBuild: false };
    const frame = await run('stamps-create', { id: 'nopull', config: PULL_CONFIG }, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('imagePull: false');
  });

  it('refuses a build-origin stamp with the not-yet-realized message, and the both-and with the field names', async () => {
    const frame = await run(
      'stamps-create',
      { id: 'built', config: JSON.stringify({ build: { dockerfile: 'Dockerfile' } }) },
      HOST,
    );
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('not yet realized');

    const both = await run(
      'stamps-create',
      { id: 'both', config: JSON.stringify({ app: { image: 'x.example/app:1', port: 80 }, build: { dockerfile: 'Dockerfile' } }) },
      HOST,
    );
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error.message).toContain('mutually exclusive');
  });

  it('update inserts a fresh pending row at the new version; the prior row survives', async () => {
    await run('stamps-create', { id: 'pulled', config: PULL_CONFIG }, HOST);
    await images.markPlacing('pulled', 1);
    await images.markPlaced('pulled', 1, DIGEST);

    const updated = dataOf(await run('stamps-update', { id: 'pulled', config: PULL_CONFIG }, HOST));
    expect(updated.version).toBe(2);
    expect((updated as { image: { state: string } }).image.state).toBe('pending');
    expect((await images.get('pulled', 1))?.state).toBe('placed'); // v1's row chains forever
  });

  it('place: any caller from failed, host-only from placed, and the node-local refusal names why', async () => {
    await run('stamps-create', { id: 'pulled', config: PULL_CONFIG }, HOST);
    await images.markPlacing('pulled', 1);
    await images.markFailed('pulled', 1, 'registry unreachable');

    const retried = dataOf(await run('stamps-place', { id: 'pulled' }, AGENT));
    expect((retried as { image: { state: string } }).image.state).toBe('pending');

    await images.markPlacing('pulled', 1);
    await images.markPlaced('pulled', 1, DIGEST);
    const agentFlip = await run('stamps-place', { id: 'pulled' }, AGENT);
    expect(agentFlip.ok).toBe(false);
    if (!agentFlip.ok) expect(agentFlip.error.message).toContain('only the host operator');
    const hostFlip = dataOf(await run('stamps-place', { id: 'pulled' }, HOST));
    expect((hostFlip as { image: { state: string } }).image.state).toBe('pending');

    await run('stamps-create', { id: 'local', config: APP_CONFIG }, HOST);
    const nothing = await run('stamps-place', { id: 'local' }, HOST);
    expect(nothing.ok).toBe(false);
    if (!nothing.ok) expect(nothing.error.message).toContain('node-local');
  });

  it('renders provenance in words once placed', async () => {
    await run('stamps-create', { id: 'pulled', config: PULL_CONFIG }, HOST);
    await images.markPlacing('pulled', 1);
    await images.markPlaced('pulled', 1, DIGEST);
    const frame = await run('stamps-get', { id: 'pulled' }, AGENT);
    expect(frame.ok && frame.human).toContain(`provenance: pulled from registry.example.invalid/org/app:1.2@${DIGEST}`);
  });
});

describe('stamps-create', () => {
  it('registers an active row, refreshes the source, renders human', async () => {
    const frame = await run('stamps-create', { id: 'my-app', config: APP_CONFIG, source: '{"repo":"r"}' }, HOST);
    const row = dataOf(frame);
    expect(row).toMatchObject({ stampId: 'my-app', state: 'active', version: 1, authorRef: 'operator' });
    // The claim path reads the snapshot, and a mutation must not wait for the
    // next reconcile to become claimable.
    expect(source.getStamp('my-app')).toBeDefined();
    expect(frame.ok && frame.human).toContain('my-app  v1  active');
  });

  it('refuses an invalid manifest with the constructor refusal — at registration, in front of the approver', async () => {
    const frame = await run('stamps-create', { id: 'half', config: '{"childManifests":"{}"}' }, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('must declare readiness');
  });

  it('refuses code-provided ids and malformed config JSON', async () => {
    const shadow = await run('stamps-create', { id: 'nanoclaw', config: APP_CONFIG }, HOST);
    expect(shadow.ok).toBe(false);
    if (!shadow.ok) expect(shadow.error.message).toContain('code-provided');

    const mangled = await run('stamps-create', { id: 'x', config: 'not json' }, HOST);
    expect(mangled.ok).toBe(false);
    if (!mangled.ok) expect(mangled.error.message).toContain('JSON object');
  });

  it('a dev block registers as part of the approved config, renders on the row, and earns its clamp here (C16)', async () => {
    const devConfig = JSON.stringify({
      app: { image: 'example.invalid/app:1', presence: 'node-local', port: 8080 },
      dev: { mountPath: '/app', reload: { kind: 'exec', command: ['kill', '-HUP', '1'] } },
    });
    const frame = await run('stamps-create', { id: 'dev-app', config: devConfig, source: '{"repo":"r"}' }, HOST);
    const row = dataOf(frame) as { config: { dev?: { mountPath?: string } } };
    expect(row.config.dev?.mountPath).toBe('/app');
    // The approver reads the opt-in and its reload arm off the same card.
    expect(frame.ok && frame.human).toContain('dev: tree mounts at /app');
    expect(frame.ok && frame.human).toContain('reload=exec');

    // The identity clamp lands at the write, in front of the approver — a
    // dev stream mounting the platform claim without the tokens is refused.
    const unclamped = JSON.stringify({
      childManifests: '{"kind":"Namespace"}',
      readiness: { deployment: 'api', namespace: 'default' },
      dev: {
        manifests:
          '{"kind":"Deployment","spec":{"template":{"spec":{"containers":[{"name":"a"}],' +
          '"volumes":[{"persistentVolumeClaim":{"claimName":"dev-tree"}}]}}}}',
      },
    });
    const refused = await run('stamps-create', { id: 'unclamped', config: unclamped }, HOST);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('identity tokens');
  });
});

describe('the stdin-json replay shape (LOG-2026-08-23, appr-1787499645710-fkkq95)', () => {
  // A caller shipping --config via --stdin-json produces a request frame whose
  // args carry config as an already-parsed OBJECT; the hold stores that frame
  // verbatim, and the approved replay re-runs the handler on it — objects stay
  // objects. The live incident: a human approved a held `stamps create` and
  // the string-only parse refused the very object the flag documents. The
  // handler seam here IS the replay seam (host callers pass the guard exactly
  // like a replay carrying its grant — see the file header), so these frames
  // are the incident's, minus the wait.
  const APP_OBJECT = { app: { image: 'example.invalid/app:1', port: 8080 } };

  it('a held create whose frame carries config (and source) as objects registers on approval', async () => {
    const frame = await run(
      'stamps-create',
      { id: 'replayed', config: { ...APP_OBJECT }, source: { repo: 'r', revision: 'abc' } },
      HOST,
    );
    const row = dataOf(frame);
    expect(row).toMatchObject({ stampId: 'replayed', state: 'active', version: 1 });
    expect(row.source).toEqual({ repo: 'r', revision: 'abc' });
    expect(source.getStamp('replayed')).toBeDefined(); // claimable, not merely stored
  });

  it('update takes the object form too — same helper, same seam', async () => {
    await run('stamps-create', { id: 'obj-up', config: APP_CONFIG }, HOST);
    const updated = dataOf(await run('stamps-update', { id: 'obj-up', config: { ...APP_OBJECT } }, HOST));
    expect(updated.version).toBe(2);
  });

  it('a non-object is refused whichever way it arrives: number, string scalar, array', async () => {
    // 7 and ['app'] are the stdin-json shapes (already parsed); '"scalar"' and
    // '[]' are their inline-text twins. One refusal, naming both routes.
    for (const bad of [7, '"scalar"', ['app'], '[]']) {
      const frame = await run('stamps-create', { id: 'x', config: bad }, HOST);
      expect(frame.ok, JSON.stringify(bad)).toBe(false);
      if (!frame.ok) {
        expect(frame.error.message).toContain('--config must be a JSON object (inline or via --stdin-json)');
      }
    }
  });
});

/**
 * The file form. What it is FOR is a shape argv cannot carry: MAX_ARG_STRLEN is
 * 32 × PAGE_SIZE = 131_072 bytes, enforced by execve, so an oversized
 * `--config` dies in the shell before `ncl` exists — no stamp named, no
 * ceiling named. Worse, a scripted register→claim cycle then CLAIMS the
 * previous version and goes green against a stale manifest. So the first test
 * here asserts its own premise (past the cap) rather than testing a toy.
 *
 * The rest pin the two decisions that make a path safe to accept at all: one
 * form per argument (never a precedence rule), and host callers only — because
 * the approval card can only show the approver what the stored FRAME carries,
 * and the replay re-reads the file afterwards.
 */
describe('the file form (--config-file / --source-file)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamps-config-file-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, text: string): string {
    const target = path.join(dir, name);
    fs.writeFileSync(target, text);
    return target;
  }

  /**
   * The approved replay's handler run, reached directly. Dispatch would HOLD an
   * agent's `stamps create` (that is the declaration, pinned above) and this
   * suite deliberately does not own the approval machinery — see the file
   * header — so the frame is replayed exactly as the approved handler receives
   * it: same parseArgs, same stored agent CallerContext.
   */
  async function replayAsAgent(command: string, args: Record<string, unknown>): Promise<unknown> {
    const cmd = lookup(command)!;
    return cmd.handler(cmd.parseArgs(args), AGENT);
  }

  it('registers the shape argv cannot carry, byte for byte', async () => {
    const manifest = JSON.stringify({
      kind: 'Namespace',
      metadata: { name: 'big', annotations: { pad: 'a'.repeat(140_000) } },
    });
    const config = { childManifests: manifest, readiness: { deployment: 'api', namespace: 'default' } };
    const text = JSON.stringify(config);
    // The premise, asserted rather than assumed: inline, this argv string is
    // past MAX_ARG_STRLEN and execve refuses it before any of our code runs.
    expect(Buffer.byteLength(text)).toBeGreaterThan(131_072);

    const frame = await run('stamps-create', { id: 'huge', 'config-file': write('stamp.json', text) }, HOST);
    const row = dataOf(frame);
    expect(row).toMatchObject({ stampId: 'huge', state: 'active', version: 1 });
    // Byte for byte: a read that truncated or re-encoded would register a
    // manifest nobody wrote, and `kubectl apply` would be the one to find out.
    expect((row.config as { childManifests: string }).childManifests).toBe(manifest);
    expect(source.getStamp('huge')).toBeDefined(); // claimable, not merely stored
  });

  it('update takes the file form too, and --source-file rides beside it', async () => {
    await run('stamps-create', { id: 'filed', config: APP_CONFIG }, HOST);
    const updated = dataOf(
      await run(
        'stamps-update',
        {
          id: 'filed',
          'config-file': write(
            'v2.json',
            JSON.stringify({ app: { image: 'example.invalid/app:2', presence: 'node-local', port: 9090 } }),
          ),
          'source-file': write('source.json', JSON.stringify({ repo: 'r', revision: 'abc' })),
        },
        HOST,
      ),
    );
    expect(updated.version).toBe(2);
    expect(updated.source).toEqual({ repo: 'r', revision: 'abc' });
    expect((updated.config as { app: { port: number } }).app.port).toBe(9090);
  });

  it('refuses both forms of one argument rather than picking one — and registers nothing', async () => {
    const clash = await run(
      'stamps-create',
      { id: 'twice', config: APP_CONFIG, 'config-file': write('other.json', PULL_CONFIG) },
      HOST,
    );
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.message).toContain('--config and --config-file are the same argument twice');
    // A precedence rule would have registered one of the two SILENTLY, which
    // is how the definition you did not read becomes the one that is live.
    expect(await store.get('twice')).toBeUndefined();

    const sourceClash = await run(
      'stamps-create',
      { id: 'twice', config: APP_CONFIG, source: '{"repo":"r"}', 'source-file': write('src.json', '{"repo":"s"}') },
      HOST,
    );
    expect(sourceClash.ok).toBe(false);
    if (!sourceClash.ok) {
      expect(sourceClash.error.message).toContain('--source and --source-file are the same argument twice');
    }
    expect(await store.get('twice')).toBeUndefined();
  });

  it('names the path AND the reason on every refusal', async () => {
    // The execve failure this flag replaces named neither, which is exactly
    // what made it cost a session. Four ways to point at the wrong thing:
    const missing = path.join(dir, 'nope.json');
    const gone = await run('stamps-create', { id: 'x', 'config-file': missing }, HOST);
    expect(gone.ok).toBe(false);
    if (!gone.ok) {
      expect(gone.error.message).toContain(missing);
      expect(gone.error.message).toContain('cannot read');
    }

    const asDir = await run('stamps-create', { id: 'x', 'config-file': dir }, HOST);
    expect(asDir.ok).toBe(false);
    if (!asDir.ok) expect(asDir.error.message).toContain(`${dir} is not a regular file`);

    const mangledPath = write('bad.json', '{"app": ');
    const mangled = await run('stamps-create', { id: 'x', 'config-file': mangledPath }, HOST);
    expect(mangled.ok).toBe(false);
    if (!mangled.ok) expect(mangled.error.message).toContain(`${mangledPath} is not valid JSON`);

    const arrayPath = write('arr.json', '["app"]');
    const array = await run('stamps-create', { id: 'x', 'config-file': arrayPath }, HOST);
    expect(array.ok).toBe(false);
    if (!array.ok) expect(array.error.message).toContain(`${arrayPath} must hold a JSON object, got an array`);
  });

  it('refuses a relative path: the DAEMON opens the file, not your shell', async () => {
    // `ncl` is a socket client. A relative path resolves against the service's
    // working directory, so `./stamp.json` either fails or — the case this
    // refusal exists for — reads a different stamp.json that happens to sit
    // beside the daemon, silently, in place of the one on screen.
    const frame = await run('stamps-create', { id: 'rel', 'config-file': 'stamp.json' }, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) {
      expect(frame.error.message).toContain('ABSOLUTE');
      expect(frame.error.message).toContain("service's working directory");
    }
  });

  it('refuses a file over the ceiling by SIZE, naming the path and the limit', async () => {
    // The replacement for an execve cap must not become a silent one: a
    // mis-aimed path (a log, a tarball) is refused with all three numbers a
    // reader needs, instead of being read whole into the daemon.
    const huge = write('huge.json', `{"pad":"${'a'.repeat(4 * 1024 * 1024)}"}`);
    const frame = await run('stamps-create', { id: 'fat', 'config-file': huge }, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) {
      expect(frame.error.message).toContain(huge);
      expect(frame.error.message).toContain('over the 4194304-byte ceiling');
    }
  });

  /**
   * The most important claim on this surface. An agent's `stamps create` is
   * HELD, and dispatch stores the request frame verbatim and renders the
   * approval card from those same args — so a frame carrying `--config-file
   * /workspace/stamp.json` shows a human a FILENAME, and the approved replay
   * reads the file afterwards, from the HOST's filesystem, by which time an
   * agent-writable workspace may hold something else. The approver would be
   * signing a name over bytes nobody read.
   */
  it('is host-only: an approved replay carrying a path is refused, and the file is never read', async () => {
    // A real, valid, readable config — so the refusal can only be about WHO
    // asked, and lands before anything touches the filesystem.
    const good = write('agent.json', APP_CONFIG);
    await expect(replayAsAgent('stamps-create', { id: 'agent-filed', 'config-file': good })).rejects.toThrow(
      /--config-file is host-only/,
    );
    expect(await store.get('agent-filed')).toBeUndefined();

    // The inline routes stay open to agents — that is the C12 contract, and
    // the refusal above names them as the way through.
    const inline = (await replayAsAgent('stamps-create', { id: 'agent-inline', config: APP_CONFIG })) as {
      authorRef: string;
    };
    expect(inline.authorRef).toBe('g-agent');
  });

  it('a value-less --config-file asks for a path instead of guessing', async () => {
    // The client parses a flag with no value as boolean true; the ceiling this
    // flag replaces named nothing, so this one says what is missing.
    const frame = await run('stamps-create', { id: 'bare', 'config-file': true }, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('--config-file needs a path to a JSON file');
  });
});

describe('lifecycle verbs', () => {
  it('update bumps the version; retire drains and blocks; set-pool lands in the snapshot', async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);

    const updated = dataOf(await run('stamps-update', { id: 'my-app', config: APP_CONFIG }, HOST));
    expect(updated.version).toBe(2);

    const pooled = dataOf(await run('stamps-set-pool', { id: 'my-app', size: '2' }, HOST));
    expect(pooled.poolSize).toBe(2);
    expect(source.poolSizes()).toEqual({ 'my-app': 2 });

    const retired = dataOf(await run('stamps-retire', { id: 'my-app' }, HOST));
    expect(retired).toMatchObject({ state: 'retired', poolSize: 0 });
    expect(source.getStamp('my-app')).toBeUndefined();
    expect(source.poolSizes()).toEqual({});
  });
});

describe('retiring a stamp closes the exposures onto it (C14)', () => {
  /** Transport-free, like every other exposure test: a stub carries the name. */
  class StubExposureProvider implements ExposureProvider {
    readonly kind = 'stub';
    reportUrl(draft: ExposureDraft): { url: string; detail: Record<string, string> } {
      return { url: `https://${draft.name}.stub.invalid/`, detail: {} };
    }
    async realize(binding: ExposureBinding): Promise<{ url: string }> {
      return { url: binding.grant.url };
    }
    async revoke(): Promise<void> {}
    async heal(): Promise<void> {}
  }

  it('revokes the grant and leaves the env running — the stamps contract is unchanged', async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);
    const runtime = new MockDevEnvRuntime();
    const envs = new DevEnvService({
      db,
      driver: new MockDevEnvDriver({ installScope: 'stamps-suite', runtime, knownStamps: ['my-app'] }),
      installScope: 'stamps-suite',
    });
    // Transport-free means the target is imaginary too: the mock runtime
    // publishes an address nothing listens on, and the production probe would
    // refuse the grant before retire ever got a hole to close.
    const exposures = new EnvExposureService({
      db,
      envs,
      provider: new StubExposureProvider(),
      probeBackendTls: async () => false,
    });
    exposures.wireLifecycle();
    resetDevEnvService(envs);
    resetEnvExposureService(exposures);

    const env = await envs.claim({ ownerRef: 'g-agent', stampId: 'my-app', lifetime: { mode: 'pinned' } });
    runtime.publishService(instanceName({ envId: env.envId, instanceId: env.instanceId! }), {
      service: 'default/app',
      address: '10.43.0.9',
      port: 8080,
    });
    const grant = await exposures.expose({ envId: env.envId, port: 8080, approvedBy: 'operator' });

    const retired = await run('stamps-retire', { id: 'my-app' }, HOST);
    expect(retired.ok).toBe(true);

    // The hole is closed, with the cause the audit trail can read...
    expect(await exposures.liveForEnv(env.envId)).toEqual([]);
    const ended = (await exposures.history(env.envId)).find((row: ExposureRow) => row.exposureId === grant.exposureId);
    expect(ended).toMatchObject({ state: 'revoked', revokeCause: 'stamp-retired' });
    // ...and the env itself is untouched, exactly as retire has always promised.
    expect((await envs.status(env.envId)).state).toBe('active');
  });
});

describe('the pool renders in both halves (#21)', () => {
  it('desired beside observed: filling, then warm — the fill an author had to claim to see', async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);
    await run('stamps-set-pool', { id: 'my-app', size: '1' }, HOST);

    // The instant the approval lands: the size flipped, the driver holds
    // nothing yet, and the row SAYS so instead of implying a warm slot.
    reading = { state: 'observed', pools: { 'my-app': held({}) } };
    expect(humanOf(await run('stamps-get', { id: 'my-app' }, AGENT))).toContain('pool=1 (warm 0)');

    reading = { state: 'observed', pools: { 'my-app': held({ filling: 1 }) } };
    expect(humanOf(await run('stamps-get', { id: 'my-app' }, AGENT))).toContain('pool=1 (warm 0, filling 1)');

    reading = { state: 'observed', pools: { 'my-app': held({ warm: 1 }) } };
    const warm = await run('stamps-get', { id: 'my-app' }, AGENT);
    expect(humanOf(warm)).toContain('pool=1 (warm 1)');
    expect(dataOf(warm).pool).toEqual({ state: 'observed', ...held({ warm: 1 }) });
  });

  it('a pool whose fills DIE says so — the state `warm 0` alone cannot tell from a slow one', async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);
    await run('stamps-set-pool', { id: 'my-app', size: '1' }, HOST);

    // Same `warm 0` as a pool mid-boot, and a completely different answer to
    // "should I keep waiting?". Dropping the corpses left an author staring
    // at a line that could not change, with the probe-claim as the only way
    // to learn why — which is the workaround this whole row exists to retire.
    reading = { state: 'observed', pools: { 'my-app': held({ failed: 2, lastFailureAgeMs: 20_000 }) } };
    expect(humanOf(await run('stamps-get', { id: 'my-app' }, AGENT))).toContain('pool=1 (warm 0) — 2 dead fills, last 20s ago');
  });

  it('dead fills are dated HISTORY, outside the live counts — a permanent number is read as no news', async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);
    await run('stamps-set-pool', { id: 'my-app', size: '1' }, HOST);

    // Nothing reaps a pool corpse, so this count NEVER clears on its own.
    // Spelled beside warm and filling it made a pool that recovered hours ago
    // read as a pool failing right now — the one thing a row an author is
    // supposed to trust must not do. The parenthetical is live state; the
    // corpses are a dated clause, and the age is what separates them.
    reading = { state: 'observed', pools: { 'my-app': held({ warm: 1, failed: 1, lastFailureAgeMs: 3 * 3_600_000 }) } };
    const recovered = humanOf(await run('stamps-get', { id: 'my-app' }, AGENT));
    expect(recovered).toContain('pool=1 (warm 1) — 1 dead fill, last 3h ago');

    // An undated corpse (one that predates the timestamp, or whose annotate
    // lost its race) still counts — it just cannot say when.
    reading = { state: 'observed', pools: { 'my-app': held({ warm: 1, failed: 1 }) } };
    expect(humanOf(await run('stamps-get', { id: 'my-app' }, AGENT))).toContain('pool=1 (warm 1) — 1 dead fill  author=');
  });

  it('a count that did not come back is NOT a count of zero — nor a driver that pools nothing', async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);
    await run('stamps-set-pool', { id: 'my-app', size: '1' }, HOST);

    // Three answers, kept apart: "there is no pool here" reads as the bare
    // desired size (the line as it was before this change), and "there IS a
    // pool and the runtime did not answer" says so. Rendering the second as
    // the first tells an author nothing-to-see about a count nobody took.
    reading = { state: 'unreadable' };
    const frame = await run('stamps-get', { id: 'my-app' }, AGENT);
    expect(humanOf(frame)).toContain('pool=1 (slots unreadable)');
    expect(dataOf(frame).pool).toEqual({ state: 'unreadable' });

    reading = { state: 'unpooled' };
    expect(humanOf(await run('stamps-get', { id: 'my-app' }, AGENT))).toContain('pool=1  author=');
  });

  it("a retired stamp's pool drains in the open — pool=0 (draining 1), not a silent flip", async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);
    await run('stamps-set-pool', { id: 'my-app', size: '1' }, HOST);
    // Retire zeroes the desired size; the warm slot it leaves behind lives
    // until the reconciler reaps it, and the row is where that is visible.
    const retired = await run('stamps-retire', { id: 'my-app' }, HOST);
    expect(dataOf(retired).state).toBe('retired');

    // Warm leads whatever else is true: "how many claims land instantly" is
    // the number being read, and a zero that renders as absence is the
    // ambiguity this whole line exists to kill.
    reading = { state: 'observed', pools: { 'my-app': held({ draining: 1 }) } };
    expect(humanOf(await run('stamps-get', { id: 'my-app' }, AGENT))).toContain('pool=0 (warm 0, draining 1)');
  });

  it('unpooled renders the desired size alone — absence is never rendered as zero', async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);
    await run('stamps-set-pool', { id: 'my-app', size: '2' }, HOST);

    // A driver that pools nothing says nothing, and the line reads exactly as
    // it did before the observed half existed — "warm 0" here would be a
    // measurement nobody made.
    reading = { state: 'unpooled' };
    const frame = await run('stamps-get', { id: 'my-app' }, AGENT);
    expect(humanOf(frame)).toContain('pool=2  author=');
    expect(dataOf(frame).pool).toEqual({ state: 'unpooled' });

    // And a stamp that never asked for a pool stays quiet either way.
    reading = { state: 'observed', pools: {} };
    await run('stamps-create', { id: 'poolless', config: APP_CONFIG }, HOST);
    expect(humanOf(await run('stamps-get', { id: 'poolless' }, AGENT))).toContain('poolless  v1  active  pool=0  author=');
  });

  it('an agent reads the same counts as the host — a pool observation carries no env to scope', async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);
    await run('stamps-set-pool', { id: 'my-app', size: '1' }, HOST);
    reading = { state: 'observed', pools: { 'my-app': held({ warm: 1 }) } };

    // Warm slots belong to nobody — they are counted, never enumerated — so
    // the agent-scoped read needs no scoping here and loses nothing to it.
    // (Its own envs stay `envs list`'s business; foreign ones stay invisible.)
    const asAgent = await run('stamps-list', {}, AGENT);
    const asHost = await run('stamps-list', {}, HOST);
    expect(humanOf(asAgent)).toBe(humanOf(asHost));
    expect(humanOf(asAgent)).toContain('pool=1 (warm 1)');
    // Four counts and a state word: there is no field here an env id could
    // ride out on, which is what makes the whole answer safe unscoped.
    const [row] = dataOf(asAgent).rows as { pool: { state: string } & PoolObservation }[];
    expect(Object.keys(row!.pool).sort()).toEqual(['draining', 'failed', 'filling', 'state', 'warm']);
  });

  it('a listing observes once for every row', async () => {
    await run('stamps-create', { id: 'a-app', config: APP_CONFIG }, HOST);
    await run('stamps-create', { id: 'b-app', config: APP_CONFIG }, HOST);
    reading = { state: 'observed', pools: { 'a-app': held({ warm: 1 }), 'b-app': held({ filling: 1 }) } };
    observations = 0;

    const human = humanOf(await run('stamps-list', {}, AGENT));
    expect(human).toContain('a-app  v1  active  pool=0 (warm 1)');
    expect(human).toContain('b-app  v1  active  pool=0 (warm 0, filling 1)');
    // One runtime query for the whole listing — the observation is a question
    // about every stamp at once, and rendering must not turn it into N.
    expect(observations).toBe(1);
  });

  /**
   * The JOIN, with nothing stubbed between the halves: a real driver counting
   * namespaces on a fake apiserver, through the real `readPools` narrowing,
   * into the real render. Every other test on this surface stubs the driver
   * and every driver test stubs the reader, so a drift between them — a
   * renamed count, a dropped state — passes both suites and reaches an author
   * as a wrong line. This is the one test that would fail instead.
   */
  it('driver counts to rendered row, with nothing stubbed in between', async () => {
    const fake = new FakeKube();
    fake.manualCompletion = false; // fills boot instantly
    const materialsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamps-pool-join-'));
    const driver = new K8sDevEnvDriver({
      installScope: 'stamps-join',
      cli: fake,
      stamps: { 'my-app': {} },
      materialsDir,
      pools: { 'my-app': 1 },
    });
    resetStampRegistry({
      store,
      source,
      images,
      resolveImage: { resolveDigest: (ref, credential) => resolveDigest(ref, credential) },
      driverCapabilities: () => driver.capabilities(),
      observePools: () => readPools(driver),
    });
    try {
      await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);
      await run('stamps-set-pool', { id: 'my-app', size: '1' }, HOST);

      // Asked for one, holding none yet — the blind minute that used to have
      // no read surface at all.
      expect(humanOf(await run('stamps-get', { id: 'my-app' }, AGENT))).toContain('pool=1 (warm 0)');

      await driver.ensureReady();
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(humanOf(await run('stamps-get', { id: 'my-app' }, AGENT))).toContain('pool=1 (warm 1)');
    } finally {
      driver.dispose();
      fs.rmSync(materialsDir, { recursive: true, force: true });
    }
  });

  it('the reading degrades, never throws — counting the pool must not break the read it rides on', () => {
    // A driver with no pool is not a failure to count one, and neither is an
    // error frame the right answer to an apiserver that stopped answering.
    expect(readPools(null)).toEqual({ state: 'unpooled' });
    expect(readPools({ kind: 'mock' })).toEqual({ state: 'unpooled' });
    expect(
      readPools({
        observePools: () => {
          throw new Error('apiserver unreachable');
        },
      }),
    ).toEqual({ state: 'unreadable' });
  });
});

describe('reads', () => {
  it('agents read openly: get by id, list with builtin reference and exclusions', async () => {
    await run('stamps-create', { id: 'my-app', config: APP_CONFIG }, HOST);

    const got = dataOf(await run('stamps-get', { id: 'my-app' }, AGENT));
    expect(got.stampId).toBe('my-app');

    const listed = dataOf(await run('stamps-list', {}, AGENT)) as {
      rows: unknown[];
      builtin: string[];
      invalid: string[];
    };
    expect(listed.rows).toHaveLength(1);
    expect(listed.builtin).toContain('nanoclaw'); // code-provided ids stay visible for reference
    expect(listed.invalid).toEqual([]);

    const missing = await run('stamps-get', { id: 'ghost' }, AGENT);
    expect(missing.ok).toBe(false);
  });

  /**
   * The node-image gate was the first claim gate with NO operator-visible
   * state, and closing it drains the stamp's warm slots — so a pool that
   * stopped filling had nowhere to be read. It renders like the placement
   * state now, in three readings that must never collapse into two.
   */
  it('renders the node-image gate: MISSING names what to import, present says so, unchecked says NEITHER', async () => {
    const config = JSON.stringify({
      childManifests: '{"kind":"Namespace"}',
      readiness: { deployment: 'api', namespace: 'default' },
      nodeImages: ['child-host:v06', 'gw:v12'],
    });
    await run('stamps-create', { id: 'stack', config }, HOST);

    // No probe is wired on this source: the assertion gates nothing, and
    // saying "present" here would sell an assertion nobody made.
    const unchecked = await run('stamps-get', { id: 'stack' }, AGENT);
    expect(unchecked.ok && unchecked.human).toContain('nodeImages: UNCHECKED');
    expect(unchecked.ok && unchecked.human).toContain('gw:v12');

    probeMissing = ['gw:v12'];
    await source.refresh();
    const shut = await run('stamps-get', { id: 'stack' }, AGENT);
    expect(shut.ok && shut.human).toContain('nodeImages: MISSING 1 of 2');
    expect(shut.ok && shut.human).toContain('gw:v12');
    expect(shut.ok && shut.human).toContain('ctr images import');

    probeMissing = [];
    await source.refresh();
    const open = await run('stamps-get', { id: 'stack' }, AGENT);
    expect(open.ok && open.human).toContain('nodeImages: in the node store');
  });
});

describe('dormant seam', () => {
  it('answers "dev-env is off" instead of pretending', async () => {
    resetStampRegistry(null);
    const frame = await run('stamps-list', {}, HOST);
    expect(frame.ok).toBe(false);
    if (!frame.ok) expect(frame.error.message).toContain('NANOCLAW_DEV_ENV_DRIVER');
  });
});
