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

  it('keeps a name that fits as it is', () => {
    expect(cliAgentFolder('a'.repeat(54))).toBe(`cli-with-${'a'.repeat(54)}`);
    expect(dmAgentFolder('a'.repeat(55))).toBe(`dm-with-${'a'.repeat(55)}`);
  });

  // Same folder means same agent group: the second user would get the first one's agent.
  it.each([
    ['terminal', cliAgentFolder],
    ['DM', dmAgentFolder],
  ])('gives two long names that start the same different %s agent folders', (_agent, folderFor) => {
    const first = folderFor('a'.repeat(56));
    expect(folderFor('a'.repeat(56) + 'b')).not.toBe(first);
    expect(folderFor('a'.repeat(55) + 'b')).not.toBe(first);
    expect(first).toMatch(/_[0-9a-f]{6}$/);
    // The hash is of the normalized name, as the folder itself is.
    expect(folderFor('A'.repeat(56))).toBe(first);
  });

  it.each([
    ['terminal', 'cli-with-', cliAgentFolder],
    ['DM', 'dm-with-', dmAgentFolder],
  ])('never lets a name that fits equal a cut %s agent folder', (_agent, prefix, folderFor) => {
    const cut = folderFor('a'.repeat(56));
    // The cut folder's own name part typed back in, with `_` or `-` before the hash.
    const typed = cut.slice(prefix.length);
    expect(folderFor(typed)).not.toBe(cut);
    expect(folderFor(typed.replace('_', '-'))).not.toBe(cut);
  });

  // Pinned, so a later change can't move an existing agent's folder.
  it('hashes the whole normalized name with sha256', () => {
    const name = 'A'.repeat(28) + '!! ' + 'a'.repeat(28);
    expect(dmAgentFolder(name)).toBe(`dm-with-${'a'.repeat(28)}-${'a'.repeat(19)}_b132cd`);
    expect(cliAgentFolder(name)).toBe(`cli-with-${'a'.repeat(28)}-${'a'.repeat(18)}_b132cd`);
  });

  it('never leaves a dash before the hash when the cut lands on one', () => {
    expect(cliAgentFolder('a'.repeat(46) + ' bcdefghijk')).toMatch(/^cli-with-a{46}_[0-9a-f]{6}$/);
  });
});
