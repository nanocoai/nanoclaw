import path from 'path';

import { commandExists, isWSL } from '../platform.js';

/**
 * What to tell the user when the service step could not let the background
 * service reach Docker (DOCKER_GROUP_STALE in SETUP_SERVICE). Returns null
 * when there is nothing to fix.
 */
export function dockerAccessHint(
  fields: Record<string, string>,
  unit: string,
  host: { wsl: boolean; apt: boolean } = { wsl: isWSL(), apt: commandExists('apt-get') },
): { title: string; commands: string[]; note: string } | null {
  if (fields.DOCKER_GROUP_STALE !== 'true') return null;

  const installAcl =
    fields.SETFACL_MISSING !== 'true'
      ? []
      : [host.apt ? 'sudo apt-get install -y acl' : '# first install the acl package (it provides setfacl)'];
  // A restart that lands in the gap between crash-loop restarts inherits the
  // crash backoff (up to 15 min); clearing its state starts the host at once.
  const breaker = path.posix.join(fields.PROJECT_PATH ?? '', 'data', 'circuit-breaker.json');
  // Setup turns on linger, so logging out does not restart the user manager;
  // only a reboot (or a WSL shutdown) gives it the docker group.
  const lasting = host.wsl
    ? 'To fix it for good, run `wsl --shutdown` in PowerShell, then reopen your Linux terminal.'
    : 'A reboot fixes it for good.';
  return {
    title: "NanoClaw can't reach Docker yet. To fix it now, run:",
    commands: [
      ...installAcl,
      'sudo setfacl -m u:$(whoami):rw /var/run/docker.sock',
      `rm -f '${breaker}'`,
      `systemctl --user restart ${unit}`,
    ],
    note: `The setfacl fix lasts until Docker restarts. ${lasting}`,
  };
}
