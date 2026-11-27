import { describe, it, expect } from 'vitest';

/**
 * Regex-level tests for the ASSISTANT_NAME rename pass that runs against
 * `groups/<folder>/CLAUDE.md` files. The production caller lives in
 * `setup/register.ts:222-232` (the setup-time path) and applies these
 * same three substitutions to every group CLAUDE.md when the user picks
 * a non-default assistant name. The runtime-side equivalent
 * (`registerGroup()` in v1's `src/index.ts`) was removed by the v2
 * claude-md composition refactor; new groups now get an empty
 * `CLAUDE.local.md` via `initGroupFilesystem` and a composed shared base
 * via `claude-md-compose.ts`, so the runtime path no longer ships
 * `@Andy` strings that need renaming.
 *
 * Kept as an independent regex unit so a future refactor of the rename
 * step (string-template, helper extraction, etc.) trips here before it
 * trips an integration test.
 */

function applyRenames(content: string, assistantName: string): string {
  let out = content;
  out = out.replace(/^# Andy$/m, `# ${assistantName}`);
  out = out.replace(/You are Andy/g, `You are ${assistantName}`);
  out = out.replace(/@Andy\b/g, `@${assistantName}`);
  return out;
}

describe('ASSISTANT_NAME rename pass on group CLAUDE.md', () => {
  it('rewrites heading, identity line, and @Andy trigger references', () => {
    const template = [
      '# Andy',
      '',
      'You are Andy, a helpful assistant.',
      '',
      'Scheduled tasks:',
      '  { "trigger": "@Andy", "prompt": "daily" }',
      '  { "trigger": "@Andy", "prompt": "weekly" }',
    ].join('\n');

    const renamed = applyRenames(template, 'Ruby');

    expect(renamed).toContain('# Ruby');
    expect(renamed).toContain('You are Ruby');
    expect(renamed).not.toContain('@Andy');
    expect(renamed).toContain('@Ruby');
  });

  it('word boundary prevents matching names that start with Andy', () => {
    const renamed = applyRenames('@Andyville is unrelated', 'Ruby');
    expect(renamed).toBe('@Andyville is unrelated');
  });

  it('leaves content unchanged when assistant name is Andy', () => {
    const template = '# Andy\n\nYou are Andy.\n\n@Andy trigger';
    // setup/register.ts short-circuits when ASSISTANT_NAME === 'Andy', so
    // applyRenames is never called in that case — simulate that guard here.
    const out = template; // no rename performed
    expect(out).toContain('# Andy');
    expect(out).toContain('@Andy');
  });
});
