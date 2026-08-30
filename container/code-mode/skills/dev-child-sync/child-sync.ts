#!/usr/bin/env bun
/**
 * child-sync — the nanoclaw stamp's dev-mode manifest, executed from a sandbox.
 *
 * The stamp declares: artifact tree · prepare build · dest /nanoclaw/host ·
 * exclude [node_modules, .git, data, groups, dist, .env] · reload rollout
 * {nanoclaw/nanoclaw-host}. Transport belongs to the executor, and from a
 * sandbox exactly one transport exists: the child apiserver's exec stream —
 * the claim route opens nothing else, and the child can fetch nothing for
 * itself (no repo credentials, default-deny egress). So the tree rides a tar
 * pipe over `kubectl exec -i`, the build runs in-instance, and
 * reload-complete is the stamp's own readiness gate going green again.
 *
 * Node builtins only: this file executes from a read-only skill mount with
 * no node_modules beside it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NAMESPACE = 'nanoclaw';
const DEPLOYMENT = 'nanoclaw-host';
const DEST = '/nanoclaw/host';
const SYNC_DIRS = ['src', 'container'];
const EXCLUDES = ['node_modules', '.git', 'data', 'groups', 'dist', '.env'];

/** One exit code per stage — which stage failed is machine-readable. */
const EXIT = { usage: 1, preflight: 2, transfer: 3, build: 4, rollout: 5, probe: 6 } as const;

/**
 * What a failed extraction leaves behind. DEST is the LIVE tree, not a staging
 * area — the extract writes into the running instance, and the host re-reads
 * that tree for every session pod it spawns (container/agent-runner/src rides
 * in read-only, the skills are copied per spawn). So a cut-off extract is a
 * mixed tree that the next session picks up, not a no-op.
 */
const PARTIAL = `${DEST} is the live tree, so it may now be part old and part new, and sessions the child spawns read from it — re-run the sync to converge before relying on them`;

const USAGE = `usage: child-sync.ts [reload] [--kubeconfig <path>] [--source <dir>] [--exec-timeout <seconds>] [--rollout-timeout <seconds>]

Sync <dir> (default: cwd) into the claimed nanoclaw child that <path> names
(default: the one claimed env's minted kubeconfig), rebuild in-instance,
roll the host, and probe it with a chat round-trip.

The 'reload' arm is the DEV-FLAVOR hot loop: the child already mounts your
working tree (claimed with --dev <dir>), so nothing
transfers — build HERE (dist/ appears in the child through the mount), roll
the host, probe. Refused against a baked child: without the mount a reload
would just reboot the old tree.

exit codes: 0 synced+probed · 1 usage · 2 preflight · 3 transfer · 4 build · 5 rollout · 6 probe`;

function note(msg: string): void {
  process.stderr.write(`[child-sync] ${msg}\n`);
}

function fail(code: number, msg: string): never {
  process.stderr.write(`child-sync: ${msg}\n`);
  process.exit(code);
}

type Args = { mode: 'sync' | 'reload'; kubeconfig?: string; source?: string; execTimeout: number; rolloutTimeout: number };

/**
 * execTimeout is a hang bound, not a budget for the work: nothing else bounds
 * an exec stream, so a pod that dies or stops answering mid-stage would
 * otherwise wait forever. 600s is far above what a few MB of source, a tsc
 * run, or a mock round-trip take, and far below "never".
 */
function parseArgv(argv: string[]): Args {
  const args: Args = { mode: 'sync', execTimeout: 600, rolloutTimeout: 300 };
  if (argv[0] === 'reload') {
    args.mode = 'reload';
    argv = argv.slice(1);
  }
  const take = (flag: string, inline: string | undefined, next: () => string | undefined): string => {
    const value = inline ?? next();
    if (value === undefined || value.startsWith('--')) fail(EXIT.usage, `${flag} needs a value\n${USAGE}`);
    return value;
  };
  const seconds = (flag: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) fail(EXIT.usage, `${flag} takes whole seconds\n${USAGE}`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--help' || raw === '-h') {
      process.stdout.write(USAGE + '\n');
      process.exit(0);
    }
    const eq = raw.indexOf('=');
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const next = () => (inline === undefined ? argv[++i] : undefined);
    if (flag === '--kubeconfig') args.kubeconfig = take(flag, inline, next);
    else if (flag === '--source') args.source = take(flag, inline, next);
    else if (flag === '--exec-timeout') args.execTimeout = seconds(flag, take(flag, inline, next));
    else if (flag === '--rollout-timeout') args.rolloutTimeout = seconds(flag, take(flag, inline, next));
    else fail(EXIT.usage, `unknown argument "${raw}"\n${USAGE}`);
  }
  return args;
}

type EnvSnapshot = { envId?: unknown; state?: unknown; stampId?: unknown; access?: Record<string, unknown> };

/**
 * The claimed env's minted kubeconfig path. `ncl envs list` returns bare
 * registry rows — `endpoints` and `access` are ALWAYS `{}` there (measured
 * live 2026-08-17); only `ncl envs get` consults the driver and fills
 * `access.kubeconfig` (minting the file if a deploy swept it). So: list to
 * choose the env, get to resolve its access. The path `get` prints is
 * mounted into this sandbox at that exact host path, so the value is
 * directly openable. One active env is an unambiguous default; among
 * several, one with the `nanoclaw` stamp still is — anything else needs
 * --kubeconfig.
 */
function discoverKubeconfig(): string {
  const res = spawnSync('ncl', ['envs', 'list', '--live', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (res.error || res.status !== 0) {
    fail(EXIT.preflight, 'no --kubeconfig given and `ncl envs list` did not answer — pass --kubeconfig, or claim an env first (ncl envs claim --stamp nanoclaw)');
  }
  let frame: { ok?: boolean; data?: unknown; error?: { message?: unknown } };
  try {
    frame = JSON.parse(res.stdout) as typeof frame;
  } catch {
    fail(EXIT.preflight, 'no --kubeconfig given and `ncl envs list --json` printed something that is not JSON');
  }
  // ncl in --json mode exits 0 even on a refusal — the frame's ok field is
  // the verdict, and its own message is the diagnosis, not "no envs".
  if (frame.ok === false) {
    const why = typeof frame.error?.message === 'string' ? frame.error.message : 'an unnamed error';
    fail(EXIT.preflight, `no --kubeconfig given and \`ncl envs list\` refused: ${why}`);
  }
  const envs: EnvSnapshot[] = frame.ok && Array.isArray(frame.data) ? (frame.data as EnvSnapshot[]) : [];
  const actives = envs.filter((e) => e.state === 'active');
  if (actives.length === 0) {
    fail(EXIT.preflight, 'no active claimed env — claim one (ncl envs claim --stamp nanoclaw) or pass --kubeconfig');
  }
  const chosen = actives.length === 1 ? actives : actives.filter((e) => e.stampId === 'nanoclaw');
  if (chosen.length !== 1) {
    const ids = actives.map((e) => String(e.envId)).join(', ');
    fail(EXIT.preflight, `several active claimed envs (${ids}) — pass --kubeconfig to pick one`);
  }
  const envId = String(chosen[0].envId);
  const got = spawnSync('ncl', ['envs', 'get', envId, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (got.error || got.status !== 0) {
    fail(EXIT.preflight, `no --kubeconfig given and \`ncl envs get ${envId}\` did not answer — pass --kubeconfig`);
  }
  let getFrame: { ok?: boolean; data?: EnvSnapshot; error?: { message?: unknown } };
  try {
    getFrame = JSON.parse(got.stdout) as typeof getFrame;
  } catch {
    fail(EXIT.preflight, `no --kubeconfig given and \`ncl envs get ${envId} --json\` printed something that is not JSON`);
  }
  if (getFrame.ok === false) {
    const why = typeof getFrame.error?.message === 'string' ? getFrame.error.message : 'an unnamed error';
    fail(EXIT.preflight, `no --kubeconfig given and \`ncl envs get ${envId}\` refused: ${why}`);
  }
  const kubeconfig = getFrame.data?.access?.kubeconfig;
  if (typeof kubeconfig !== 'string' || kubeconfig.length === 0) {
    fail(EXIT.preflight, `env ${envId} is active but \`ncl envs get\` returned no access.kubeconfig — pass --kubeconfig`);
  }
  return kubeconfig;
}

/**
 * The child transport, shared by both arms. No $KUBECONFIG step: a leftover
 * export from earlier kubectl work would silently retarget the run at
 * whatever child it names. Every kubectl call gets --kubeconfig explicitly,
 * so the env var steers nothing.
 */
function childBase(args: Args): { base: string[]; kubeconfig: string } {
  const kubeconfig = args.kubeconfig ?? discoverKubeconfig();
  const base = ['--kubeconfig', kubeconfig];

  const probe = spawnSync('kubectl', ['version', '--client'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    fail(EXIT.preflight, 'kubectl is not on PATH — the image ships none; install one into /workspace/tools/bin (dev-toolchains) and export PATH');
  }
  if (!fs.existsSync(kubeconfig)) {
    fail(EXIT.preflight, `kubeconfig not readable at ${kubeconfig} — a released env's minted path is gone; \`ncl envs list\` shows what is claimed`);
  }
  return { base, kubeconfig };
}

function preflight(args: Args): { base: string[]; source: string } {
  const { base, kubeconfig } = childBase(args);

  const source = path.resolve(args.source ?? process.cwd());
  for (const dir of SYNC_DIRS) {
    if (!fs.existsSync(path.join(source, dir)) || !fs.statSync(path.join(source, dir)).isDirectory()) {
      fail(EXIT.preflight, `source tree ${source} lacks ${dir}/ — a nanoclaw checkout carries src/, container/, package.json (pass --source)`);
    }
  }
  if (!fs.existsSync(path.join(source, 'package.json'))) {
    fail(EXIT.preflight, `source tree ${source} lacks package.json — the in-instance build needs the full checkout shape (pass --source)`);
  }

  const found = spawnSync('kubectl', [...base, 'get', 'deployment', DEPLOYMENT, '-n', NAMESPACE, '-o', 'name'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (found.error || found.status !== 0) {
    fail(EXIT.preflight, `deployment/${DEPLOYMENT} did not answer in namespace ${NAMESPACE} via ${kubeconfig} — is this a nanoclaw-stamp child?`);
  }
  return { base, source };
}

type Transfer = {
  tar: number | null;
  kubectl: number | null;
  error?: Error;
  timedOut: boolean;
  /** kubectl stopped reading before tar reached EOF — DEST holds a cut-off archive. */
  truncated: boolean;
};

/**
 * `tar cz | kubectl exec -i … tar xz` as two processes on one pipe: both exit
 * codes matter and are reported apart — a dead kubectl EPIPEs tar, and the
 * swallowed stream errors below keep the verdict with the exit codes.
 *
 * Settling is on 'exit', never 'close', and a settled kubectl tears the tar
 * side down: node's pipe() unpipes and PAUSES the source when the destination
 * dies, so an unread tar blocks forever on a full pipe — its stdio never
 * closes, 'close' never fires, and the wait would hang for as long as the pod
 * stayed dead (measured under both bun and node). Only this direction is
 * safe: a healthy kubectl exits only after tar's EOF, so by then tar has
 * settled and the teardown is a no-op, whereas killing kubectl when tar exits
 * would cut the extract off in the middle of every successful run.
 *
 * Plain overwrite extraction, deliberately. `--unlink-first` was tried and
 * reverted: GNU tar applies it to DIRECTORY entries too, and a non-empty
 * directory cannot be unlinked — every dir in the archive errors and the
 * extract fails (measured live on the child, 2026-08-17). So files are
 * O_TRUNC-overwritten in place; a session pod holding a mount of this tree
 * open can observe mid-write content. That residual is documented in
 * SKILL.md: the host's own dist/ is untouched (built after transfer,
 * swapped by the rollout), and sessions in a dev child are disposable.
 */
function transfer(base: string[], source: string, timeoutMs: number): Promise<Transfer> {
  return new Promise((resolve) => {
    const result: Transfer = { tar: null, kubectl: null, timedOut: false, truncated: false };
    const tar = spawn('tar', ['-cz', '-C', source, ...EXCLUDES.map((e) => `--exclude=${e}`), ...SYNC_DIRS], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const kubectl = spawn(
      'kubectl',
      [...base, 'exec', '-i', '-n', NAMESPACE, `deploy/${DEPLOYMENT}`, '--', 'tar', '-xz', '-C', DEST],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    const tearDown = () => {
      tar.stdout!.destroy();
      tar.kill();
      kubectl.kill();
    };
    const deadline = setTimeout(() => {
      result.timedOut = true;
      tearDown();
    }, timeoutMs);

    let open = 2;
    let tarSettled = false;
    const wait = (child: ChildProcess, onto: (code: number | null) => void) => {
      let settled = false;
      const settle = (code: number | null, err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) result.error = err;
        onto(code);
        if (--open === 0) {
          clearTimeout(deadline);
          resolve(result);
        }
      };
      child.on('error', (err) => settle(null, err));
      child.on('exit', (code) => settle(code));
    };
    kubectl.stdin!.on('error', () => {});
    tar.stdout!.on('error', () => {});
    tar.stdout!.pipe(kubectl.stdin!);
    wait(tar, (code) => {
      tarSettled = true;
      result.tar = code;
    });
    wait(kubectl, (code) => {
      result.kubectl = code;
      if (!tarSettled) {
        result.truncated = true;
        tearDown();
      }
    });
  });
}

/** spawnSync's own timeout kill: status null, signal SIGTERM, ETIMEDOUT set. */
function timedOut(res: { error?: Error }): boolean {
  return (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
}

/**
 * Which pod `deploy/…` currently answers on. A pod's hostname is its name (the
 * stamp's Deployment sets no spec.hostname), so this is the identity a reload
 * has to change. Unknown ('' — mid-restart, or no route) is not a failure: it
 * only leaves the caller's comparison unarmed rather than inventing one.
 */
function podIdentity(base: string[], timeoutMs: number): string {
  const res = spawnSync('kubectl', [...base, 'exec', '-n', NAMESPACE, `deploy/${DEPLOYMENT}`, '--', 'hostname'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
  });
  return res.status === 0 ? (res.stdout ?? '').trim() : '';
}

/**
 * The reload half both arms share: capture pod identity, Recreate-roll the
 * deployment, wait out the socket readiness gate, prove the process was
 * REPLACED (same pod answering = the old tree still runs), then a chat
 * round-trip. Never returns on failure — each stage exits with its code.
 */
function reloadAndProbe(base: string[], args: Args): void {
  const execTimeoutMs = args.execTimeout * 1000;

  // Captured before the restart, compared after: the reload gate is a socket
  // probe, and the child image's entrypoint unlinks data/ncl.sock before exec
  // (the socket lives on the tree and node never unlinks it), so a green gate
  // means THIS boot reached its last step. That it is a new boot at all is
  // what pod identity proves — Recreate leaves no old pod to answer for.
  const beforeReload = podIdentity(base, execTimeoutMs);

  const restart = spawnSync('kubectl', [...base, 'rollout', 'restart', `deployment/${DEPLOYMENT}`, '-n', NAMESPACE], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (restart.error || restart.status !== 0) {
    fail(EXIT.rollout, `rollout restart exited ${restart.status ?? String(restart.error)}`);
  }
  const status = spawnSync(
    'kubectl',
    [...base, 'rollout', 'status', `deployment/${DEPLOYMENT}`, '-n', NAMESPACE, `--timeout=${args.rolloutTimeout}s`],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (status.error || status.status !== 0) {
    fail(EXIT.rollout, `deployment/${DEPLOYMENT} not Available within ${args.rolloutTimeout}s — the readiness gate is the host's boot-complete socket, so the new pod has not finished booting`);
  }
  const afterReload = podIdentity(base, execTimeoutMs);
  if (beforeReload !== '' && beforeReload === afterReload) {
    fail(EXIT.rollout, `deployment/${DEPLOYMENT} still answers on pod ${afterReload} after the rollout — the process was never replaced, so the child keeps running the tree it booted with`);
  }
  note('reload ok — new pod, readiness gate green');

  // Runner sources load at session-container spawn, not at host rollout: a
  // session pod alive across the reload keeps executing the runner it booted
  // with, so the probe (and every message after it) answers from the
  // pre-reload tree — an edit that reads as inexplicably ignored. Recycle
  // them; the host respawns a session on the next due message, reading the
  // tree as it now is. A no-op when no session is live.
  const pods = spawnSync('kubectl', [...base, 'get', 'pods', '-n', NAMESPACE, '-o', 'name'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (pods.error || pods.status !== 0) {
    fail(EXIT.rollout, `could not list session pods for the recycle — kubectl get pods exited ${pods.status ?? String(pods.error)}`);
  }
  const sessionPods = (pods.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('pod/') && !line.startsWith(`pod/${DEPLOYMENT}-`));
  if (sessionPods.length > 0) {
    const recycle = spawnSync(
      'kubectl',
      [...base, 'delete', '-n', NAMESPACE, '--ignore-not-found', '--wait=false', ...sessionPods],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (recycle.error || recycle.status !== 0) {
      fail(EXIT.rollout, `session-pod recycle exited ${recycle.status ?? String(recycle.error)}`);
    }
    note(`recycled ${sessionPods.length} session pod(s) — the next spawn reads the reloaded tree`);
  }

  const text = `child-sync probe ${new Date().toISOString()}`;
  // The probe text travels as a positional so no reply-shaped input can
  // splice into the in-pod shell line. --silent because pnpm's run banner
  // prints to STDOUT — without it the reply is never the only output and
  // the empty-reply check below could never fire.
  const probe = spawnSync(
    'kubectl',
    [...base, 'exec', '-n', NAMESPACE, `deploy/${DEPLOYMENT}`, '--', 'sh', '-c', `cd ${DEST} && exec pnpm --silent run chat "$1"`, 'child-sync', text],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: execTimeoutMs },
  );
  if (timedOut(probe)) {
    fail(EXIT.probe, `the chat round-trip timed out after ${args.execTimeout}s — the tree is in place, built and rolled out, and the host booted far enough to pass its readiness gate, but the message got no answer`);
  }
  const reply = (probe.stdout ?? '').trim();
  if (probe.error || probe.status !== 0 || reply === '') {
    fail(
      EXIT.probe,
      probe.status === 0
        ? 'chat round-trip printed no reply — the host answered exec but delivered nothing'
        : `chat round-trip exited ${probe.status ?? String(probe.error)} — the host is up but did not answer`,
    );
  }
  process.stdout.write(reply + '\n');
}

/**
 * The dev-flavor hot loop. The mount IS the transport (D10: transport is the
 * executor's business, and here the executor has none to do): build in the
 * WORKSPACE — dist/ appears inside the child through the volume — then roll
 * and probe. Guarded against the baked flavor: without the mount, a reload
 * boots the same old tree and reads as an inexplicably ignored edit.
 */
function runReload(args: Args): void {
  const { base } = childBase(args);
  const execTimeoutMs = args.execTimeout * 1000;

  const flag = spawnSync(
    'kubectl',
    [...base, 'get', 'deployment', DEPLOYMENT, '-n', NAMESPACE, '-o',
      `jsonpath={.spec.template.spec.containers[0].env[?(@.name=="NANOCLAW_DEV_TREE")].value}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: execTimeoutMs },
  );
  if (flag.error || flag.status !== 0) {
    fail(EXIT.preflight, `deployment/${DEPLOYMENT} did not answer in namespace ${NAMESPACE} — is this a nanoclaw-stamp child?`);
  }
  if ((flag.stdout ?? '').trim() !== '1') {
    fail(EXIT.preflight, `this child is not a dev-flavor claim (no NANOCLAW_DEV_TREE=1 on deployment/${DEPLOYMENT}) — reload has nothing mounted to reload; use the sync arm, or claim with --dev <dir>`);
  }

  const source = path.resolve(args.source ?? process.cwd());
  if (!fs.existsSync(path.join(source, 'package.json'))) {
    fail(EXIT.preflight, `source tree ${source} lacks package.json — pass --source, and point it at the tree the claim mounted`);
  }
  // The child runs from YOUR tree, deps included: the baked image's deps live
  // under /opt, which the dev flavor never seeds into the mount.
  if (!fs.existsSync(path.join(source, 'node_modules'))) {
    fail(EXIT.preflight, `source tree ${source} has no node_modules — run pnpm install there first; the dev child runs from your tree, deps included`);
  }
  note(`preflight ok — dev-flavor child, building ${source} sandbox-side`);

  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: source,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: execTimeoutMs,
  });
  if (timedOut(build)) {
    fail(EXIT.build, `the workspace build timed out after ${args.execTimeout}s — the child keeps running its previous dist/ until a rollout follows a successful build`);
  }
  if (build.error || build.status !== 0) {
    fail(EXIT.build, `workspace build exited ${build.status ?? String(build.error)} — the tree does not compile; the running pod is untouched`);
  }
  note('build ok — dist/ is live in the child through the mount');

  reloadAndProbe(base, args);
  note('reloaded — the child runs your tree and answered the probe');
}

async function main(): Promise<void> {
  const args = parseArgv(process.argv.slice(2));
  if (args.mode === 'reload') {
    runReload(args);
    return;
  }

  const { base, source } = preflight(args);
  note(`preflight ok — ${SYNC_DIRS.join('/ + ')}/ from ${source} → deploy/${DEPLOYMENT} ns ${NAMESPACE}`);

  const execTimeoutMs = args.execTimeout * 1000;
  const piped = await transfer(base, source, execTimeoutMs);
  if (piped.timedOut) {
    fail(EXIT.transfer, `the tree was still streaming after ${args.execTimeout}s — the transfer timed out and was cut off; ${PARTIAL}`);
  }
  if (piped.truncated) {
    fail(EXIT.transfer, `in-pod extraction ended (exit ${piped.kubectl ?? 'on a signal'}) while the tree was still streaming — ${PARTIAL}`);
  }
  if (piped.error || piped.tar !== 0) {
    fail(EXIT.transfer, `tree did not stream — tar exited ${piped.tar ?? String(piped.error)}`);
  }
  if (piped.kubectl !== 0) {
    fail(EXIT.transfer, `in-pod extraction exited ${piped.kubectl} — ${PARTIAL}`);
  }
  note(`transfer ok — extracted at ${DEST}`);

  const build = spawnSync(
    'kubectl',
    [...base, 'exec', '-n', NAMESPACE, `deploy/${DEPLOYMENT}`, '--', 'sh', '-c', `cd ${DEST} && exec pnpm run build`],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: execTimeoutMs },
  );
  if (timedOut(build)) {
    fail(EXIT.build, `the in-instance build timed out after ${args.execTimeout}s and was cut off — the synced tree is in place but unbuilt, and the pod keeps running its previous build until a rollout`);
  }
  if (build.error || build.status !== 0) {
    fail(EXIT.build, `in-instance build exited ${build.status ?? String(build.error)} — the synced tree does not compile; the running pod is untouched until the rollout`);
  }
  note('build ok');

  reloadAndProbe(base, args);
  note(`synced — the child runs your tree and answered the probe`);
}

// Bare invocation, not top-level await: the compiled artifact builds this
// tool with --bytecode, which rejects top-level await. A rejection here
// prints and exits 1 exactly as the awaited form did.
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
