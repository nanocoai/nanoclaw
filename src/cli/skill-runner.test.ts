/**
 * The engine's child environment: a service host's PATH has no node or pnpm,
 * so the runner puts the directories they realistically live in first.
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { engineEnv } from './skill-runner.js';

describe('engineEnv', () => {
  it('puts the running node and the checkout bin dir ahead of the service PATH, once each', () => {
    const root = process.cwd();
    const env = engineEnv(root, { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nowhere' });
    const dirs = (env.PATH ?? '').split(path.delimiter);
    expect(dirs.indexOf(path.dirname(process.execPath))).toBeGreaterThanOrEqual(0);
    expect(dirs.indexOf(path.dirname(process.execPath))).toBeLessThan(dirs.indexOf('/usr/bin'));
    expect(dirs).toContain(path.join(root, 'node_modules', '.bin'));
    expect(dirs.slice(-3)).toEqual(['/usr/local/bin', '/usr/bin', '/bin']);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('honours a configured pnpm home and drops directories that do not exist', () => {
    const env = engineEnv(process.cwd(), { PATH: '/bin', PNPM_HOME: '/definitely/not/here' });
    expect(env.PATH).not.toContain('/definitely/not/here');
    expect(env.PATH?.endsWith('/bin')).toBe(true);
  });
});
