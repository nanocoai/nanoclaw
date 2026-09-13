import { describe, expect, it } from 'vitest';

import { dispatch } from '../dispatch.js';
import './health.js';

describe('ncl health command', () => {
  it('is host-only and returns the structured resource model', async () => {
    const response = await dispatch({ id: 'health-test', command: 'health', args: {} }, { caller: 'host' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const data = response.data as { resources?: { groups?: unknown; policies?: unknown; skills?: unknown } };
    expect(data.resources?.groups).toBeDefined();
    expect(data.resources?.policies).toBeDefined();
    expect(data.resources?.skills).toBeDefined();
  });
});
