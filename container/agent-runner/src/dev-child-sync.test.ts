/**
 * The dev-child-sync skill's executable, driven as the sandbox drives it: a
 * spawned `bun child-sync.ts` against shim kubectl/tar/ncl binaries on a
 * controlled PATH. The test lives here, not beside the script — the skill
 * dir is stamped verbatim into every code-mode session (compose.ts cpSync),
 * so a file added there rides into every workspace.
 *
 * What is pinned: the per-stage exit codes are the tool's contract with the
 * agent reading them, and the kubectl argv lines are the dev-mode manifest
 * made concrete (dest /nanoclaw/host, the six excludes, rollout on
 * nanoclaw/nanoclaw-host). A drift here is a silent sync-to-nowhere.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(import.meta.dir, '../../code-mode/skills/dev-child-sync/child-sync.ts');

let tmp: string;
let logFile: string;
let shims: string;
let sourceTree: string;
let kubeconfig: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'child-sync-'));
  logFile = path.join(tmp, 'invocations.log');
  shims = path.join(tmp, 'bin');
  fs.mkdirSync(shims);
  sourceTree = path.join(tmp, 'checkout');
  for (const dir of ['src', 'container']) fs.mkdirSync(path.join(sourceTree, dir), { recursive: true });
  fs.writeFileSync(path.join(sourceTree, 'package.json'), '{}');
  kubeconfig = path.join(tmp, 'kubeconfig');
  fs.writeFileSync(kubeconfig, 'apiVersion: v1');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function shim(name: string, body: string): void {
  const file = path.join(shims, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/**
 * Branches keyed on argv substrings; failure injection via FAIL_* env. The
 * chat branch prints pnpm's real run banner (pnpm 10 sends it to STDOUT)
 * unless --silent is in the argv — dropping --silent from the probe leg
 * must pollute stdout here the way it would against a live pod.
 *
 * NO_DRAIN/STALL are the shapes a shim cannot fake by exiting at t=0: the
 * extract side has to abandon a stream that is still being written, which is
 * what leaves the tar side blocked on a full pipe. Each answers `hostname`
 * with a fresh pod name, so the reload's identity check sees a new pod unless
 * SAME_POD pins it.
 */
function shimKubectl(): void {
  shim(
    'kubectl',
    `echo "kubectl $*" >> "$LOG"
case "$*" in
  *"version --client"*) exit 0 ;;
  *"get deployment"*) if [ "$FAIL_GET" = 1 ]; then exit 1; fi; echo deployment.apps/nanoclaw-host ;;
  *"-- hostname"*)
    if [ "$SAME_POD" = 1 ]; then echo nanoclaw-host-stuck; exit 0; fi
    n=$(cat "$LOG.pod" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$LOG.pod"; echo "nanoclaw-host-$n" ;;
  *"exec -i"*)
    if [ "$STALL" = 1 ]; then exec sleep 20; fi
    if [ "$NO_DRAIN" = 1 ]; then sleep 1; exit 137; fi
    cat > /dev/null; if [ "$FAIL_EXTRACT" = 1 ]; then exit 1; fi ;;
  *"pnpm run build"*) if [ "$SLOW_BUILD" = 1 ]; then exec sleep 20; fi; if [ "$FAIL_BUILD" = 1 ]; then exit 1; fi ;;
  *"run chat"*)
    case "$*" in *"--silent"*) ;; *) echo; echo "> nanoclaw@2.0.0 chat /nanoclaw/host"; echo "> tsx scripts/chat.ts"; echo ;; esac
    if [ "$FAIL_CHAT" = 1 ]; then exit 3; fi; if [ "$EMPTY_CHAT" != 1 ]; then echo "mock reply"; fi ;;
  *"rollout status"*) if [ "$FAIL_STATUS" = 1 ]; then exit 1; fi ;;
esac
exit 0`,
  );
}

/**
 * `bytes` past the 64KB pipe buffer leaves output nobody has read; `hold`
 * keeps the process alive after writing it, the way a real tar is alive while
 * it walks the rest of the tree. Both together are the condition the happy
 * path never reaches: unconsumed bytes AND a source that has not exited.
 * `exec sleep` so a kill lands on the sleeper itself — an orphan would hold
 * the inherited stderr pipe open and stall the harness reading it.
 */
function shimTar(bytes = 0, hold = 0): void {
  const write = bytes > 0 ? `yes nanoclaw | head -c ${bytes}` : 'printf payload';
  shim('tar', `echo "tar $*" >> "$LOG"\n${write}\n${hold > 0 ? `exec sleep ${hold}` : ''}`);
}

/**
 * The child gets its own timeout so a sync that hangs fails an assertion here
 * instead of hanging the suite: spawnSync blocks the thread, so bun's per-test
 * timeout cannot interrupt it.
 */
function run(args: string[], env: Record<string, string> = {}, timeout = 30_000) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout,
    env: { PATH: `${shims}:/usr/bin:/bin`, HOME: tmp, LOG: logFile, ...env },
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    hung: (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    ms: Date.now() - started,
  };
}

function logLines(): string[] {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [];
}

const happyArgs = () => ['--kubeconfig', kubeconfig, '--source', sourceTree];

describe('child-sync usage surface', () => {
  it('--help prints usage and exits 0', () => {
    const res = run(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage: child-sync.ts');
  });

  it('an unknown flag is exit 1', () => {
    const res = run(['--frobnicate']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown argument');
  });
});

describe('child-sync preflight (exit 2)', () => {
  it('kubectl absent from PATH names the workspace-install fact', () => {
    const res = run(happyArgs());
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('kubectl is not on PATH');
    expect(res.stderr).toContain('/workspace/tools/bin');
  });

  it('a source tree without src/ is refused before anything streams', () => {
    shimKubectl();
    shimTar();
    fs.rmSync(path.join(sourceTree, 'src'), { recursive: true });
    const res = run(happyArgs());
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('lacks src/');
    expect(logLines().join('\n')).not.toContain('exec -i');
  });

  it('a missing deployment is exit 2, not a later-stage surprise', () => {
    shimKubectl();
    shimTar();
    const res = run(happyArgs(), { FAIL_GET: '1' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('deployment/nanoclaw-host');
  });
});

describe('child-sync stages in order', () => {
  it('runs preflight → transfer → build → rollout → probe and prints the reply', () => {
    shimKubectl();
    shimTar();
    const res = run(happyArgs());
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('mock reply');

    const log = logLines();
    const at = (needle: string) => log.findIndex((line) => line.includes(needle));
    // --silent pinned in the probe needle: without it pnpm's stdout banner
    // rides into the reply and the empty-reply guard is unreachable.
    for (const needle of ['get deployment', 'tar -xz', 'pnpm run build', 'rollout restart', 'rollout status', 'pnpm --silent run chat']) {
      expect(at(needle)).toBeGreaterThanOrEqual(0);
    }
    expect(at('get deployment')).toBeLessThan(at('tar -xz'));
    expect(at('tar -xz')).toBeLessThan(at('pnpm run build'));
    expect(at('pnpm run build')).toBeLessThan(at('rollout restart'));
    expect(at('rollout restart')).toBeLessThan(at('rollout status'));
    expect(at('rollout status')).toBeLessThan(at('pnpm --silent run chat'));
    // The pod identity has to be read before the restart — after it there is
    // nothing left to compare the new pod against.
    expect(at('-- hostname')).toBeGreaterThanOrEqual(0);
    expect(at('-- hostname')).toBeLessThan(at('rollout restart'));
  });

  it('the tar side carries the manifest exactly: both dirs, all six excludes, the pinned dest', () => {
    shimKubectl();
    shimTar();
    run(happyArgs());
    const log = logLines();
    const tarLine = log.find((line) => line.startsWith('tar '))!;
    expect(tarLine).toContain(`-C ${sourceTree}`);
    expect(tarLine).toMatch(/ src container$/);
    for (const excl of ['node_modules', '.git', 'data', 'groups', 'dist', '.env']) {
      expect(tarLine).toContain(`--exclude=${excl}`);
    }
    const extractLine = log.find((line) => line.includes('exec -i'))!;
    // Plain overwrite pinned: --unlink-first was reverted — GNU tar applies
    // it to directory entries and cannot unlink a non-empty directory, so
    // every dir in the archive errors (measured live on the child).
    expect(extractLine).toContain('-n nanoclaw deploy/nanoclaw-host -- tar -xz -C /nanoclaw/host');
    expect(extractLine).toContain(`--kubeconfig ${kubeconfig}`);
  });

  it('a failed in-pod extraction is exit 3', () => {
    shimKubectl();
    shimTar();
    const res = run(happyArgs(), { FAIL_EXTRACT: '1' });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('extraction');
  });

  it('a failed in-instance build is exit 4 and the rollout is not reached', () => {
    shimKubectl();
    shimTar();
    const res = run(happyArgs(), { FAIL_BUILD: '1' });
    expect(res.status).toBe(4);
    expect(logLines().join('\n')).not.toContain('rollout');
  });

  it('a rollout wait that never goes Available is exit 5', () => {
    shimKubectl();
    shimTar();
    const res = run(happyArgs(), { FAIL_STATUS: '1' });
    expect(res.status).toBe(5);
    expect(res.stderr).toContain('not Available');
  });

  it('a chat round-trip with no reply is exit 6 — exec success alone is not delivery', () => {
    shimKubectl();
    shimTar();
    const res = run(happyArgs(), { EMPTY_CHAT: '1' });
    expect(res.status).toBe(6);
    expect(res.stderr).toContain('no reply');
    expect(run(happyArgs(), { FAIL_CHAT: '1' }).status).toBe(6);
  });
});

/**
 * The stages the tool cannot walk away from on its own. A dead extract side
 * leaves an unread tar side behind — node unpipes and pauses the source, so
 * its buffered stdout never closes and a wait on 'close' outlives the pod by
 * as long as the source stays alive — and an exec that never returns has no
 * bound but the tool's own.
 *
 * The tar shim outlives the extract side by 30s here, so both the elapsed
 * time and `hung` separate a tool that gives up when the far end dies from
 * one that waits the source out (or forever): a regression reads as a failed
 * assertion within seconds, never as a stuck CI job.
 */
describe('child-sync bounds every exec stage', () => {
  it(
    'an extract side that abandons a stream still being written is exit 3, not a hang',
    () => {
      shimKubectl();
      shimTar(200_000, 30);
      const res = run(happyArgs(), { NO_DRAIN: '1' }, 25_000);
      expect(res.hung).toBe(false);
      expect(res.ms).toBeLessThan(15_000);
      expect(res.status).toBe(3);
      expect(res.stderr).toContain('still streaming');
      expect(res.stderr).toContain('part old and part new');
    },
    90_000,
  );

  it(
    'a transfer that never drains is cut off at the deadline — exit 3, timed out',
    () => {
      shimKubectl();
      shimTar(200_000, 30);
      const res = run([...happyArgs(), '--exec-timeout', '1'], { STALL: '1' }, 25_000);
      expect(res.hung).toBe(false);
      expect(res.ms).toBeLessThan(15_000);
      expect(res.status).toBe(3);
      expect(res.stderr).toContain('timed out');
      expect(res.stderr).toContain('part old and part new');
    },
    90_000,
  );

  it(
    'an in-instance build that never returns is exit 4, timed out',
    () => {
      shimKubectl();
      shimTar();
      const res = run([...happyArgs(), '--exec-timeout', '1'], { SLOW_BUILD: '1' }, 25_000);
      expect(res.hung).toBe(false);
      expect(res.ms).toBeLessThan(15_000);
      expect(res.status).toBe(4);
      expect(res.stderr).toContain('timed out');
      expect(res.stderr).toContain('unbuilt');
    },
    90_000,
  );

  it('--exec-timeout takes whole seconds', () => {
    const res = run([...happyArgs(), '--exec-timeout', 'soon']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('whole seconds');
  });
});

describe('child-sync reload identity', () => {
  it('the same pod answering after the rollout is exit 5 — Available alone is not a restart', () => {
    shimKubectl();
    shimTar();
    const res = run(happyArgs(), { SAME_POD: '1' });
    expect(res.status).toBe(5);
    expect(res.stderr).toContain('still answers on pod nanoclaw-host-stuck');
    expect(logLines().join('\n')).not.toContain('run chat');
  });

  it('a pod that cannot be identified leaves the check unarmed rather than failing the sync', () => {
    // The hostname branch is what answers; without it the shim exits 0 with no
    // stdout, which is the mid-restart case the tool must not turn into exit 5.
    shim(
      'kubectl',
      `echo "kubectl $*" >> "$LOG"
case "$*" in
  *"get deployment"*) echo deployment.apps/nanoclaw-host ;;
  *"exec -i"*) cat > /dev/null ;;
  *"run chat"*) echo "mock reply" ;;
esac
exit 0`,
    );
    shimTar();
    const res = run(happyArgs());
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('mock reply');
  });
});

describe('child-sync kubeconfig default', () => {
  // The REAL verb shapes, measured live 2026-08-17: `envs list --json`
  // returns bare registry rows whose `endpoints`/`access` are ALWAYS `{}`;
  // only `envs get <id> --json` consults the driver and fills
  // `data.access.kubeconfig`. The shim serves each verb its own frame so a
  // discovery that reads access off the list — the shipped v1 bug — fails
  // here instead of live.
  function shimNcl(listFrame: unknown, getFrame?: unknown): void {
    fs.writeFileSync(path.join(tmp, 'ncl-list.json'), JSON.stringify(listFrame));
    fs.writeFileSync(
      path.join(tmp, 'ncl-get.json'),
      JSON.stringify(getFrame ?? { ok: false, error: { message: 'no get frame shimmed' } }),
    );
    shim(
      'ncl',
      `echo "ncl $*" >> "$LOG"\nif [ "$2" = "get" ]; then cat "${path.join(tmp, 'ncl-get.json')}"; else cat "${path.join(tmp, 'ncl-list.json')}"; fi`,
    );
  }

  it('list chooses the nanoclaw env, get resolves its kubeconfig — list access is always empty', () => {
    shimKubectl();
    shimTar();
    shimNcl(
      {
        ok: true,
        data: [
          { envId: 'env-a', state: 'active', stampId: 'sample-app', endpoints: {}, access: {} },
          { envId: 'env-b', state: 'active', stampId: 'nanoclaw', endpoints: {}, access: {} },
          { envId: 'env-c', state: 'released', stampId: 'nanoclaw', endpoints: {}, access: {} },
        ],
      },
      { ok: true, data: { envId: 'env-b', state: 'active', stampId: 'nanoclaw', access: { kubeconfig } } },
    );
    const res = run(['--source', sourceTree]);
    expect(res.status).toBe(0);
    expect(logLines().some((line) => line.includes('ncl envs get env-b --json'))).toBe(true);
    expect(logLines().some((line) => line.includes(`--kubeconfig ${kubeconfig}`))).toBe(true);
  });

  it('two claimed nanoclaw envs make the default ambiguous — exit 2 asks for the flag', () => {
    shimKubectl();
    shimNcl({
      ok: true,
      data: [
        { envId: 'env-a', state: 'active', stampId: 'nanoclaw', access: {} },
        { envId: 'env-b', state: 'active', stampId: 'nanoclaw', access: {} },
      ],
    });
    const res = run(['--source', sourceTree]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('pass --kubeconfig');
    expect(res.stderr).toContain('env-a');
  });

  it('no claimed env at all points at the claim verb', () => {
    shimKubectl();
    shimNcl({ ok: true, data: [] });
    const res = run(['--source', sourceTree]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('ncl envs claim --stamp nanoclaw');
  });

  it('an active env whose get answers without access.kubeconfig is a named preflight refusal', () => {
    shimKubectl();
    shimNcl(
      { ok: true, data: [{ envId: 'env-a', state: 'active', stampId: 'nanoclaw', access: {} }] },
      { ok: true, data: { envId: 'env-a', state: 'active', stampId: 'nanoclaw', access: {} } },
    );
    const res = run(['--source', sourceTree]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('no access.kubeconfig');
  });

  it('an ncl refusal frame surfaces its own message, not a claim hint — ncl exits 0 in --json even on errors', () => {
    shimKubectl();
    shimNcl({ ok: false, error: { message: 'dev-env is not enabled on this host — set NANOCLAW_DEV_ENV_DRIVER and restart' } });
    const res = run(['--source', sourceTree]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('dev-env is not enabled on this host');
    expect(res.stderr).not.toContain('ncl envs claim');
  });

  it('an exported $KUBECONFIG is ignored — discovery still picks the claimed env', () => {
    shimKubectl();
    shimTar();
    shimNcl(
      { ok: true, data: [{ envId: 'env-a', state: 'active', stampId: 'nanoclaw', access: {} }] },
      { ok: true, data: { envId: 'env-a', state: 'active', stampId: 'nanoclaw', access: { kubeconfig } } },
    );
    const stray = path.join(tmp, 'stray-kubeconfig');
    fs.writeFileSync(stray, 'apiVersion: v1');
    const res = run(['--source', sourceTree], { KUBECONFIG: stray });
    expect(res.status).toBe(0);
    expect(logLines().some((line) => line.includes(`--kubeconfig ${kubeconfig}`))).toBe(true);
    expect(logLines().some((line) => line.includes(stray))).toBe(false);
  });
});
