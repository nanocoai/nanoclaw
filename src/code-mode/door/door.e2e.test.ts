/**
 * One real OpenSSH round trip through the door, when an sshd binary exists
 * on this machine: enable on a loopback port, connect with a fresh key,
 * observe the waiting-room banner, approve the key, watch the connection
 * hand over to the landing program (which refuses: no relayed target), and
 * disable. Skips cleanly without sshd.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/nanoclaw-door-e2e-${process.pid}`);

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, DATA_DIR: `${ROOT}/data`, GROUPS_DIR: `${ROOT}/groups` };
});

import { approveDoorKey, disableDoor, doorStatus, enableDoor, findSshd, listDoorKeys } from './index.js';

const sshd = findSshd();
const hasTools =
  Boolean(sshd) &&
  ['ssh', 'ssh-keygen'].every((tool) => {
    try {
      execFileSync('which', [tool], { stdio: 'ignore' });
      return true;
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  });

describe.skipIf(!hasTools)('door e2e (real sshd)', () => {
  const clientKey = path.join(ROOT, 'client_ed25519');
  let port: number;

  beforeAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'e2e', '-f', clientKey]);
  });

  afterAll(async () => {
    await disableDoor();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('admits an unknown key to the waiting room and releases it to the landing on approval', async () => {
    const enabled = await enableDoor({ name: 'e2e-box' });
    expect(enabled.enabled).toBe(true);
    expect(enabled.door.running).toBe(true);
    expect(enabled.hostKeyFingerprint).toMatch(/^SHA256:/);
    port = enabled.port!;
    expect((await doorStatus()).door.running).toBe(true);

    const ssh = spawn(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'LogLevel=ERROR',
        '-i',
        clientKey,
        '-p',
        String(port),
        '-tt',
        '127.0.0.1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    ssh.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    ssh.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exit = new Promise<number | null>((resolve) => ssh.on('exit', (code) => resolve(code)));

    const waitFor = async (pattern: RegExp, ms: number): Promise<void> => {
      const deadline = Date.now() + ms;
      while (!pattern.test(output)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; output so far:\n${output}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    await waitFor(/not approved for remote access yet/, 30_000);
    const clientPub = fs.readFileSync(`${clientKey}.pub`, 'utf8');
    const expectedFingerprint = execFileSync('ssh-keygen', ['-lf', `${clientKey}.pub`], { encoding: 'utf8' }).split(
      ' ',
    )[1];
    expect(output).toContain(expectedFingerprint);
    expect(output).toContain('from   remote');
    expect(output).toContain(enabled.approvalUrl);

    const pending = (await listDoorKeys()).pending;
    expect(pending.map((k) => k.fingerprint)).toEqual([expectedFingerprint]);
    expect(pending[0].publicKey).toBe(clientPub.split(' ').slice(0, 2).join(' '));

    await approveDoorKey(expectedFingerprint, 'e2e');
    await waitFor(/Approved\. Connecting/, 10_000);
    // No relayed stream registered this connection's source port: the landing refuses.
    await waitFor(/no target/, 20_000);
    expect(await exit).not.toBe(0);
    ssh.kill();

    const off = await disableDoor();
    expect(off.enabled).toBe(false);
    expect(off.door.running).toBe(false);
    expect((await listDoorKeys()).approved.map((k) => k.label)).toEqual(['e2e']);
  }, 90_000);
});
