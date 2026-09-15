/**
 * Seam versions — how a registrar and the registry it plugs into agree on
 * the shape between them.
 *
 * Every registry under code mode exports an integer (`SANDBOX_HOOKS_SEAM`,
 * `SESSION_SURFACE_SEAM`, `RESOURCE_EXTENSION_SEAM`) and every registration
 * passes `{ seam }`. A mismatch is a refusal, never an overwrite and never
 * a crash: the registration is dropped, `log.error` says which one and why,
 * and the refusal is kept so operator surfaces (`ncl sandboxes list`) can
 * repeat it. The host still boots and everything else still works — a
 * module built against an older shape costs itself, not the install.
 *
 * Bumped only on a breaking change to the shape the registrar depends on.
 */
import { log } from './log.js';

export interface SeamRefusal {
  /** Which registry refused (`sandbox-hooks`, `session-surface`, `resource-extension`). */
  registry: string;
  /** What tried to register (a hook name, a channel type, a verb). */
  registrant: string;
  wanted: number;
  got: number | undefined;
}

const refusals: SeamRefusal[] = [];

/**
 * Check a registration's seam against the registry's. True when they agree;
 * otherwise the refusal is logged and recorded, and the caller must drop the
 * registration.
 */
export function seamAccepted(registry: string, registrant: string, wanted: number, got: number | undefined): boolean {
  if (got === wanted) return true;
  const refusal: SeamRefusal = { registry, registrant, wanted, got };
  refusals.push(refusal);
  log.error('Registration refused: seam version mismatch', {
    registry,
    registrant,
    expected: wanted,
    received: got,
  });
  return false;
}

/** Every refusal this process recorded, oldest first. */
export function seamRefusals(): readonly SeamRefusal[] {
  return [...refusals];
}

/** One line per refusal, for an operator surface. */
export function renderSeamRefusals(): string[] {
  return refusals.map(
    (r) =>
      `warning: ${r.registry} refused '${r.registrant}' — seam ${r.wanted} expected, ` +
      `${r.got === undefined ? 'none' : r.got} given (rebuild it against this host)`,
  );
}

/** Test seam. */
export function resetSeamRefusalsForTesting(): void {
  refusals.length = 0;
}
