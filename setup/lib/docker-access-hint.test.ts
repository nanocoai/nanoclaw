import { describe, expect, it } from 'vitest';

import { dockerAccessHint } from './docker-access-hint.js';

const unit = 'nanoclaw-v2-0123abcd';
const linux = { wsl: false, apt: true };
const stale = { DOCKER_GROUP_STALE: 'true', PROJECT_PATH: '/home/nc/nanoclaw' };
const clearBackoff = "rm -f '/home/nc/nanoclaw/data/circuit-breaker.json'";
const fix = ['sudo setfacl -m u:$(whoami):rw /var/run/docker.sock', clearBackoff, `systemctl --user restart ${unit}`];

describe('dockerAccessHint', () => {
  it.each([
    ['says nothing when the service reaches Docker', { STATUS: 'success' }, linux, null],
    [
      'installs acl first when setfacl is missing',
      { ...stale, SETFACL_MISSING: 'true' },
      linux,
      ['sudo apt-get install -y acl', ...fix],
    ],
    ['skips the acl install when setfacl is there', stale, linux, fix],
    [
      'names the acl package where there is no apt',
      { ...stale, SETFACL_MISSING: 'true' },
      { wsl: false, apt: false },
      ['# first install the acl package (it provides setfacl)', ...fix],
    ],
  ])('%s', (_name, fields, host, commands) => {
    const hint = dockerAccessHint(fields, unit, host);
    expect(hint && hint.commands).toEqual(commands);
    expect(hint?.title).toBe(commands ? "NanoClaw can't reach Docker yet. To fix it now, run:" : undefined);
  });

  it('keeps a quote in the checkout path literal, and still prints the line with no path', () => {
    const quoted = dockerAccessHint({ ...stale, PROJECT_PATH: "/home/nc/my 'claw" }, unit, linux)!;
    expect(quoted.commands).toContain(`rm -f '/home/nc/my '\\''claw/data/circuit-breaker.json'`);
    const unknown = dockerAccessHint({ DOCKER_GROUP_STALE: 'true' }, unit, linux)!;
    expect(unknown.commands).toContain("rm -f 'data/circuit-breaker.json'");
  });

  it('names a reboot as the lasting fix, or wsl --shutdown on WSL, and never a re-login', () => {
    const plain = dockerAccessHint(stale, unit, linux)!;
    const wsl = dockerAccessHint(stale, unit, { wsl: true, apt: true })!;
    expect(plain.note).toMatch(/reboot/i);
    expect(wsl.note).toContain('wsl --shutdown');
    expect(wsl.note).toMatch(/PowerShell/);
    for (const note of [plain.note, wsl.note]) expect(note).not.toMatch(/log (out|in)/i);
  });
});
