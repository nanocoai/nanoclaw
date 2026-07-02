import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTemplate } from './parse.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-parse-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('parseTemplate', () => {
  it('parses mcpServers, instructions, context extras, and skills', () => {
    write('.mcp.json', JSON.stringify({ mcpServers: { fs: { command: 'mcp-fs', args: ['/data'] } } }));
    write('context/instructions.md', 'Be helpful.\n\n');
    write('context/playbook.md', '# Playbook');
    write('context/additional_context/faq.md', '# FAQ');
    write('skills/research/SKILL.md', 'do research');
    fs.writeFileSync(path.join(dir, 'context', 'notes.txt'), 'ignored'); // non-.md is ignored

    const tpl = parseTemplate(dir);

    expect(tpl.mcpServers).toEqual({ fs: { command: 'mcp-fs', args: ['/data'] } });
    expect(tpl.instructions).toBe('Be helpful.'); // trimEnd, instructions.md excluded from extras
    // Nested extras keep their context/-relative path as the name.
    expect(tpl.contextExtras.map((c) => c.name).sort()).toEqual(['additional_context/faq.md', 'playbook.md']);
    expect(tpl.skills.map((s) => s.name)).toEqual(['research']);
  });

  it('defaults the optionals when only instructions.md is present', () => {
    write('context/instructions.md', 'Only instructions.');
    const tpl = parseTemplate(dir);
    expect(tpl.mcpServers).toEqual({});
    expect(tpl.contextExtras).toEqual([]);
    expect(tpl.skills).toEqual([]);
  });

  it('throws when context/instructions.md is missing', () => {
    expect(() => parseTemplate(dir)).toThrow(/instructions\.md/);
  });

  it('throws when the folder does not exist', () => {
    expect(() => parseTemplate(path.join(dir, 'nope'))).toThrow(/not found/i);
  });
});
