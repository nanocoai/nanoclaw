import { expect, it } from 'bun:test';

import './index.js';
import { listProviderNames } from './provider-registry.js';

it('registers ollama through the container provider barrel', () => {
  expect(listProviderNames()).toContain('ollama');
});
