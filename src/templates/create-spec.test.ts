import { describe, expect, it } from 'vitest';

import { type AgentCreateSpec, MAX_TEMPLATE_CONTRIBUTION_FILE_BYTES, validateAgentCreateSpec } from './create-spec.js';

function spec(templateContributions?: AgentCreateSpec['templateContributions']): AgentCreateSpec {
  return {
    version: 2,
    id: 'ag-test',
    name: 'Test',
    folder: 'test',
    template: { ref: 'support', expectedDigest: 'sha256:test' },
    config: {
      mcpServers: {},
      cliScope: 'disabled',
      packagesApt: [],
      packagesNpm: [],
    },
    ...(templateContributions ? { templateContributions } : {}),
  };
}

describe('validateAgentCreateSpec', () => {
  it('accepts bounded instructions, Markdown context, and complete skills', () => {
    expect(() =>
      validateAgentCreateSpec(
        spec({
          standingInstructions: ['# Tools\n\nUse Calendar.'],
          contextFiles: [{ name: 'reference/limits.md', content: '# Limits\n' }],
          skills: [
            {
              name: 'nanoco-app-calendar',
              files: { 'SKILL.md': '# Calendar\n', 'references/events.md': '# Events\n' },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    [
      'unsafe context traversal',
      { contextFiles: [{ name: '../escape.md', content: 'nope' }] },
      /unsafe template context file path/,
    ],
    ['non-Markdown context', { contextFiles: [{ name: 'limits.txt', content: 'nope' }] }, /must be Markdown/],
    [
      'unsafe skill traversal',
      { skills: [{ name: 'nanoco-app-calendar', files: { 'SKILL.md': 'ok', '../escape.md': 'nope' } }] },
      /unsafe template skill file path/,
    ],
    [
      'missing SKILL.md',
      { skills: [{ name: 'nanoco-app-calendar', files: { 'references/events.md': '# Events\n' } }] },
      /missing required SKILL\.md/,
    ],
    [
      'unsafe skill name',
      { skills: [{ name: '..', files: { 'SKILL.md': 'nope' } }] },
      /unsafe template contribution skill name/,
    ],
  ])('rejects %s', (_case, contributions, expected) => {
    expect(() => validateAgentCreateSpec(spec(contributions))).toThrow(expected);
  });

  it('rejects oversized contributed content', () => {
    expect(() =>
      validateAgentCreateSpec(
        spec({
          standingInstructions: ['x'.repeat(MAX_TEMPLATE_CONTRIBUTION_FILE_BYTES + 1)],
        }),
      ),
    ).toThrow(/exceeds/);
  });

  it('rejects package values that cannot be represented by template package files', () => {
    const invalid = spec();
    invalid.config.packagesApt = [' jq'];
    expect(() => validateAgentCreateSpec(invalid)).toThrow(/single-line package name/);
  });
});
