import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../../src/log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { log } from '../../src/log.js';
import { ensureUserLinger } from './systemd-linger.js';

let enabled: boolean;
let queryFails: boolean;
let failedQueries: number;
let userCanEnable: boolean;
let sudoCanEnable: boolean;
let succeedsWithoutEnabling: boolean;
let calls: { command: string; args: string[]; options: { timeout: number; stdio: string[] } }[];

/** execFileSync's failure shape: the child's stderr rides on the error. */
const failed = (stderr: string) => Object.assign(new Error('Command failed'), { stderr: Buffer.from(stderr) });

beforeEach(() => {
  vi.clearAllMocks();
  enabled = false;
  queryFails = false;
  failedQueries = 0;
  userCanEnable = false;
  sudoCanEnable = false;
  succeedsWithoutEnabling = false;
  calls = [];
  vi.mocked(execFileSync).mockImplementation(((
    command: string,
    args: string[],
    options: { timeout: number; stdio: string[] },
  ) => {
    calls.push({ command, args, options });
    if (command === 'loginctl' && args[0] === 'show-user') {
      if (queryFails || failedQueries-- > 0) throw new Error('user state unavailable');
      return enabled ? 'yes\n' : 'no\n';
    }
    if (command === 'sudo') {
      if (!sudoCanEnable && !succeedsWithoutEnabling) throw failed('sudo: a password is required\n');
      if (sudoCanEnable) enabled = true;
    } else if (command === 'loginctl') {
      if (!userCanEnable && !succeedsWithoutEnabling) throw failed('Could not enable linger: Access denied\n');
      if (userCanEnable) enabled = true;
    }
    return '';
  }) as typeof execFileSync);
});

// Checked here, not in the mock: ensureUserLinger catches anything the mock throws.
afterEach(() => {
  for (const { command, args, options } of calls) {
    const call = `${command} ${args.join(' ')}`;
    expect(['loginctl', 'sudo'], call).toContain(command);
    expect(options.timeout, call).toBeGreaterThan(0);
    expect(options.timeout, call).toBeLessThanOrEqual(5_000);
    expect(options.stdio, call).toEqual(['ignore', 'pipe', 'pipe']);
    if (args[0] === 'show-user') continue;
    // A minimal system: enabling must neither spawn pkttyagent nor prompt for a sudo password.
    // Root's loginctl starts no agent, so sudo runs exactly the command the hint prints.
    if (command === 'sudo') expect(args, call).toEqual(['-n', 'loginctl', 'enable-linger', '1000']);
    else expect(args, call).toEqual(['--no-ask-password', 'enable-linger', '1000']);
  }
});

describe('verified systemd user linger', () => {
  it('only reads state when provisioning already enabled linger', () => {
    enabled = true;
    expect(ensureUserLinger(1000)).toBe(true);
    expect(calls).toMatchObject([{ command: 'loginctl', args: ['show-user', '1000', '--property=Linger', '--value'] }]);
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
    expect(log.warn).toHaveBeenCalledWith('sudo command failed', {
      command: 'loginctl enable-linger 1000',
      stderr: 'sudo: a password is required',
    });
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('may stop on logout'), {
      loginctl: 'Could not enable linger: Access denied',
      linger: 'off',
      hint: expect.stringContaining('sudo loginctl enable-linger 1000'),
    });
  });

  it('does not report success merely because enable-linger exited zero', () => {
    succeedsWithoutEnabling = true;
    expect(ensureUserLinger(1000)).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('may stop on logout'),
      expect.objectContaining({ loginctl: 'exited 0', linger: 'off' }),
    );
  });

  it('still tries sudo when enable-linger exits zero without enabling linger', () => {
    succeedsWithoutEnabling = true;
    sudoCanEnable = true;
    expect(ensureUserLinger(1000)).toBe(true);
    expect(calls.filter(({ command }) => command === 'sudo')).toHaveLength(1);
  });

  it('does not claim persistence if the final user state cannot be read', () => {
    queryFails = true;
    userCanEnable = true;
    sudoCanEnable = true;
    expect(ensureUserLinger(1000)).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('may stop on logout'),
      expect.objectContaining({ loginctl: 'exited 0', linger: 'Error: user state unavailable' }),
    );
  });

  it('reports the last state read, not an earlier failed one', () => {
    failedQueries = 1;
    expect(ensureUserLinger(1000)).toBe(false);
    expect(log.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('may stop on logout'),
      expect.objectContaining({ linger: 'off' }),
    );
  });
});
