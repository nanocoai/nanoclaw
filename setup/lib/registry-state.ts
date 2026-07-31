/**
 * Reader/writer for agent-image source state — and, on the gated path, for who
 * this install is to the registry.
 *
 * Intent and reality are two separate reads, because a pulled image is retagged
 * onto the same local tag a build writes — so `.env` can claim "hardened" while
 * a fallback build actually ran. Never treat intent as evidence:
 *
 *   readImageSource()    — what the operator asked for (`.env`)
 *   inspectAgentImage()  — what the local tag resolves to (docker)
 *
 * `setup/container.ts` and `container/build.sh` still parse the key themselves
 * (the former can't import from `setup/lib` on a standalone `--step container`
 * run; the latter is bash). All readers compare trimmed + lower-cased against
 * `true` — keep it that way.
 *
 * The account half (credential file, broker URL, docker `credHelpers` pointer)
 * lives here for the same reason the image half does: the login flow, the
 * `registry` step and uninstall all touch it, and three private copies of
 * "where is the token" is how they end up disagreeing.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../../src/env.js';
import { getDefaultContainerImage } from '../../src/install-slug.js';
import { upsertEnvVar } from '../set-env.js';
import { readVersionPinValue } from './version-pins.js';

/** `.env` key carrying the opt-in. Read by setup and by `container/build.sh`. */
export const HARDENED_IMAGE_ENV_KEY = 'NANOCLAW_HARDENED_IMAGE';

/**
 * `versions.json` key holding the full pullable reference, digest included.
 * One key rather than a repo/digest pair so the halves cannot drift apart.
 *
 * Two shapes. A single string is the normal one and covers both a multi-arch
 * index digest — which docker resolves to the running platform by itself, so
 * nothing here has to think about architecture — and a single-architecture
 * digest from a publisher that ships only one. An object keyed by docker
 * platform string is for a publisher that ships per-architecture references
 * instead of one index:
 *
 *   "agent-image": "repo@sha256:…"
 *   "agent-image": { "linux/amd64": "repo@sha256:…", "linux/arm64": "repo@sha256:…" }
 */
export const AGENT_IMAGE_PIN = 'agent-image';

/**
 * Per-machine override of that reference, so an operator can point at their own
 * registry without editing a committed file. `container/pull.sh` reads it too.
 */
export const AGENT_IMAGE_REF_ENV_KEY = 'NANOCLAW_AGENT_IMAGE_REF';

/**
 * Provenance label. Only a build can set it, so it travels with the bytes and
 * survives the retag that erases every other difference.
 */
export const IMAGE_SOURCE_LABEL = 'dev.nanoclaw.image-source';

/** What the operator asked for. */
export type ImageSource = 'local' | 'hardened';

/**
 * What the tag on this machine actually is. `missing` means docker answered
 * and has no such image; `unknown` means we could not ask it at all.
 */
export type ActualImageSource = ImageSource | 'derived' | 'missing' | 'unknown';

/** Caller's env wins, then `.env`. The one place this key is parsed in TS. */
function rawImageSourceSetting(): string | undefined {
  const env = readEnvFile([HARDENED_IMAGE_ENV_KEY]);
  return process.env[HARDENED_IMAGE_ENV_KEY] || env[HARDENED_IMAGE_ENV_KEY];
}

/**
 * Fresh read every call: setup writes this key and reads it back in one run.
 *
 * Deliberately not exported from `src/config.ts`. The host never needs it — the
 * pull retags onto the local slug tag, so nothing in `src/` learns a registry
 * exists. If this key ever has to reach the host process, that invariant broke.
 */
export function readImageSource(): ImageSource {
  return rawImageSourceSetting()?.trim().toLowerCase() === 'true' ? 'hardened' : 'local';
}

/**
 * Whether anyone has answered the question yet — an absent key and an explicit
 * `false` both read as `local` from `readImageSource`, and setup has to tell
 * them apart: the first means "ask", the second means "they said no, don't ask
 * again". That distinction is what makes a resumed run stop re-prompting, so
 * `writeImageSource` writes `false` rather than deleting the line.
 */
export function imageSourceDecided(): boolean {
  return (rawImageSourceSetting() ?? '').trim() !== '';
}

/**
 * Opting out writes `false` rather than deleting the line — an explicit "no"
 * is visible in `.env` and survives a resumed setup; an absent key isn't.
 */
export function writeImageSource(source: ImageSource): void {
  upsertEnvVar(HARDENED_IMAGE_ENV_KEY, source === 'hardened' ? 'true' : 'false');
}

/**
 * The image reference this install pulls, or undefined when unpinned.
 *
 * Precedence mirrors `container/pull.sh` — env, then `.env`, then the
 * `versions.json` pin — so verify reports what actually got pulled.
 *
 * Soft where the read throws: "no pin" is the normal permanent state of
 * every local-build install. On the hardened path treat `undefined` as "not
 * configured to pull" and say so; never as a reason to fall back quietly.
 */
export function readAgentImagePin(): string | undefined {
  const env = readEnvFile([AGENT_IMAGE_REF_ENV_KEY]);
  const override = process.env[AGENT_IMAGE_REF_ENV_KEY]?.trim() || env[AGENT_IMAGE_REF_ENV_KEY];
  if (override) return override;
  try {
    const pin = readVersionPinValue(AGENT_IMAGE_PIN);
    // Only the object shape needs to know the platform, and asking costs a
    // docker spawn — so don't ask on the single-reference path, which is both
    // the common one and the one that works before docker is even installed.
    if (typeof pin === 'string') return pin.trim() || undefined;
    return resolvePinForPlatform(pin, dockerPlatform());
  } catch {
    return undefined;
  }
}

/**
 * Pick one platform's reference out of whatever shape the pin has. A string
 * pin is returned as-is for every platform: resolving a multi-arch index is
 * docker's job, and second-guessing it here is how you end up pulling the
 * wrong child.
 *
 * Exported for tests — callers want `readAgentImagePin`.
 */
export function resolvePinForPlatform(pin: unknown, platform: string): string | undefined {
  if (typeof pin === 'string') return pin.trim() || undefined;
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return undefined;
  const value = (pin as Record<string, unknown>)[platform];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Platforms an object-shaped pin declares. Empty for a single reference. */
export function pinnedPlatforms(pin: unknown): string[] {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return [];
  return Object.entries(pin as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k]) => k)
    .sort();
}

/**
 * Set when the file pins something but nothing for this machine — the one case
 * where "no pin" would otherwise be reported as "this install doesn't pull",
 * which is a materially different and wrong answer.
 */
export function unsupportedPlatformPin(): { platform: string; available: string[] } | undefined {
  try {
    const pin = readVersionPinValue(AGENT_IMAGE_PIN);
    const available = pinnedPlatforms(pin);
    if (available.length === 0) return undefined;
    const platform = dockerPlatform();
    return resolvePinForPlatform(pin, platform) ? undefined : { platform, available };
  } catch {
    return undefined;
  }
}

/**
 * Docker's platform string for the daemon that will run the pull.
 *
 * The *daemon's* architecture, not this process's: with Docker Desktop, a
 * remote daemon or a cross-architecture context, the machine running node is
 * not the machine running the container. `container/pull.sh` resolves it the
 * same way for the same reason — if these two disagree, `--status` compares
 * against a pin the pull never used.
 */
let cachedPlatform: string | undefined;
export function dockerPlatform(): string {
  if (cachedPlatform) return cachedPlatform;
  const res = spawnSync('docker', ['version', '--format', '{{.Server.Arch}}'], {
    encoding: 'utf-8',
  });
  const fromDaemon = res.status === 0 ? res.stdout.trim() : '';
  cachedPlatform = `linux/${fromDaemon || nodeArchToDocker(process.arch)}`;
  return cachedPlatform;
}

/** Node's architecture names are not docker's. */
function nodeArchToDocker(arch: string): string {
  return arch === 'x64' ? 'amd64' : arch;
}

/** The `sha256:…` half of the pin. Undefined when unpinned or not a digest ref. */
export function readAgentImageDigest(): string | undefined {
  return splitDigest(readAgentImagePin());
}

/**
 * The registry host the pin points at — the `credHelpers` key docker looks up
 * when it pulls, and the only host this install's helper should ever answer for.
 *
 * Derived from the pin rather than configured separately so the pointer cannot
 * outlive the reference that justified it. Docker's own rule for telling a
 * registry host from a Docker Hub namespace: the first segment counts as a host
 * only if it has a dot, a port, or is `localhost`.
 */
export function readRegistryHost(): string | undefined {
  const ref = readAgentImagePin();
  if (!ref || !ref.includes('/')) return undefined;
  const first = ref.slice(0, ref.indexOf('/'));
  return first.includes('.') || first.includes(':') || first === 'localhost'
    ? first
    : undefined;
}

export interface AgentImageInspection {
  /** The local tag inspected — `nanoclaw-agent-v2-<slug>:latest`. */
  ref: string;
  /** Local image ID (`sha256:…` over the config blob). Absent when not present. */
  id?: string;
  /**
   * Registry manifest digest — set only for an image that arrived over the
   * wire. A `docker build` never produces one. This is the value to compare
   * against `readAgentImageDigest()`.
   */
  registryDigest?: string;
  labels: Record<string, string>;
  source: ActualImageSource;
}

/**
 * What the slug tag actually resolves to. `missing` means docker ran and said
 * no; `unknown` means we couldn't ask. A merely-stopped daemon also exits
 * non-zero, so confirm reachability first if the distinction has to be trusted.
 */
export function inspectAgentImage(projectRoot: string = process.cwd()): AgentImageInspection {
  const ref = getDefaultContainerImage(projectRoot);
  const res = spawnSync('docker', ['image', 'inspect', ref], { encoding: 'utf-8' });

  if (res.error) return { ref, labels: {}, source: 'unknown' };
  if (res.status !== 0) return { ref, labels: {}, source: 'missing' };

  let entry: DockerInspectEntry | undefined;
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    entry = Array.isArray(parsed) ? (parsed[0] as DockerInspectEntry | undefined) : undefined;
  } catch {
    // Docker answered with something we can't read. Refusing to guess is the
    // point of this function, so don't downgrade it to "local".
    return { ref, labels: {}, source: 'unknown' };
  }
  if (!entry) return { ref, labels: {}, source: 'unknown' };

  // `Config.Labels` is null, not absent, on an image with no labels.
  const labels = entry.Config?.Labels ?? {};
  // Match the repository we expect rather than taking [0]: the same bytes pushed
  // to two repositories produce two RepoDigests, and the first is often the wrong
  // one to report back to an operator.
  const digests = entry.RepoDigests ?? [];
  const pinnedRepo = readAgentImagePin()?.split('@')[0];
  const preferred = pinnedRepo ? digests.find((d) => d.startsWith(`${pinnedRepo}@`)) : undefined;
  const registryDigest = splitDigest(preferred ?? digests[0]);

  return { ref, id: entry.Id, registryDigest, labels, source: resolveActualSource(labels, registryDigest) };
}

/** The subset of `docker image inspect` output this module reads. */
interface DockerInspectEntry {
  Id?: string;
  RepoDigests?: string[];
  Config?: { Labels?: Record<string, string> | null };
}

/**
 * Label first — it's baked in and neither the pull nor the retag can forge it.
 * `RepoDigests` is the fallback for images predating the label: `docker build`
 * leaves it empty, a registry populates it. Only a fallback because a
 * `docker save`/`load` sneakernet image has none and would read as local.
 */
function resolveActualSource(
  labels: Record<string, string>,
  registryDigest: string | undefined,
): ActualImageSource {
  const declared = labels[IMAGE_SOURCE_LABEL];
  // `derived` is a per-group image built on top of one of the other two. It has
  // to be its own answer: it inherits the base's RepoDigest-derived provenance
  // and would otherwise read as the base's bytes, which it no longer is.
  if (declared === 'hardened' || declared === 'local' || declared === 'derived') return declared;
  return registryDigest ? 'hardened' : 'local';
}

/**
 * `repo@sha256:…` → `sha256:…`. Undefined for a bare tag. Takes the first when
 * an image carries several — they address identical content.
 */
function splitDigest(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const at = ref.lastIndexOf('@');
  return at === -1 ? undefined : ref.slice(at + 1);
}

// ─── account state ─────────────────────────────────────────────────────
//
// Only reached on the gated path: a local-build install never signs in, never
// writes a credential, and never gets a `credHelpers` entry.
//
// The *write* side lives elsewhere on purpose — `setup/registry-login.ts` owns
// the credential files (it is a standalone driver spawned under inherited
// stdio) and `setup/install-cred-helper.ts` owns the docker pointer (it also
// installs the binary the pointer names). This is the read side those two
// share with the `registry` step, so "am I signed in" has one answer.

/** The sign-in entry point, run through `runInheritScript` (it needs a TTY). */
export const REGISTRY_LOGIN_SCRIPT = 'setup/registry-login.sh';

/**
 * Whether this checkout can run the sign-in at all. The caller has to know
 * before spawning it: the script arrives with the gated path, so a checkout
 * that predates it fails as an opaque `bash: … No such file` and exit 127,
 * which reads exactly like a user who abandoned the device flow.
 */
export function loginScriptAvailable(projectRoot: string = process.cwd()): boolean {
  return fs.existsSync(path.join(projectRoot, REGISTRY_LOGIN_SCRIPT));
}

/**
 * Broker base URL override.
 */
export const BROKER_URL_ENV_KEY = 'NANOCLAW_REGISTRY_API';

/**
 * The deployed account service, and the single definition of it —
 * `setup/registry-login.ts` imports this rather than keeping its own copy,
 * because two constants that must agree eventually will not.
 *
 * This and the `agent-image` pin in versions.json name two halves of one
 * deployment and have to move together: the docker credential helper is wired
 * to the host derived from the *pin*, while the credential it presents is
 * minted by *this* service. Point them at different deployments and the
 * mismatch surfaces as an authentication failure at pull time, long after the
 * thing that caused it.
 *
 * Getting this wrong fails quietly rather than loudly, which is why it is a
 * constant rather than a setting. Any other deployment of the same service
 * answers every route identically, so a default aimed at the wrong one still
 * signs people in, still issues tokens, and still looks like success — it just
 * records the accounts somewhere nobody is looking, against an identity
 * provider nobody meant to use. Override it per-install with
 * `NANOCLAW_REGISTRY_API`; a fork pointing at its own service should change it
 * here, alongside the pin.
 */
export const DEFAULT_BROKER_URL = 'https://registry.nanoclaw.dev';

/**
 * `account.json` as the sign-in writes it. Everything is optional except the
 * token, because a credential from an older login is still a credential and
 * reporting "signed in, details unknown" beats reporting "not signed in".
 */
export interface RegistryAccount {
  version?: number;
  /** Broker this token is valid against; a token is meaningless without it. */
  api?: string;
  account_id?: string;
  email?: string;
  /** Opaque bearer. Never printed, never logged, never sent to a partner. */
  token: string;
  /** Registry hostname the token is good for, once the broker has named one. */
  registry?: string;
  entitlements?: string[];
  created_at?: string;
}

/** Per-user, not per-checkout: uninstalling one copy must not sign out another. */
function configDir(): string {
  return path.join(os.homedir(), '.config', 'nanoclaw');
}

/** The account record — what a human and `--status` read. */
export function registryAccountPath(): string {
  return path.join(configDir(), 'account.json');
}

/** The credential helper's minimal view of the same token. */
export function registryAuthPath(): string {
  return path.join(configDir(), 'registry-auth.json');
}

/**
 * The signed-in account, or undefined when there is none. A malformed or
 * truncated file reads as "not signed in" rather than throwing — the next move
 * (sign in again) is the same either way.
 */
export function readRegistryAccount(): RegistryAccount | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registryAccountPath(), 'utf-8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const account = parsed as RegistryAccount;
  return typeof account.token === 'string' && account.token ? account : undefined;
}

/**
 * Remove both halves of the credential, returning the paths that existed.
 *
 * Both, always: leaving `registry-auth.json` behind would keep a live token on
 * disk for the credential helper to hand out, which is the exact thing signing
 * out is for.
 */
export function clearRegistryAccount(): string[] {
  const removed: string[] = [];
  for (const file of [registryAccountPath(), registryAuthPath()]) {
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    removed.push(file);
  }
  return removed;
}

/**
 * Where to reach the broker.
 *
 * The credential's own `api` outranks the compiled-in default because a token
 * is only revocable at the broker that minted it — falling back to the default
 * would silently no-op a logout against a staging deployment. An explicit env
 * override still wins, so pointing elsewhere is possible but deliberate.
 */
export function readBrokerUrl(account?: RegistryAccount): string {
  const env = readEnvFile([BROKER_URL_ENV_KEY]);
  const override = process.env[BROKER_URL_ENV_KEY]?.trim() || env[BROKER_URL_ENV_KEY];
  const url = override || account?.api || DEFAULT_BROKER_URL;
  return url.replace(/\/+$/, '');
}
