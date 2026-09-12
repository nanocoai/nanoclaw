import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/** Source installation is an operator capability, separate from agent approval. */
export function sourceInstallRefusal(root: string = process.cwd()): string | undefined {
  const policy = process.env.NANOCLAW_SOURCE_INSTALL;
  if (policy !== 'enabled') {
    return 'Source installation is disabled for this deployment. Use its release deployment workflow, or have the operator enable NANOCLAW_SOURCE_INSTALL=enabled for a source checkout.';
  }
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (realpathSync(top) === realpathSync(root)) return undefined;
  } catch {
    // Packaged runtimes have no source checkout (and may not ship git).
  }
  return 'Source installation requires the root of a Git checkout. Use the deployment workflow for packaged runtimes.';
}
