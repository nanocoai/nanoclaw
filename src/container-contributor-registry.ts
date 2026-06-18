/**
 * Host-side container-contributor registry (ADR 0006 contract #2).
 *
 * An install-overlay (e.g. /add-taskflow) that needs to add per-spawn host-side
 * container setup — extra volume mounts, extra `-e KEY=VALUE` env passthrough —
 * registers a contributor here instead of editing `container-runner.ts` inline.
 * The container-runner calls `collectContainerContributions(ctx)` while building
 * the spawn args and merges the returned mounts/env.
 *
 * Core ships with an EMPTY registry: `collectContainerContributions` returns
 * `{ mounts: [], env: {} }`, so pristine core spawns containers with only the
 * default session/group/agent-runner mounts and host-critical env. An overlay
 * adds a contributor by creating its module with a top-level
 * `registerContainerContributor(...)` call and appending `import './<mod>.js';`
 * to its module barrel.
 *
 * Security invariants enforced by `collectContainerContributions` (NOT by
 * contributors — a contributor is fork code but is treated as untrusted by the
 * core merge so a future buggy/hostile contributor can't punch through a SEC
 * guard):
 *
 *   - RESERVED containerPaths (SEC#8 / #414): a contributor MUST NOT mount onto
 *     `/workspace` or `/workspace/inbound.db`. `/workspace` is the RW session
 *     dir (a remount could change its readonly bit); `/workspace/inbound.db` is
 *     the host-written, container-read message channel pinned read-only inline
 *     in container-runner (#414) — a contributor remounting it RW would let a
 *     forged messages_in row self-approve a gated action. Reserved mounts are
 *     DROPPED (logged), they do not abort the spawn.
 *   - RESERVED env keys: a contributor MUST NOT set a host-critical env var
 *     (`TZ`, or any `NANOCLAW_ONECLI_*` / OneCLI gateway var the runner owns).
 *     Reserved env keys are DROPPED (logged). Provider env and host-critical env
 *     are applied by container-runner AFTER contributor env, so they always win
 *     regardless; this guard is defense-in-depth on top of that ordering.
 *
 * Contributors run in registration order; if two contributors emit the same
 * (non-reserved) containerPath or env key, the LATER one wins and a warning is
 * logged — overlays should not collide, so a collision is a packaging bug.
 */
import { log } from './log.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

export interface ContainerContributorContext {
  /** Per-session host directory: `<DATA_DIR>/v2-sessions/<agent_group_id>/<session_id>`. */
  sessionDir: string;
  /** `DATA_DIR` — root for host-owned shared DBs (taskflow, embeddings). */
  dataDir: string;
  /** Agent group folder (e.g. `thiago-taskflow`) — used for board-id / holiday resolution. */
  agentGroupFolder: string;
  /** Agent group id. */
  agentGroupId: string;
  /** `process.env` at spawn time — contributors read passthrough values from here. */
  hostEnv: NodeJS.ProcessEnv;
}

export interface ContainerContribution {
  /** Extra volume mounts (merged after the default mounts). */
  mounts?: VolumeMount[];
  /** Extra env vars to pass to the container (`-e KEY=VALUE`). */
  env?: Record<string, string>;
}

export type ContainerContributorFn = (ctx: ContainerContributorContext) => ContainerContribution;

/** containerPaths a contributor may never mount onto. See module doc (SEC#8 / #414). */
const RESERVED_CONTAINER_PATHS = new Set<string>(['/workspace', '/workspace/inbound.db']);

/** env keys a contributor may never set. Host-critical / runner-owned. */
function isReservedEnvKey(key: string): boolean {
  return key === 'TZ' || key.startsWith('NANOCLAW_ONECLI_');
}

const contributors: Array<{ name: string; fn: ContainerContributorFn }> = [];

export function registerContainerContributor(name: string, fn: ContainerContributorFn): void {
  if (contributors.some((c) => c.name === name)) {
    throw new Error(`Container contributor already registered: ${name}`);
  }
  contributors.push({ name, fn });
}

/**
 * Run every registered contributor and merge their mounts/env, enforcing the
 * reserved-path / reserved-env-key guards. Returns `{ mounts: [], env: {} }`
 * when no contributor is registered (pristine core).
 */
export function collectContainerContributions(ctx: ContainerContributorContext): {
  mounts: VolumeMount[];
  env: Record<string, string>;
} {
  const mounts: VolumeMount[] = [];
  const seenPaths = new Set<string>();
  const env: Record<string, string> = {};

  for (const { name, fn } of contributors) {
    const contribution = fn(ctx);
    for (const mount of contribution.mounts ?? []) {
      if (RESERVED_CONTAINER_PATHS.has(mount.containerPath)) {
        log.warn('Container contributor mount dropped: reserved containerPath', {
          contributor: name,
          containerPath: mount.containerPath,
        });
        continue;
      }
      if (seenPaths.has(mount.containerPath)) {
        log.warn('Container contributor mount overrides an earlier contributor', {
          contributor: name,
          containerPath: mount.containerPath,
        });
        const idx = mounts.findIndex((m) => m.containerPath === mount.containerPath);
        if (idx >= 0) mounts.splice(idx, 1);
      }
      seenPaths.add(mount.containerPath);
      mounts.push(mount);
    }
    for (const [key, value] of Object.entries(contribution.env ?? {})) {
      if (isReservedEnvKey(key)) {
        log.warn('Container contributor env dropped: reserved key', { contributor: name, key });
        continue;
      }
      if (key in env) {
        log.warn('Container contributor env overrides an earlier contributor', { contributor: name, key });
      }
      env[key] = value;
    }
  }

  return { mounts, env };
}
