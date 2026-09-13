/**
 * Strip Node.js process warnings from a spawned child's captured stderr.
 *
 * The stdin-json tests spawn the real CLI through the tsx loader and assert
 * the child's stderr exactly. Node versions newer than the CI matrix emit
 * loader deprecation warnings on that same stream (e.g. Node 25+ prints
 * `[DEP0205] DeprecationWarning` because tsx still uses module.register()),
 * which are environmental noise, not CLI output. Remove exactly those
 * warning lines — `(node:<pid>) …Warning: …` plus Node's follow-up
 * "(Use `node --trace-…`)" hint — so the assertions stay byte-exact on
 * everything the CLI itself writes.
 */
const NODE_WARNING_RE =
  /^\(node:\d+\) (?:\[\w+\] )?\w*Warning: .*(?:\r?\n|$)(?:\(Use `node --trace-\S+ \.\.\.` to show where the warning was created\)(?:\r?\n|$))?/gm;

export function stripNodeWarnings(stderr: string): string {
  return stderr.replace(NODE_WARNING_RE, '');
}
