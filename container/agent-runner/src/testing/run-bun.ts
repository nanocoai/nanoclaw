export interface RunBunResult {
  exitCode: number;
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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
