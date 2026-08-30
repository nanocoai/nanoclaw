import { describe, expect, it } from 'bun:test';

import { skillNameFromCreatedTool, skillNameFromUse } from './index.js';

describe('container host audit privacy mapping', () => {
  it('keeps only the bounded Skill slug', () => {
    expect(skillNameFromUse({ skill: 'weekly-brief', args: 'SECRET ARGUMENTS' })).toBe('weekly-brief');
    expect(skillNameFromUse({ skill: '../escape' })).toBeNull();
  });

  it('recognizes successful skill definition edits without exposing their paths', () => {
    expect(skillNameFromCreatedTool('Write', { file_path: '/workspace/agent/skills/weekly-brief/SKILL.md' })).toBe(
      'weekly-brief',
    );
    expect(skillNameFromCreatedTool('Write', { file_path: '/home/node/.claude/skills/custom/SKILL.md' })).toBe('custom');
    expect(skillNameFromCreatedTool('Edit', { file_path: '/home/node/.claude/skills/custom/SKILL.md' })).toBeNull();
    expect(skillNameFromCreatedTool('Read', { file_path: '/workspace/agent/skills/weekly-brief/SKILL.md' })).toBeNull();
    expect(skillNameFromCreatedTool('Write', { file_path: '/workspace/agent/private.txt' })).toBeNull();
  });
});
