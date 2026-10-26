/**
 * Crash reporting for the agent-runner process.
 *
 * Without handlers, an exception nothing caught prints whatever Bun chooses,
 * and the fatal `.catch` in index.ts printed only `err.message`: no stack, no
 * `cause`. Both paths now print the stack and every cause, then still exit 1,
 * so the host sees the crash exactly as before.
 */

const MAX_CAUSE_DEPTH = 5;

/** Stack (or name: message), then each `cause` and AggregateError member on its own line. */
export function describeFatal(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err);
  const lines = [err.stack ?? `${err.name}: ${err.message}`];
  if (depth < MAX_CAUSE_DEPTH) {
    if (err instanceof AggregateError) {
      err.errors.forEach((inner: unknown, i: number) => lines.push(`error[${i}]: ${describeFatal(inner, depth + 1)}`));
    }
    if (err.cause !== undefined) lines.push(`caused by: ${describeFatal(err.cause, depth + 1)}`);
  }
  return lines.join('\n');
}

function crash(kind: string, err: unknown): never {
  try {
    console.error(`[agent-runner] ${kind}: ${describeFatal(err)}`);
  } finally {
    process.exit(1);
  }
}

export function installFatalErrorHandlers(): void {
  process.on('uncaughtException', (err) => crash('Uncaught exception', err));
  process.on('unhandledRejection', (reason) => crash('Unhandled rejection', reason));
}
