import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: () => ({}),
}));

describe('Gateway approval runtime registration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('registers startup and shutdown through the host lifecycle registry', async () => {
    const lifecycle = await import('../host-lifecycle.js');
    expect(lifecycle.getHostStartCallbacks()).toHaveLength(0);
    expect(lifecycle.getHostShutdownCallbacks()).toHaveLength(0);

    await import('./approval-runtime.js');

    const starts = lifecycle.getHostStartCallbacks();
    const stops = lifecycle.getHostShutdownCallbacks();
    expect(starts).toHaveLength(1);
    expect(stops).toHaveLength(1);

    await expect(
      Promise.resolve(starts[0]({ db: {} as never, signal: new AbortController().signal })),
    ).resolves.toBeUndefined();
    await expect(Promise.resolve(stops[0]())).resolves.toBeUndefined();
  });
});
