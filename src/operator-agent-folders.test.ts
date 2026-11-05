import { describe, expect, it } from 'vitest';

import { isValidGroupFolder } from './group-folder.js';
import { cliAgentFolder, dmAgentFolder } from './operator-agent-folders.js';

describe('operator agent folders', () => {
  it('derives the terminal and DM agent folders from the display name', () => {
    expect(cliAgentFolder('Alex Smith')).toBe('cli-with-alex-smith');
    expect(dmAgentFolder('Alex Smith')).toBe('dm-with-alex-smith');
  });

  // The folder is at most 63 characters, and the user never sees it, so a long
  // name is cut to fit instead of being refused.
  it.each([
    ['terminal', cliAgentFolder],
    ['DM', dmAgentFolder],
  ])('fits any display name into a valid %s agent folder', (_agent, folderFor) => {
    for (const name of [
      'x'.repeat(200),
      'Maria Fernanda de los Ángeles García-Villanueva Rodríguez',
      'a'.repeat(53) + ' b c d e f',
    ]) {
      const folder = folderFor(name);
      expect(isValidGroupFolder(folder), folder).toBe(true);
      expect(folder.length).toBeLessThanOrEqual(63);
    }
  });

  it('never ends the folder on a separator when the cut lands on one', () => {
    expect(cliAgentFolder('a'.repeat(53) + ' bcd')).toBe(`cli-with-${'a'.repeat(53)}`);
  });
});
