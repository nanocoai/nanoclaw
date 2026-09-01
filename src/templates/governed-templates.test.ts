import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { parseTemplate } from './parse.js';

const NAMES = ['engineering-agent', 'personal-assistant', 'strategic-deals', 'design-search'] as const;

describe('governed Agent Plugins 1.0.0 bundles', () => {
  for (const name of NAMES) {
    it(`parses ${name} through NanoClaw's production plugin reader`, () => {
      const dir = path.join(process.cwd(), 'templates', name);
      const plugin = parseTemplate(dir);
      expect(plugin.name).toBe(name);
      expect(plugin.report).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'agent.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'context', 'instructions.md'))).toBe(false);
    });
  }

  it('keeps tasks and contributed context in the NanoClaw extension', () => {
    const plugin = parseTemplate(path.join(process.cwd(), 'templates', 'personal-assistant'));
    expect(plugin.tasks.map((task) => task.name).sort()).toEqual([
      'inbox-sweep',
      'memory-gardening',
      'morning-brief',
    ]);
    expect(plugin.contextExtras.map((entry) => entry.name)).toContain('memory/index.md');
  });
});
