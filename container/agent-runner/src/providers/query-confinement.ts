/**
 * Per-turn query-confinement seam — INERT by default, fail-CLOSED.
 *
 * Some turns are driven by an authenticated EXTERNAL participant (not a local
 * participant). Such a turn must run CONFINED: NO built-in fs/bash tools (Read / Bash /
 * Glob / Grep / Write / Edit … are not gated by the nanoclaw MCP gate, so they would
 * be an unguarded exfiltration path over workspace-private files), NO extra
 * `additionalDirectories`, and ONLY the nanoclaw MCP server visible (the MCP gate
 * then narrows it to an external-safe whitelist).
 *
 * Unlike the install-static ProviderToolPolicy seam (which expresses install-WIDE
 * tightening), confinement is a PER-TURN decision: the caller flags the turn with
 * `query({ confinedExternal: true })`. A registrant supplies HOW to confine — given a
 * turn's normal-mode surface it returns a tightened one. Composition is monotonically
 * restrictive: each registrant receives the prior's output, so the surface can only
 * narrow, never widen.
 *
 * FAIL-CLOSED: a turn flagged confined when NO registrant is present is REFUSED
 * (`applyQueryConfinement` throws) — the provider must never silently run an external
 * turn unconfined. The provider derives its `supportsConfinedExternal` capability from
 * `isQueryConfinementRegistered()`, so a caller that checks the capability first (the
 * intended path) fails closed and skips the turn before it ever reaches the throw; the
 * throw is the last-resort backstop for a caller that doesn't.
 *
 * With no registrant `isQueryConfinementRegistered()` is false and the seam is never
 * invoked, so default behaviour is identical to upstream (which has no confined
 * mode).
 */
export interface QueryConfinementSurface {
  /** SDK `allowedTools` for the turn. */
  readonly allowedTools: readonly string[];
  /** Names of the MCP servers visible this turn (after any tool-policy hide). */
  readonly visibleMcpServerNames: readonly string[];
  /** Board `additionalDirectories` the turn would otherwise see. */
  readonly additionalDirectories: readonly string[];
}

export interface QueryConfinement {
  /**
   * Tighten a turn's tool / MCP / dir surface for confined-external execution. MUST
   * return SUBSETS of the input — the seam is monotonically restrictive.
   */
  confine(surface: QueryConfinementSurface): QueryConfinementSurface;
}

const confinements: QueryConfinement[] = [];

export function registerQueryConfinement(confinement: QueryConfinement): void {
  confinements.push(confinement);
}

/**
 * True iff at least one confinement is registered. Drives the provider's
 * `supportsConfinedExternal` capability so it stays HONEST: the provider can confine a
 * turn iff an overlay taught it how.
 */
export function isQueryConfinementRegistered(): boolean {
  return confinements.length > 0;
}

/**
 * Apply every registered confinement, in registration order, to a turn's normal-mode
 * surface. FAIL-CLOSED: throws if NO confinement is registered (refusing to run a
 * flagged-confined turn unconfined).
 */
export function applyQueryConfinement(surface: QueryConfinementSurface): QueryConfinementSurface {
  if (confinements.length === 0) {
    throw new Error(
      'confined-external turn requested but no QueryConfinement is registered — refusing to run unconfined',
    );
  }
  return confinements.reduce<QueryConfinementSurface>((acc, c) => c.confine(acc), {
    allowedTools: [...surface.allowedTools],
    visibleMcpServerNames: [...surface.visibleMcpServerNames],
    additionalDirectories: [...surface.additionalDirectories],
  });
}

/** Test-only: reset registered confinements. */
export function __resetQueryConfinementForTest(): void {
  confinements.length = 0;
}
