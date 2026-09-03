/** A boundary observer runs at the provider-idle boundary of the poll loop, never mid-query.
 *  It returns true to hold admission. Observers MAY record that they observed the boundary
 *  (that is the point of the seam); they must be cheap and must not throw.
 *
 *  A gate that throws anyway is caught, reported once per gate per distinct message (the
 *  boundary runs every second — a repeated failure must not become a log flood) and treated
 *  as NOT holding, so one broken observer cannot wedge every container. */
export type AdmissionGate = () => boolean;

const gates: AdmissionGate[] = [];
const reported = new Map<AdmissionGate, Set<string>>();

export function registerAdmissionGate(gate: AdmissionGate): void {
  gates.push(gate);
}

/** Runs EVERY registered gate (no short-circuit) and returns whether any holds. */
export function evaluateAdmission(): boolean {
  let held = false;
  for (const gate of gates) {
    try {
      if (gate()) held = true;
    } catch (error) {
      const message = String(error);
      let seen = reported.get(gate);
      if (!seen) reported.set(gate, (seen = new Set()));
      if (!seen.has(message)) {
        seen.add(message);
        console.error(`[admission-gate] gate threw and is treated as not holding: ${message}`);
      }
    }
  }
  return held;
}

export function resetAdmissionGatesForTesting(): void {
  gates.length = 0;
  reported.clear();
}
