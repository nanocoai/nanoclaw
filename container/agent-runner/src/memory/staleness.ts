/**
 * Tell a resumed turn when the memory it is holding has been rewritten.
 *
 * Memory is injected into context only when a provider opens a NEW context
 * window — startup, /clear, compaction (see session-hook.ts) — never on
 * `resume`. And a continuation outlives container kills, since it lives in
 * outbound.db on the host-mounted session dir that no kill path touches. So a
 * conversation can resume for days while another session, the operator, or
 * `ncl` rewrites the tree, and nothing in the conversation ever says so.
 *
 * Scope is exactly the two files `renderMemorySection` injects, because those
 * are the copy the conversation is carrying. A file it never loaded cannot be
 * stale in its context, so watching the whole tree would report changes that
 * are not stale to this conversation at all. Cost is therefore two stats, flat,
 * however large `memory/` grows. The gap: a leaf file the agent read earlier in
 * the conversation can be edited without either of these moving — the memory
 * contract asks that structural changes update the nearest index, which usually
 * surfaces it, but a pure content edit may not.
 *
 * Why a notice rather than an instruction: the definition already says to
 * re-read before answering, and adding the load time plus an explicit
 * `find -newermt` to the injected context, then again to the per-turn project
 * document, still left a real model answering from the stale copy in every
 * trial. Naming the changed file in the prompt being answered worked in every
 * trial. Recency is the mechanism.
 *
 * Nothing here throws: a notice is a nicety, never worth failing a turn over.
 */
import fs from 'fs';
import path from 'path';

const MARKER = '/workspace/.memory-loaded';

/** Relative to `<baseDir>/memory` — the files renderMemorySection loads. */
const INJECTED = ['index.md', path.join('system', 'definition.md')];

/** Stamp "the loaded memory is current as of now" for this session. */
export function markMemoryLoaded(marker = MARKER): void {
  try {
    fs.writeFileSync(marker, '');
  } catch {
    // No writable session dir (tests, odd mounts) — the check stays quiet.
  }
}

/**
 * Which injected memory files changed since the marker; empty when it cannot
 * tell. `baseDir` comes first because callers vary it (the poll loop passes the
 * session's cwd) while the marker path is fixed in practice.
 */
export function memoryChangedSince(baseDir = '/workspace/agent', marker = MARKER): string[] {
  const since = mtimeMs(marker);
  if (since === 0) return []; // Never loaded: nothing to compare against.
  return INJECTED.filter((file) => mtimeMs(path.join(baseDir, 'memory', file)) > since);
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
