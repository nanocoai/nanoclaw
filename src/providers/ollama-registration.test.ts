import { expect, it } from 'vitest';

import './index.js';
import { listProviderContainerConfigNames } from './provider-container-registry.js';

it('registers ollama through the host provider barrel', () => {
  expect(listProviderContainerConfigNames()).toContain('ollama');
});
