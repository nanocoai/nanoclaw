export interface RunBunResult {
  /** null when a signal ended the child; see signalCode. */
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a bun child to completion without `spawnSync`. Bun 1.4.0's spawnSync
 * can lose the child's exit and wait forever (oven-sh/bun#34069), which shows
 * up in CI as a 5 s test timeout plus "killed 1 dangling process".
 */
export async function runBun(args: string[], stdin: string, cwd: string = process.cwd()): Promise<RunBunResult> {
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Drain both pipes while waiting: a child that fills a pipe buffer blocks until it is read.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode: proc.exitCode, signalCode: proc.signalCode, stdout, stderr };
}
