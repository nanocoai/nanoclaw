import { describe, expect, it } from 'vitest';

import { dockerAccessHint } from './docker-access-hint.js';

const unit = 'nanoclaw-v2-0123abcd';
const linux = { wsl: false, apt: true };
const stale = { DOCKER_GROUP_STALE: 'true', PROJECT_PATH: '/home/nc/nanoclaw' };
const clearBackoff = 'rm -f /home/nc/nanoclaw/data/circuit-breaker.json';

describe('dockerAccessHint', () => {
  it('says nothing when the service reaches Docker', () => {
    expect(dockerAccessHint({ STATUS: 'success' }, unit, linux)).toBeNull();
  });

  it('installs acl first when setfacl is missing', () => {
    const hint = dockerAccessHint({ ...stale, SETFACL_MISSING: 'true' }, unit, linux);
    expect(hint?.title).toMatch(/To fix it now, run:$/);
    expect(hint?.commands).toEqual([
      'sudo apt-get install -y acl',
      'sudo setfacl -m u:$(whoami):rw /var/run/docker.sock',
      clearBackoff,
      `systemctl --user restart ${unit}`,
    ]);
  });

  it('skips the acl install when setfacl is already there', () => {
    const hint = dockerAccessHint(stale, unit, linux);
    expect(hint?.commands).toEqual([
      'sudo setfacl -m u:$(whoami):rw /var/run/docker.sock',
      clearBackoff,
      `systemctl --user restart ${unit}`,
    ]);
  });

  it('clears the crash backoff of the checkout the service runs from', () => {
    const spaced = dockerAccessHint({ ...stale, PROJECT_PATH: "/home/nc/my 'claw" }, unit, linux)!;
    expect(spaced.commands).toContain(`rm -f '/home/nc/my '\\''claw/data/circuit-breaker.json'`);
    const unknown = dockerAccessHint({ DOCKER_GROUP_STALE: 'true' }, unit, linux)!;
    expect(unknown.commands).toContain('rm -f data/circuit-breaker.json');
  });

  it('does not print an apt-get line on systems without apt', () => {
    const hint = dockerAccessHint({ ...stale, SETFACL_MISSING: 'true' }, unit, { wsl: false, apt: false });
    expect(hint?.commands.join('\n')).not.toContain('apt-get');
    expect(hint?.commands[0]).toMatch(/acl package/);
  });

  it('points at the service, not setfacl again, when the ACL was applied and Docker is still out of reach', () => {
    const applied = { ...stale, DOCKER_ACL_APPLIED: 'true' };
    const plain = dockerAccessHint(applied, unit, linux)!;
    expect(plain.title).not.toMatch(/fix it/i);
    expect(plain.commands).toEqual([`systemctl --user status ${unit}`, `journalctl --user -u ${unit} -n 50`]);
    expect(plain.note).toContain('logs/nanoclaw.error.log');
    expect(plain.note).toMatch(/reboot/i);
    const wsl = dockerAccessHint(applied, unit, { wsl: true, apt: true })!;
    expect(wsl.note).toContain('wsl --shutdown');
  });

  it('names a reboot as the lasting fix, or wsl --shutdown on WSL, and never a re-login', () => {
    const plain = dockerAccessHint(stale, unit, linux)!;
    const wsl = dockerAccessHint(stale, unit, { wsl: true, apt: true })!;
    const applied = dockerAccessHint({ ...stale, DOCKER_ACL_APPLIED: 'true' }, unit, linux)!;
    expect(plain.note).toMatch(/reboot/i);
    expect(wsl.note).toContain('wsl --shutdown');
    expect(wsl.note).toMatch(/PowerShell/);
    for (const note of [plain.note, wsl.note, applied.note]) expect(note).not.toMatch(/log (out|in)/i);
  });
});
