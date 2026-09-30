import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('host startup seam', () => {
  it('runs registered callbacks in insertion order and rejects a duplicate name', async () => {
    const startup = await import('./host-startup.js');
    expect(startup.HOST_STARTUP_SEAM).toBe(1);
    const seen: string[] = [];
    startup.registerHostStartup('first', () => {
      seen.push('first');
    });
    startup.registerHostStartup('second', async () => {
      seen.push('second');
    });
    expect(() => startup.registerHostStartup('first', () => {})).toThrow(/Host startup already registered: first/);
    await startup.runHostStartups();
    expect(seen).toEqual(['first', 'second']);
  });
});
