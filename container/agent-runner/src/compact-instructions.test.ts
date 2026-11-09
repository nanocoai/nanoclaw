import { describe, expect, it } from 'bun:test';

import { buildCompactInstructions, buildPostCompactionReminder } from './compact-instructions.js';

describe('compaction delivery reminder', () => {
  it('preserves final-output addressing in chat sessions', () => {
    const instructions = buildCompactInstructions(['family'], null);

    expect(instructions).toContain('<message to="name">');
    expect(instructions).toContain('`family`');
  });

  it('preserves explicit-tool delivery in task sessions without teaching final-output blocks', () => {
    const instructions = buildCompactInstructions(['family'], 'daily-digest-a1b2');

    expect(instructions).toContain('send_message');
    expect(instructions).toContain('explicit to destination');
    expect(instructions).toContain('tasks/daily-digest-a1b2.md');
    expect(instructions).not.toContain('<message to="name">');
  });

  it('renders the delivery reminder byte-identically to the pre-extraction wording', () => {
    const chat = buildCompactInstructions(['family', 'ops'], null);
    expect(chat).toContain(
      [
        '   "You MUST wrap all responses in <message to="name">...</message> blocks.',
        '   Available destinations: `family`, `ops`."',
      ].join('\n'),
    );

    const task = buildCompactInstructions(['family'], 'daily-digest-a1b2');
    expect(task).toContain(
      [
        '   "This is an isolated task run. If you need to send the user a message, use send_message with an explicit to destination.',
        '   Final output is not delivered; it becomes the automatic summary in tasks/daily-digest-a1b2.md.',
        '   Available destinations: `family`."',
      ].join('\n'),
    );
  });
});

describe('post-compaction reminder', () => {
  it('re-states the canonical delivery sentences with the live destinations', () => {
    const reminder = buildPostCompactionReminder(['family', 'ops'], null);

    expect(reminder).toBe(
      '<system>The conversation was just compacted into a summary. Delivery instructions can be lost in ' +
        'that summary, so as a reminder: You MUST wrap all responses in <message to="name">...</message> blocks. ' +
        'Available destinations: `family`, `ops`.</system>',
    );
  });

  it('teaches explicit-tool delivery in task sessions', () => {
    const reminder = buildPostCompactionReminder([], 'daily-digest-a1b2');

    expect(reminder).toContain('send_message');
    expect(reminder).toContain('tasks/daily-digest-a1b2.md');
    expect(reminder).toContain('Available destinations: (none).');
    expect(reminder).not.toContain('<message to="name">');
  });
});
