import { describe, it, expect, vi } from 'vitest';

import type { Session } from './types.js';

const wakeContainer = vi.fn();
vi.mock('./container-runner.js', () => ({
  wakeContainer: (session: Session) => wakeContainer(session),
}));

import { requestWake } from './request-wake.js';

const session = { id: 's-1', agent_group_id: 'g-1' } as Session;

describe('requestWake', () => {
  it('is a pure delegation to wakeContainer (role=all byte-equivalence)', async () => {
    wakeContainer.mockResolvedValueOnce(true);
    expect(await requestWake(session, 'inbound-message')).toBe(true);
    expect(wakeContainer).toHaveBeenCalledWith(session);

    wakeContainer.mockResolvedValueOnce(false);
    expect(await requestWake(session, 'due-message')).toBe(false);
  });
});
