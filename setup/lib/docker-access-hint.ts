import path from 'path';

import { commandExists, isWSL } from '../platform.js';

/** What to print when the service step left the service unable to reach Docker, or null. */
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
  // A restart between crash-loop restarts inherits circuit-breaker.ts's backoff;
  // clearing its file starts the host at once.
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
      `rm -f '${breaker.replace(/'/g, `'\\''`)}'`,
      `systemctl --user restart ${unit}`,
    ],
    note: `The setfacl fix lasts until Docker restarts. ${lasting}`,
  };
}
