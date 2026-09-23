/**
 * Teams carries the bot's own display name on every inbound activity as its
 * `recipient`. The extractor hands that to the bridge, and nothing else: an
 * activity without a recipient name yields undefined, so the host keeps the
 * group name as before.
 */
import { describe, expect, it } from 'vitest';

import { teamsBotDisplayName } from './teams.js';

describe('teamsBotDisplayName', () => {
  it('reads the recipient name off an inbound activity', () => {
    expect(teamsBotDisplayName({ type: 'message', recipient: { id: '28:app', name: 'Front Desk' } })).toBe(
      'Front Desk',
    );
  });

  it('yields undefined when the activity names no recipient', () => {
    expect(teamsBotDisplayName({ type: 'message' })).toBeUndefined();
    expect(teamsBotDisplayName({ recipient: { id: '28:app' } })).toBeUndefined();
    expect(teamsBotDisplayName({ recipient: { id: '28:app', name: '  ' } })).toBeUndefined();
    expect(teamsBotDisplayName({ recipient: { id: '28:app', name: 7 } })).toBeUndefined();
  });
});
