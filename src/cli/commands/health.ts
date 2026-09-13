import { collectConfiguredHostHealth } from '../../health.js';
import { register } from '../registry.js';

register({
  name: 'health',
  description: 'Return the structured health and resource state for this NanoClaw host.',
  access: 'open',
  hostOnly: true,
  parseArgs: (raw) => {
    if (Object.keys(raw).length > 0) throw new Error('health does not accept arguments');
    return {};
  },
  handler: async () => collectConfiguredHostHealth(),
});
