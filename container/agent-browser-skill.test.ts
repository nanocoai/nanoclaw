import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('agent-browser skill routing', () => {
  it('reserves Chromium for interactive work when direct web tools are available', () => {
    const skill = fs.readFileSync('container/skills/agent-browser/SKILL.md', 'utf8');

    expect(skill).toContain("prefer the provider's direct Web Search or Web Fetch tools");
    expect(skill).toContain('clicks, typing, login state, screenshots, visual inspection');
    expect(skill).not.toContain('Browse the web for any task');
  });
});
