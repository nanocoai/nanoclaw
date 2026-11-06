/**
 * Folders of the operator's terminal agent (scripts/init-cli-agent.ts) and DM
 * agent (scripts/init-first-agent.ts), from their display name.
 */
import { createHash } from 'crypto';

import { normalizeName } from './modules/agent-to-agent/db/agent-destinations.js';

// A group folder is at most 63 characters (group-folder.ts). The user never
// sees it, so a long display name is cut to fit instead of being refused. A cut
// name ends with a short hash of the whole name, so two long names that start
// the same never share a folder, and with it an agent's workspace and memory.
// normalizeName never makes `_`, so no name that fits can equal a cut one.
function operatorFolder(prefix: string, displayName: string): string {
  const name = normalizeName(displayName);
  const room = 63 - prefix.length;
  if (name.length <= room) return prefix + name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 6);
  return `${prefix}${name.slice(0, room - 7).replace(/-+$/, '')}_${hash}`;
}

export function cliAgentFolder(displayName: string): string {
  return operatorFolder('cli-with-', displayName);
}

export function dmAgentFolder(displayName: string): string {
  return operatorFolder('dm-with-', displayName);
}
