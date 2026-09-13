/**
 * Output tests for scripts/why.ts.
 *
 * Both of these are things `why` got wrong against live data, and neither was
 * visible from the schema guard in src/why-schema.test.ts — the columns were
 * all there, the tool just rendered them badly. An operator reads the `to` line
 * and the content preview before anything else, so a wrong address or an
 * undecodable body makes the whole verdict untrustworthy.
 *
 * Colocated with the script rather than under src/ because tsconfig's rootDir
 * is src/ — a test there cannot import scripts/why.ts without a TS6059. The
 * vitest include already covers scripts, as it does for scripts/release.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { formatDestination, previewContent } from './why.js';

describe('formatDestination: channel prefix is not doubled', () => {
  // Chat SDK adapters namespace their own ids ("telegram:123", "discord:g:c")
  // and send that form as platform_id — see src/platform-id.ts. Joining
  // channel_type to it produced `telegram:telegram:7061036646`, an address
  // that matches nothing an operator can grep for.
  it('leaves an already-prefixed platform id alone', () => {
    expect(formatDestination('telegram', 'telegram:7061036646')).toBe('telegram:7061036646');
  });

  it('leaves a multi-segment chat-sdk id alone', () => {
    expect(formatDestination('discord', 'discord:1234:5678')).toBe('discord:1234:5678');
  });

  it('still prefixes native adapter ids, which carry no channel', () => {
    // WhatsApp/iMessage emit JIDs, Signal emits phone numbers. Dropping the
    // prefix here would lose the channel the message was addressed to.
    expect(formatDestination('whatsapp', '15551234567@s.whatsapp.net')).toBe(
      'whatsapp:15551234567@s.whatsapp.net',
    );
    expect(formatDestination('signal', '+15551234567')).toBe('signal:+15551234567');
  });

  it('does not treat a channel name that is a prefix of another as namespaced', () => {
    // 'tele' is not 'telegram' — a bare startsWith without the colon would
    // silently swallow the prefix here.
    expect(formatDestination('tele', 'telegram:123')).toBe('tele:telegram:123');
  });

  it('degrades to whichever field is present, and to empty when neither is', () => {
    expect(formatDestination('telegram', null)).toBe('telegram');
    expect(formatDestination(null, 'telegram:123')).toBe('telegram:123');
    expect(formatDestination(null, null)).toBe('');
  });
});

describe('previewContent: envelopes are decoded, not dumped', () => {
  // Every outbound body is JSON, and several are envelopes rather than text:
  // ask_user_question and send_card write `type`, edit_message and
  // add_reaction write `operation`, self-mod writes `action`. Printing the
  // raw JSON spent the 120-char budget on punctuation and field names.
  it('decodes an ask_question card into its question and options', () => {
    const out = previewContent(
      JSON.stringify({
        type: 'ask_question',
        questionId: 'q1',
        title: 'Deploy',
        question: 'Ship to prod?',
        options: [
          { label: 'Yes', selectedLabel: '✓ Yes', value: 'yes' },
          { label: 'No', selectedLabel: '✗ No', value: 'no' },
        ],
      }),
    );
    expect(out).toBe('ask_question "Ship to prod?" [Yes, No]');
  });

  it('accepts bare-string options too', () => {
    const out = previewContent(
      JSON.stringify({ type: 'ask_question', questionId: 'q2', title: 'T', question: 'Pick', options: ['a', 'b'] }),
    );
    expect(out).toContain('Pick');
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('decodes a display card into its title and body', () => {
    const out = previewContent(
      JSON.stringify({
        type: 'card',
        card: { title: 'Build finished', description: '3 checks green' },
        fallbackText: '',
      }),
    );
    expect(out).toBe('card "Build finished" — 3 checks green');
  });

  it('decodes an edit and a reaction, which ride on kind chat', () => {
    expect(previewContent(JSON.stringify({ operation: 'edit', messageId: '4821', text: 'fixed typo' }))).toBe(
      'edit of 4821 → "fixed typo"',
    );
    expect(previewContent(JSON.stringify({ operation: 'reaction', messageId: '4821', emoji: 'thumbs_up' }))).toBe(
      'reaction thumbs_up on 4821',
    );
  });

  it('decodes a system action request', () => {
    expect(
      previewContent(JSON.stringify({ action: 'install_packages', apt: ['ffmpeg'], npm: [], reason: 'audio' })),
    ).toBe('action install_packages');
  });

  it('unwraps a plain text body to just the text', () => {
    expect(previewContent(JSON.stringify({ text: 'Deploy finished — 3 checks green.' }))).toBe(
      'Deploy finished — 3 checks green.',
    );
  });

  it('reports attachments, including when there is no accompanying text', () => {
    expect(previewContent(JSON.stringify({ text: 'chart', files: ['a.png'] }))).toBe('chart (+1 file)');
    expect(previewContent(JSON.stringify({ text: '', files: ['a.png', 'b.png'] }))).toBe('(+2 files)');
  });

  it('falls back to compact JSON for a shape it does not know', () => {
    // Honest degradation: an unrecognised envelope still shows its fields
    // rather than an empty line that reads as "no content".
    expect(previewContent(JSON.stringify({ mystery: 'value' }))).toBe('{"mystery":"value"}');
  });

  it('passes non-JSON bodies through unchanged', () => {
    expect(previewContent('just a string')).toBe('just a string');
  });

  it('collapses newlines and truncates, so one row stays one line', () => {
    expect(previewContent(JSON.stringify({ text: 'line one\nline two' }))).toBe('line one line two');
    const long = previewContent(JSON.stringify({ text: 'x'.repeat(400) }));
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBe(121);
  });
});
