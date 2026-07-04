/**
 * Host-side provider container-config registry.
 *
 * Providers that need per-spawn host-side setup (extra volume mounts, env var
 * passthrough, per-session directories) register a function here. The
 * container-runner resolves the session's effective provider name, looks up
 * the registered config fn, and merges the returned mounts/env into the spawn
 * args.
 *
 * Providers without host-side needs (e.g. `claude`) don't appear in
 * this registry at all — the lookup returns `undefined` and the spawn path
 * proceeds with only the default mounts and env.
 *
 * Skills add a new provider's host config by creating `src/providers/<name>.ts`
 * with a top-level `registerProviderContainerConfig(...)` call, then appending
 * `import './<name>.js';` to `src/providers/index.ts` (the barrel).
 */

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ProviderContainerContext {
  /** Per-session host directory: `<DATA_DIR>/v2-sessions/<session_id>`. */
  sessionDir: string;
  /** Agent group ID, for any per-group logic. */
  agentGroupId: string;
  /**
   * Per-group host directory: `<GROUPS_DIR>/<folder>` (mounted RW at
   * `/workspace/agent`). Exists by the time the config fn runs — group
   * filesystem init happens first. Surfaces-providing providers compose
   * their project doc and skill links here.
   */
  groupDir: string;
  /**
   * Skill names selected by the group's container config, with `'all'`
   * already resolved against `container/skills/`. Surfaces-providing
   * providers use this to sync their own skill-discovery links.
   */
  selectedSkills: string[];
  /** `process.env` at spawn time — pull passthrough values from here. */
  hostEnv: NodeJS.ProcessEnv;
}

export interface ProviderContainerContribution {
  /** Extra volume mounts (merged with the default session/group/agent-runner mounts). */
  mounts?: VolumeMount[];
  /** Extra env vars to pass to the container (`-e KEY=VALUE`). */
  env?: Record<string, string>;
}

/**
 * Static capabilities a provider declares at registration time — knowable
 * without a spawn context, so any host path (group init, spawn, creation
 * flows) can consult them by name.
 */
export interface ProviderHostCapabilities {
  /**
   * Optional. When true, this provider owns its agent-facing surfaces — the
   * composed project doc, skill-discovery links, and provider state dir —
   * and the host must NOT compose or mount the default ones (composed
   * CLAUDE.md, `.claude-fragments`, `/app/CLAUDE.md`, `/home/node/.claude`,
   * `CLAUDE.local.md` seeding). The provider's config fn does its own
   * composing and returns its own mounts. Default off — providers that omit
   * this get the default surfaces, which is today's behavior.
   */
  readonly providesAgentSurfaces?: boolean;
}

export type ProviderContainerConfigFn = (ctx: ProviderContainerContext) => ProviderContainerContribution;

interface RegistryEntry {
  fn: ProviderContainerConfigFn;
  capabilities: ProviderHostCapabilities;
}

const registry = new Map<string, RegistryEntry>();

export function registerProviderContainerConfig(
  name: string,
  fn: ProviderContainerConfigFn,
  capabilities: ProviderHostCapabilities = {},
): void {
  if (registry.has(name)) {
    throw new Error(`Provider container config already registered: ${name}`);
  }
  registry.set(name, { fn, capabilities });
}

export function getProviderContainerConfig(name: string): ProviderContainerConfigFn | undefined {
  return registry.get(name)?.fn;
}

/**
 * Capability lookup by provider name. Unregistered providers (including the
 * baked-in default) report no capabilities — the host applies its default
 * surfaces, exactly as before this seam existed.
 */
export function providerProvidesAgentSurfaces(name: string | null | undefined): boolean {
  if (!name) return false;
  return registry.get(name)?.capabilities.providesAgentSurfaces === true;
}

export function listProviderContainerConfigNames(): string[] {
  return [...registry.keys()];
}
