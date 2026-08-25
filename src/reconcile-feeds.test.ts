import { afterEach, describe, expect, it, vi } from 'vitest';

import { enqueueSessionReconcile, registerReconcileEnqueue } from './reconcile-feeds.js';

afterEach(() => {
  registerReconcileEnqueue(null);
});

describe('reconcile enqueue feed', () => {
  it('is a no-op while nothing is registered', () => {
    expect(() => enqueueSessionReconcile('s-1')).not.toThrow();
  });

  it('delivers to the registered enqueue and stops after clearing', () => {
    const enqueue = vi.fn();
    registerReconcileEnqueue(enqueue);
    enqueueSessionReconcile('s-1');
    expect(enqueue).toHaveBeenCalledWith('s-1');

    registerReconcileEnqueue(null);
    enqueueSessionReconcile('s-2');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('never lets a throwing enqueue reach the caller', () => {
    registerReconcileEnqueue(() => {
      throw new Error('queue gone');
    });
    expect(() => enqueueSessionReconcile('s-1')).not.toThrow();
  });
});
