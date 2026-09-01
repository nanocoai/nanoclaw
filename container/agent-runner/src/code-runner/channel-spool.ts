/**
 * The spool between the mailbox delivery loop and the channel server
 * (terminal-architecture phase 2: messaging over channels).
 *
 * The loop OWNS delivery — claims, acks, retries, the whole two-DB contract —
 * and the channel server is a dumb emitter: the loop drops one JSON file per
 * delivery here, the server watches, forwards it as a channel notification,
 * and unlinks. Files are the seam because the server is a separate process
 * claude spawns (an MCP subprocess), and a crash on either side must never
 * lose a delivery the contract thinks is in flight: an unemitted spool file
 * is re-emitted on the server's next scan; a claim that never acks is
 * released and re-spooled by the loop — duplicates-over-loss, exactly the
 * paste transport's trade.
 *
 * tmp+rename per file (house discipline): the watcher can never read a torn
 * spool entry. Names are zero-padded sequence numbers so emission order is
 * write order.
 */
import fs from 'fs';
import path from 'path';

export const CHANNEL_SPOOL_DIR = '/tmp/code-runner/channel-spool';

export interface SpoolEntry {
  /** The rendered mailbox text — the channel tag's body. */
  content: string;
  /** Identifier-keyed attributes for the channel tag (letters/digits/underscores only — other keys are silently dropped by the client). */
  meta: Record<string, string>;
}

let seq = 0;

/** Write one delivery to the spool. Returns the file path (tests read it). */
export function writeSpoolEntry(entry: SpoolEntry, dir: string = CHANNEL_SPOOL_DIR): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  seq += 1;
  const name = `${String(Date.now()).padStart(13, '0')}-${String(seq).padStart(6, '0')}.json`;
  const file = path.join(dir, name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, file);
  return file;
}

/** Spool entries in emission order (tmp files excluded). */
export function listSpoolEntries(dir: string = CHANNEL_SPOOL_DIR): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => path.join(dir, n));
}
