/**
 * PreCompact capture seam — INERT by default.
 *
 * When the provider's SDK auto-compacts a session it first archives the transcript. An
 * install-overlay may want to do MORE with that same transcript — e.g. distil durable facts
 * into a memory store. This seam is the post-archive extension point: the provider
 * passes the already-parsed transcript messages + session id to every registered capture.
 *
 * Best-effort by contract: `applyPreCompactCapture` swallows a capture's failure so a
 * slow/broken extraction can NEVER break compaction. A capture may also declare a `timeoutSec`
 * it needs; the provider widens the SDK PreCompact hook timeout to the max across registrants
 * (`preCompactCaptureTimeoutSec`) so the capture's own abort fires first and it writes cleanly.
 *
 * With no registrant `preCompactCaptureTimeoutSec()` is undefined (the SDK default hook timeout
 * applies) and `applyPreCompactCapture` is a no-op, so default behaviour is identical to
 * upstream (archive only).
 */
export interface PreCompactCaptureMessage {
  readonly role: string;
  readonly content: string;
}

export interface PreCompactCaptureContext {
  /** The transcript messages already parsed for archiving (shared — not re-read). */
  readonly messages: readonly PreCompactCaptureMessage[];
  /** The compacting session's id (or 'unknown' if the SDK didn't supply one). */
  readonly sessionId: string;
}

export interface PreCompactCapture {
  /** Run after the transcript is archived. MUST be best-effort — a throw is caught + logged. */
  capture(ctx: PreCompactCaptureContext): Promise<void>;
  /** Optional SDK hook timeout (seconds) this capture needs so the SDK won't kill it mid-write. */
  readonly timeoutSec?: number;
}

const captures: PreCompactCapture[] = [];

export function registerPreCompactCapture(capture: PreCompactCapture): void {
  captures.push(capture);
}

/**
 * Run every registered capture over the archived transcript. Best-effort: each capture's
 * failure is isolated (caught + logged) so one cannot break compaction or starve another.
 * No registrant ⇒ no-op.
 */
export async function applyPreCompactCapture(ctx: PreCompactCaptureContext): Promise<void> {
  for (const c of captures) {
    try {
      await c.capture(ctx);
    } catch (err) {
      console.error(`[precompact-capture] capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * SDK PreCompact hook timeout (seconds) = the MAX timeout any registered capture declares, or
 * undefined when none declare one (⇒ the SDK's default applies, matching upstream). Max so a
 * slower capture's budget governs and no registrant's write is cut short.
 */
export function preCompactCaptureTimeoutSec(): number | undefined {
  const declared = captures.map((c) => c.timeoutSec).filter((t): t is number => typeof t === 'number');
  return declared.length > 0 ? Math.max(...declared) : undefined;
}

/** Test-only: reset registered captures. */
export function __resetPreCompactCaptureForTest(): void {
  captures.length = 0;
}
