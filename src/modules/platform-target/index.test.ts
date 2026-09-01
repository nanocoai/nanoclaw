import { describe, expect, it } from 'vitest';

import { platformMessageId, platformTargetContent } from './index.js';

const GROUP = '7b0c2173-1926-4b35-8fba-435d0bee03fb';
const TS = '1788260300.123456';

describe('platform message targeting', () => {
  it('strips the namespace the router added to an inbound id', () => {
    expect(platformMessageId(`${TS}:${GROUP}`, GROUP)).toBe(TS);
  });

  it('leaves an id that does not carry THIS session namespace alone', () => {
    // Another group's suffix is not ours to strip, and a bare platform id —
    // what a delivery record holds for the agent's own message — must survive
    // so edits keep working.
    expect(platformMessageId(`${TS}:other-group`, GROUP)).toBe(`${TS}:other-group`);
    expect(platformMessageId(TS, GROUP)).toBe(TS);
  });

  it('translates a reaction and leaves the rest of the blob intact', () => {
    const content = JSON.stringify({ operation: 'reaction', messageId: `${TS}:${GROUP}`, emoji: 'tada' });
    const parsed = JSON.parse(platformTargetContent(content, GROUP));
    expect(parsed).toEqual({ operation: 'reaction', messageId: TS, emoji: 'tada' });
  });

  it('does not touch operations that address the agent\'s own messages', () => {
    // An edit targets a message WE sent, whose id came from the delivery
    // record and was never namespaced.
    const content = JSON.stringify({ operation: 'edit', messageId: TS, text: 'x' });
    expect(platformTargetContent(content, GROUP)).toBe(content);
  });

  it('never fails a delivery on input it does not recognise', () => {
    expect(platformTargetContent('not json', GROUP)).toBe('not json');
    expect(platformTargetContent('[]', GROUP)).toBe('[]');
    expect(platformTargetContent(JSON.stringify({ text: 'hello' }), GROUP)).toBe(JSON.stringify({ text: 'hello' }));
    expect(platformTargetContent(JSON.stringify({ operation: 'reaction' }), GROUP)).toBe(
      JSON.stringify({ operation: 'reaction' }),
    );
  });
});
