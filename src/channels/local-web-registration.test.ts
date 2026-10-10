import { describe, expect, it } from 'vitest';

import './index.js';
import { getChannelDefaults, getRegisteredChannelNames } from './channel-registry.js';

describe('local web registration', () => {
  it('registers local-web through the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('local-web');
    expect(getChannelDefaults('local-web').dm).toMatchObject({
      engageMode: 'pattern',
      engagePattern: '.',
      unknownSenderPolicy: 'public',
    });
  });
});
