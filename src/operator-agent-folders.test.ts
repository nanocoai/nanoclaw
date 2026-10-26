import { describe, expect, it } from 'vitest';

import { isValidGroupFolder } from './group-folder.js';
import { cliAgentFolder, displayNameProblem, dmAgentFolder } from './operator-agent-folders.js';

describe('operator agent folders', () => {
  it('derives the terminal and DM agent folders from the display name', () => {
    expect(cliAgentFolder('Alex Smith')).toBe('cli-with-alex-smith');
    expect(dmAgentFolder('Alex Smith')).toBe('dm-with-alex-smith');
  });

  it('accepts the longest name that fits both folders', () => {
    const name = 'x'.repeat(54);
    expect(isValidGroupFolder(cliAgentFolder(name))).toBe(true);
    expect(displayNameProblem(name)).toBeUndefined();
  });

  it('refuses a name one character longer, naming the limit', () => {
    const name = 'x'.repeat(55);
    // The DM folder still fits: the terminal agent's longer prefix sets the limit.
    expect(isValidGroupFolder(dmAgentFolder(name))).toBe(true);
    expect(isValidGroupFolder(cliAgentFolder(name))).toBe(false);
    expect(displayNameProblem(name)).toBe("That name is too long for your agent's folder. Use at most 54 characters.");
  });

  it('checks only the folders it is given', () => {
    const name = 'x'.repeat(55);
    expect(displayNameProblem(name, [dmAgentFolder])).toBeUndefined();
    expect(displayNameProblem('x'.repeat(56), [dmAgentFolder])).toBe(
      "That name is too long for your agent's folder. Use at most 55 characters.",
    );
  });

  it('measures the folder, so spaces and punctuation that collapse do not count against the name', () => {
    const name = 'Ab. '.repeat(15);
    expect(name.length).toBe(60);
    expect(displayNameProblem(name)).toBeUndefined();
  });
});
