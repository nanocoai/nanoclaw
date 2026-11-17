/**
 * Current WhatsApp Web version for the whatsapp-auth step. The version bundled
 * in Baileys goes stale and WhatsApp then rejects it (405) before a QR or
 * pairing code appears, so this never falls back to it.
 */

export type WaWebVersion = [number, number, number];

/** Baileys' `fetchLatestWaWebVersion`: on failure it resolves with its bundled version and `isLatest: false`. */
export type SwJsLookup = (init: { signal: AbortSignal }) => Promise<{ version: WaWebVersion; isLatest: boolean }>;

const TRACKER_URL = 'https://wppconnect.io/whatsapp-versions/';
const LOOKUP_TIMEOUT_MS = 5000;

/** wppconnect's tracker first (web.whatsapp.com rate-limits sw.js with 429s), then sw.js, then a clear error. */
export async function resolveWaWebVersion(lookupSwJs: SwJsLookup): Promise<WaWebVersion> {
  try {
    const res = await fetch(TRACKER_URL, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    // The page lists the current version first, possibly with a suffix such as -alpha.
    const match = res.ok ? (await res.text()).match(/2\.3000\.(\d+)/) : null;
    if (match) return [2, 3000, Number(match[1])];
  } catch {
    // Unreachable or timed out: try sw.js.
  }

  const { version, isLatest } = await lookupSwJs({ signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (isLatest) return version;

  throw new Error(
    'Could not fetch current WhatsApp Web version. Check that this machine can reach wppconnect.io and web.whatsapp.com, then run the step again in a few minutes.',
  );
}
