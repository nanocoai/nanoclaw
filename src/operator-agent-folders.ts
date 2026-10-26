/**
 * Folders of the operator's terminal agent (scripts/init-cli-agent.ts) and DM
 * agent (scripts/init-first-agent.ts), from their display name. Setup checks
 * the name here, so one that can't be a folder is refused as it's typed.
 */
import { isValidGroupFolder } from './group-folder.js';
import { normalizeName } from './modules/agent-to-agent/db/agent-destinations.js';

export function cliAgentFolder(displayName: string): string {
  return `cli-with-${normalizeName(displayName)}`;
}

export function dmAgentFolder(displayName: string): string {
  return `dm-with-${normalizeName(displayName)}`;
}

export type FolderFor = (displayName: string) => string;

/**
 * Why `displayName` can't name the agents in `folders` (default: both), or
 * undefined when it can. A derived folder can only fail on length; the limit
 * is probed through the folder grammar, so it follows any change there.
 */
export function displayNameProblem(
  displayName: string,
  folders: readonly FolderFor[] = [cliAgentFolder, dmAgentFolder],
): string | undefined {
  const fits = (name: string) => folders.every((folderFor) => isValidGroupFolder(folderFor(name)));
  if (fits(displayName)) return undefined;
  const slugLength = normalizeName(displayName).length;
  let max = 0;
  while (max < slugLength && fits('x'.repeat(max + 1))) max++;
  return `That name is too long for your agent's folder. Use at most ${max} characters.`;
}
