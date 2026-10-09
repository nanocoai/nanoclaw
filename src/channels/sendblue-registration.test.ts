import { expect, it } from 'vitest';

import './index.js';
import { getRegisteredChannelNames, getChannelDefaults } from './channel-registry.js';

it('registers Sendblue through the real channel barrel with strict DM defaults', () => {
  expect(getRegisteredChannelNames()).toContain('sendblue');
  expect(getChannelDefaults('sendblue').dm.unknownSenderPolicy).toBe('strict');
});
