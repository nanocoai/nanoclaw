/**
 * Folders of the operator's terminal agent (scripts/init-cli-agent.ts) and DM
 * agent (scripts/init-first-agent.ts), from their display name.
 */
import { normalizeName } from './modules/agent-to-agent/db/agent-destinations.js';

// A group folder is at most 63 characters (group-folder.ts). The user never
// sees it, so a long display name is cut to fit instead of being refused.
function operatorFolder(prefix: string, displayName: string): string {
  return (
    prefix +
    normalizeName(displayName)
      .slice(0, 63 - prefix.length)
      .replace(/-+$/, '')
  );
}

export function cliAgentFolder(displayName: string): string {
  return operatorFolder('cli-with-', displayName);
}

export function dmAgentFolder(displayName: string): string {
  return operatorFolder('dm-with-', displayName);
}
