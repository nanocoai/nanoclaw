import { execFileSync } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../../src/log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { log } from '../../src/log.js';
import { ensureUserLinger } from './systemd-linger.js';

let enabled: boolean;
let queryFails: boolean;
let userCanEnable: boolean;
let sudoCanEnable: boolean;
let succeedsWithoutEnabling: boolean;
let calls: { command: string; args: string[] }[];

beforeEach(() => {
  vi.clearAllMocks();
  enabled = false;
  queryFails = false;
  userCanEnable = false;
  sudoCanEnable = false;
  succeedsWithoutEnabling = false;
  calls = [];
  vi.mocked(execFileSync).mockImplementation(((
    command: string,
    args: string[],
    options: { timeout: number; stdio: string[] },
  ) => {
    calls.push({ command, args });
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(5_000);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    if (command === 'loginctl' && args[0] === 'show-user') {
      if (queryFails) throw new Error('user state unavailable');
      return enabled ? 'yes\n' : 'no\n';
    }
    // A fake minimal system only accepts commands which cannot spawn pkttyagent
    // or prompt for a sudo password. It models the permission outcomes below.
    expect(args).toContain('--no-ask-password');
    expect(args.at(-1)).toBe('1000');
    if (command === 'sudo') {
      expect(args.slice(0, 2)).toEqual(['-n', 'loginctl']);
      if (!sudoCanEnable && !succeedsWithoutEnabling) throw new Error('sudo: password required');
      if (sudoCanEnable) enabled = true;
    } else if (command === 'loginctl') {
      if (!userCanEnable && !succeedsWithoutEnabling) throw new Error('access denied');
      if (userCanEnable) enabled = true;
    } else {
      throw new Error('unexpected executable');
    }
    return '';
  }) as typeof execFileSync);
});

describe('verified systemd user linger', () => {
  it('only reads state when provisioning already enabled linger', () => {
    enabled = true;
    expect(ensureUserLinger(1000)).toBe(true);
    expect(calls).toEqual([{ command: 'loginctl', args: ['show-user', '1000', '--property=Linger', '--value'] }]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('uses the user permission when available without invoking sudo', () => {
    userCanEnable = true;
    expect(ensureUserLinger(1000)).toBe(true);
    expect(calls.some(({ command }) => command === 'sudo')).toBe(false);
    expect(calls.at(-1)?.args[0]).toBe('show-user');
  });

  it('falls back to existing noninteractive sudo rights for the same user', () => {
    sudoCanEnable = true;
    expect(ensureUserLinger(1000)).toBe(true);
    expect(calls.filter(({ command }) => command === 'sudo')).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reports failure with recovery guidance when neither path is permitted', () => {
    expect(ensureUserLinger(1000)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('may stop on logout'), {
      hint: expect.stringContaining('sudo loginctl enable-linger 1000'),
    });
  });

  it('does not report success merely because enable-linger exited zero', () => {
    succeedsWithoutEnabling = true;
    expect(ensureUserLinger(1000)).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('does not claim persistence if the final user state cannot be read', () => {
    queryFails = true;
    userCanEnable = true;
    sudoCanEnable = true;
    expect(ensureUserLinger(1000)).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
