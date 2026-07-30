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
  it('parses mcpServers, instructions, context extras, skills, and tasks', () => {
    write('.mcp.json', JSON.stringify({ mcpServers: { fs: { command: 'mcp-fs', args: ['/data'] } } }));
    write('context/instructions.md', 'Be helpful.\n\n');
    write('context/playbook.md', '# Playbook');
    write('context/additional_context/faq.md', '# FAQ');
    write('skills/research/SKILL.md', 'do research');
    write(
      'tasks/weekly-review.md',
      '---\nschedule: \'0 9 * * 1\'\nscript: |\n  changed=$(git status --short)\n  echo "{\\"wakeAgent\\": $([ -n \\"$changed\\" ] && echo true || echo false)}"\n---\n\nReview the week.\n',
    );
    write('tasks/daily-briefing.md', '---\nschedule: 0 8 * * *\n---\n\nSend the briefing.\n');
    fs.writeFileSync(path.join(dir, 'context', 'notes.txt'), 'ignored'); // non-.md is ignored

    const tpl = parseTemplate(dir);

    expect(tpl.mcpServers).toEqual({ fs: { command: 'mcp-fs', args: ['/data'] } });
    expect(tpl.instructions).toBe('Be helpful.'); // trimEnd, instructions.md excluded from extras
    // Nested extras keep their context/-relative path as the name.
    expect(tpl.contextExtras.map((c) => c.name).sort()).toEqual(['additional_context/faq.md', 'playbook.md']);
    expect(tpl.skills.map((s) => s.name)).toEqual(['research']);
    expect(tpl.tasks).toEqual([
      {
        name: 'daily-briefing',
        schedule: '0 8 * * *',
        prompt: 'Send the briefing.',
        source: 'tasks/daily-briefing.md',
      },
      {
        name: 'weekly-review',
        schedule: '0 9 * * 1',
        script:
          'changed=$(git status --short)\necho "{\\"wakeAgent\\": $([ -n \\"$changed\\" ] && echo true || echo false)}"\n',
        prompt: 'Review the week.',
        source: 'tasks/weekly-review.md',
      },
    ]);
  });

  it('accepts a single-line script string', () => {
    write('context/instructions.md', 'Be helpful.');
    write('tasks/check.md', '---\nschedule: "0 9 * * *"\nscript: echo wake\n---\nCheck it.\n');

    expect(parseTemplate(dir).tasks[0].script).toBe('echo wake');
  });

  it('defaults the optionals when only instructions.md is present', () => {
    write('context/instructions.md', 'Only instructions.');
    const tpl = parseTemplate(dir);
    expect(tpl.mcpServers).toEqual({});
    expect(tpl.contextExtras).toEqual([]);
    expect(tpl.skills).toEqual([]);
    expect(tpl.tasks).toEqual([]);
  });

  it.each([
    ['missing frontmatter', 'Run it.', /must start with ---/],
    ['unknown field', '---\ncron: 0 9 * * *\n---\nRun it.', /only schedule and script/],
    ['extra field', '---\nschedule: 0 9 * * *\nenabled: true\n---\nRun it.', /only schedule and script/],
    ['invalid YAML', '---\nschedule: "0 9 * * *\n---\nRun it.', /invalid YAML frontmatter/],
    ['non-mapping frontmatter', '---\n- schedule\n---\nRun it.', /YAML mapping/],
    ['non-string schedule', '---\nschedule: 9\n---\nRun it.', /schedule must be a nonempty string/],
    ['empty schedule', '---\nschedule: "  "\n---\nRun it.', /schedule must be a nonempty string/],
    ['non-string script', '---\nschedule: 0 9 * * *\nscript: 42\n---\nRun it.', /script must be a nonempty string/],
    ['empty script', '---\nschedule: 0 9 * * *\nscript: "  "\n---\nRun it.', /script must be a nonempty string/],
    ['empty prompt', '---\nschedule: 0 9 * * *\n---\n', /prompt is required/],
  ])('rejects a task with %s', (_case, content, expected) => {
    write('context/instructions.md', 'Be helpful.');
    write('tasks/broken.md', content);
    expect(() => parseTemplate(dir)).toThrow(expected);
  });

  it('throws when context/instructions.md is missing', () => {
    expect(() => parseTemplate(dir)).toThrow(/instructions\.md/);
  });

  it('throws when the folder does not exist', () => {
    expect(() => parseTemplate(path.join(dir, 'nope'))).toThrow(/not found/i);
  });
});
