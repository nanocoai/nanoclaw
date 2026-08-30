/**
 * D17 boundary vocabulary — the pure half of the detached boundary confirm.
 *
 * The boundary hook (boundary-hook.ts, claude's PreToolUse subprocess) and
 * its tests both import from HERE, never from the hook script: a hook script
 * executes main() on import, and importing one into a test process exits the
 * whole run (the mailbox-hook canary lesson, agent-state.ts header).
 *
 * Why a request/decision FILE PAIR under /workspace and not the mailbox: the
 * mailbox is a MESSAGE transport, owned by the agent-mailbox seam and freely
 * swappable under it (SQLite files, an object store) — a boundary confirm is
 * not mail, it is a blocking decision with exactly one writer per side, and
 * it must keep working whatever the deployment registered. The pair
 * keeps that discipline (request: hook writes, host reads; decision: host
 * writes, hook reads), is session-scoped, and is host-visible because
 * /workspace IS the session dir mount — nothing new crosses the wall.
 *
 * The two halves live in DIFFERENT dirs because they have different writers:
 * requests sit in the RW workspace (worst case a forged request raises a
 * spurious card — over-asking, the fail-safe direction), but the decision dir
 * is a host-owned nested RO mount, because "one writer per side" stated in a
 * comment is not enforcement. The E-t7 review demonstrated the enforcement
 * gap: with both halves under the RW mount, one backgrounded Bash loop
 * self-approved every boundary faster than the host's 5s scan could even see
 * the request. Now the kernel is the referee — see decisionsDirTrusted.
 */
import fs from 'fs';
import path from 'path';

/** In-container home of requests; host-side this is `<sessDir>/code-boundary`. */
export const BOUNDARY_DIR = '/workspace/code-boundary';

/**
 * In-container home of decisions — host-side `<sessDir>/code-boundary-decisions`,
 * nested-RO-mounted over the RW workspace (src/code-mode/permissions.ts
 * boundaryDecisionMounts — the container.json pattern). The RO bind is its own
 * mount, so the agent can neither write into it nor hardlink its inodes out
 * into the RW side (link(2) across mounts is EXDEV): a decision here was
 * written by the host or it does not exist.
 */
export const BOUNDARY_DECISIONS_DIR = '/workspace/code-boundary-decisions';

/**
 * The CLI's admin policy tier — the file the HOST stamps and RO-mounts
 * (src/code-mode/permissions.ts MANAGED_SETTINGS_CONTAINER_PATH; the two
 * constants cannot share code across the host/container wall, so each cites
 * the other). The hook reads the posture from HERE and never from its own
 * environment: env travels through the agent's Bash tool into any nested CLI
 * run, so an env-carried posture was agent-writable exactly where it mattered
 * (E-t7 review) — this file is not.
 */
export const MANAGED_SETTINGS_PATH = '/etc/claude-code/managed-settings.json';

/**
 * The posture, from the managed policy the host stamped. 'bypass' is the
 * composed escape-hatch policy byte-shape (defaultMode bypassPermissions);
 * any other readable policy is 'auto'; an absent or unreadable file is null —
 * not a code-mode container (chat mode never mounts the admin tier), or a
 * stamp the spawn lost, in which case the CLI runs with no managed allow
 * rules and asks MORE, not less.
 */
export function readPermissionPosture(file: string): 'bypass' | 'auto' | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      permissions?: { defaultMode?: unknown };
    };
    return raw.permissions?.defaultMode === 'bypassPermissions' ? 'bypass' : 'auto';
  } catch {
    return null;
  }
}

/**
 * How long the hook polls for a decision before denying on its own (D17:
 * timeout => deny). The host's expiry timer resolves deny at ~590s so the
 * hook normally reads an explicit decision; this ceiling is the belt. Both
 * sit under the hook's settings-entry timeout (settings-hooks.ts), which is
 * the CLI's last-resort kill.
 */
export const BOUNDARY_APPROVAL_TTL_MS = 600_000;

/** Decision-file poll cadence. */
export const BOUNDARY_POLL_MS = 500;

/**
 * The custody paths, as the agent's tools would name them. MIRRORS the
 * Edit/Write ask rules in the host's managed policy
 * (src/code-mode/permissions.ts BOUNDARY_ASK_RULES) — the two lists cannot
 * share code across the host/container wall, so each cites the other.
 */
export const CUSTODY_PATHS: readonly string[] = [
  '/workspace/code-mode-managed-settings.json',
  '/home/node/.claude/settings.json',
  '/workspace/group/CLAUDE.md',
];

/**
 * The custody paths as substrings of a SHELL COMMAND — the Bash channel the
 * static Edit/Write ask rules cannot see (E-t7 review: with bare 'Bash'
 * allowed, `echo '…' > /workspace/code-mode-managed-settings.json` rewrote
 * the managed policy through the shared inode without a single ask). Markers,
 * not a parser: any command that so much as NAMES a custody path asks —
 * reads included — because over-matching asks, the fail-safe direction. The
 * `.claude/settings.json` suffix covers the `~`, `$HOME`, and absolute
 * spellings in one stroke.
 *
 * This is a tripwire, not a wall. A command can reach a custody path without
 * naming it (globs, variables, a two-line script). The WALLS are the nested
 * RO mounts over the stamp, the decisions dir, and the group manual — the
 * kernel refuses those writes however the path is spelled. settings.json has
 * no wall (the in-container reconcile legitimately writes it,
 * settings-hooks.ts), so for it this tripwire plus the managed ask rules are
 * the whole gate; tampering there costs future hook registration but never
 * outranks the admin tier.
 */
export const CUSTODY_COMMAND_MARKERS: readonly string[] = [
  '/workspace/code-mode-managed-settings.json',
  'code-mode-managed-settings.json',
  '.claude/settings.json',
  '/workspace/group/CLAUDE.md',
];

/**
 * Substring-shaped on purpose: `cd x && ncl envs release y` is still a
 * release, and over-matching asks — the fail-safe direction. Pinned-lifetime
 * refinement stays impossible here for the same reason it is impossible in
 * the static rule: the argv carries only the env id. The same honesty about
 * the inverse: a release laundered through a file the command never names
 * (`bash r.sh`) walks past this classifier AND the static prefix rule — the
 * durable gate for releases is host-side enforcement on the release
 * operation itself, and until that lands this is a tripwire (E-t7 review).
 */
const RELEASE_RE = /\bncl\s+envs\s+release\b/;

/**
 * Classify a PreToolUse payload against the D17 boundaries. Returns a
 * human-readable reason when the call crosses one, null when it is ordinary
 * inside-the-sandbox work the hook must not touch.
 */
export function classifyBoundary(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (RELEASE_RE.test(command)) return 'dev-env release';
    const marker = CUSTODY_COMMAND_MARKERS.find((m) => command.includes(m));
    if (marker) return `custody-adjacent command: ${marker}`;
    return null;
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    const file = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
    if (file && CUSTODY_PATHS.includes(path.normalize(file))) return `custody-adjacent write: ${file}`;
    return null;
  }
  return null;
}

export interface BoundaryRequest {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;
  /** ISO timestamp of the hook's stamp — the host measures its expiry from it. */
  at: string;
}

export interface BoundaryDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

export function requestPath(dir: string, id: string): string {
  return path.join(dir, `${id}.request.json`);
}

export function decisionPath(dir: string, id: string): string {
  return path.join(dir, `${id}.decision.json`);
}

/**
 * A decision dir is trusted only when the KERNEL refuses our writes with
 * EROFS — the one error the agent cannot manufacture from inside the RW
 * workspace (a chmod-555 dir of its own making fails with EACCES, a missing
 * dir with ENOENT, and its own dir accepts the write). The hook and the
 * agent share a uid, so "can this process write here" is exactly "can the
 * agent forge here"; if the probe lands, the RO mount is absent and the
 * whole detached confirm must deny rather than poll a forgeable path.
 */
export function decisionsDirTrusted(dir: string): boolean {
  const probe = path.join(dir, `.trust-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EROFS';
  }
  try {
    fs.rmSync(probe, { force: true });
  } catch {
    // Litter in an untrusted dir changes nothing about the deny below.
  }
  return false;
}

/** tmp+rename like every state file here — the host must never parse a torn request. */
export function writeBoundaryRequest(dir: string, request: BoundaryRequest): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = requestPath(dir, request.id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(request));
  fs.renameSync(tmp, file);
}

/**
 * Fail closed on everything: a missing, torn, or creatively-shaped decision
 * file reads as null (keep polling), and only the exact string 'allow'
 * allows — any other present decision is a deny.
 */
export function readBoundaryDecision(file: string): BoundaryDecision | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { decision?: unknown; reason?: unknown };
    if (raw.decision !== 'allow' && raw.decision !== 'deny') return null;
    return { decision: raw.decision, reason: typeof raw.reason === 'string' ? raw.reason : undefined };
  } catch {
    return null;
  }
}

/**
 * Poll for the host's decision until the TTL. Timeout => deny (D17). The
 * clock and sleeper are injectable so tests run in milliseconds.
 */
export async function waitForDecision(
  file: string,
  opts: { ttlMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<BoundaryDecision> {
  const ttlMs = opts.ttlMs ?? BOUNDARY_APPROVAL_TTL_MS;
  const pollMs = opts.pollMs ?? BOUNDARY_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + ttlMs;
  for (;;) {
    const decision = readBoundaryDecision(file);
    if (decision) return decision;
    if (now() >= deadline) return { decision: 'deny', reason: `no approval within ${ttlMs}ms` };
    await sleep(pollMs);
  }
}
