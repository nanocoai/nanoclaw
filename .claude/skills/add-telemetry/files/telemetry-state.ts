/**
 * Telemetry's slice of the session's persistent key/value state.
 *
 * WHY A FILE OF ITS OWN, rather than three more exports in `db/session-state.ts`.
 * Two of these functions are read only by `telemetry.ts`; the third
 * (`traceparentField`) only by the MCP server. None of them is session-state's
 * business, and inside an upstream file an upstream restructure lands in the
 * BODY of these helpers and merges textually clean while breaking at runtime.
 * Here it can only reach the `getAgentMailbox` import — which fails loudly at
 * compile time instead of returning NaN at runtime.
 *
 * IMPORTS THE MAILBOX, NEVER `telemetry.js`. `mcp-tools/core.ts` pulls
 * `traceparentField` from here, and that file runs in the MCP server — a separate
 * process (`StdioServerTransport`). Importing telemetry there would make that
 * process start an OTel exporter and install signal handlers it should not have.
 * The mailbox chain is free of telemetry; keep it that way.
 */
import { getAgentMailbox } from './mailbox/index.js';

/**
 * Long enough to outlive any turn, short enough that a stamp left behind by a
 * container killed mid-turn cannot attach a later send to it — see
 * `getTurnTraceparent`.
 */
const MAX_AGE_MS = 30 * 60 * 1000;

function getValue(key: string): string | undefined {
  return getAgentMailbox().operations.getState(key)?.value;
}

function setValue(key: string, value: string): void {
  getAgentMailbox().operations.setState(key, value);
}

function deleteValue(key: string): void {
  getAgentMailbox().operations.deleteState(key);
}

const TRACEPARENT_KEY = 'turn_traceparent';

/**
 * W3C trace context of the open turn, published by the runner and read by the MCP
 * server when sending to another agent — what stitches two agents into one trace.
 *
 * It travels through session state because the two live in different PROCESSES:
 * the MCP server cannot see the runner's open span. Same channel the reply route
 * already uses to cross this boundary.
 *
 * The age cap exists because a container killed by SIGKILL leaves the stamp
 * behind, and a late send must not attach itself to a turn that already died.
 */
export function setTurnTraceparent(traceparent: string | null): void {
  if (traceparent === null) {
    deleteValue(TRACEPARENT_KEY);
    return;
  }
  setValue(TRACEPARENT_KEY, traceparent);
}

export function getTurnTraceparent(): string | null {
  // `updatedAt`, not `updated_at`: the mailbox seam returns the field camel-cased.
  // The snake_case name yields NaN here, which `Number.isFinite` reads as
  // "expired" — every traceparent dropped, with no error anywhere.
  const row = getAgentMailbox().operations.getState(TRACEPARENT_KEY);
  if (!row) return null;
  const age = Date.now() - new Date(row.updatedAt).getTime();
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return null;
  return row.value;
}

/**
 * Trace context to travel inside an outgoing message, linking this agent's turn to
 * the turn it triggers in the recipient. With telemetry off it returns `{}` and
 * the message goes out unchanged.
 *
 * Returns an OBJECT TO SPREAD, never `{ traceparent: undefined }`: spreading `{}`
 * adds no key at all, so the message stays byte-identical to one sent with
 * telemetry off.
 * The undefined form would still change the object's shape for any consumer
 * testing `'traceparent' in content`.
 *
 * The host forwards unknown content keys untouched, so nothing host-side needs to
 * know this field exists.
 */
export function traceparentField(): { traceparent?: string } {
  try {
    const tp = getTurnTraceparent();
    return tp ? { traceparent: tp } : {};
  } catch {
    return {};
  }
}
