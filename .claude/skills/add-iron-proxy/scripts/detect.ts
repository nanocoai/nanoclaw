import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function configuredContainer(projectRoot: string): string {
  try {
    return (
      fs
        .readFileSync(path.join(projectRoot, '.env'), 'utf8')
        .match(/^NANOCLAW_IRON_PROXY_CONTAINER=(\S+)$/m)?.[1]
        ?.trim() ?? ''
    );
  } catch {
    return '';
  }
}

// Standalone: this runs before the payload is installed, so it cannot import
// CONTAINER_RUNTIME_BIN. Keep the literal in step with src/container-runtime.ts.
const CONTAINER_RUNTIME_BIN = 'docker';

function containerRunning(name: string): boolean {
  try {
    return (
      execFileSync(CONTAINER_RUNTIME_BIN, ['inspect', '-f', '{{.State.Running}}', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

export function detectInstalledIronProxy(
  projectRoot = process.cwd(),
  inspect: (name: string) => boolean = containerRunning,
): boolean {
  const container = configuredContainer(projectRoot);
  return container !== '' && inspect(container);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  console.log(detectInstalledIronProxy() ? 'installed' : 'absent');
}
