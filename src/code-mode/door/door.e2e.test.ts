/**
 * The real OpenSSH client against the in-process door, when `ssh` and
 * `ssh-keygen` exist on this machine. The client connects the way the
 * account link's pipe does — from a chosen loopback source port (a small
 * ProxyCommand) that a stream was registered for — under a username that
 * means nothing here. An unknown key gets the waiting room, an approval on
 * the host releases it into the landing, which creates the account's
 * default sandbox through the real `sandboxes new` path against a fake
 * container driver whose "attach" prints a marker. Then `ssh … ls` lists,
 * and password authentication is refused. Skips cleanly without the tools.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/nanoclaw-door-e2e-${process.pid}`);

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, DATA_DIR: `${ROOT}/data`, GROUPS_DIR: `${ROOT}/groups` };
});
vi.mock('../../container-runner.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../container-runner.js')>();
  return { ...orig, wakeContainer: vi.fn(async (): Promise<boolean> => false) };
});
vi.mock('../../drivers/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../drivers/index.js')>();
  return { ...orig, getSessionDriver: vi.fn() };
});

import { wakeContainer } from '../../container-runner.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getSessionDriver } from '../../drivers/index.js';
import type { SessionEventsDriver } from '../../drivers/session-events.js';
import type { SessionHandle, SessionStatus } from '../../drivers/types.js';
import type { Session } from '../../types.js';
// Registers the sandbox verbs and the code-mode migrations the landing uses.
import '../../cli/resources/sandboxes.js';
import '../index.js';
import { approveDoorKey, disableDoor, doorStatus, enableDoor, listDoorKeys, registerTarget } from './index.js';

const hasTools = ['ssh', 'ssh-keygen'].every((tool) => {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
});

/** The fake driver's attach: a shell that prints a marker and exits. */
function handleFor(agentGroupId: string, sessionId: string, name: string): SessionHandle {
  return {
    key: { installSlug: 'test-install', agentGroupId, sessionId },
    name,
    start: async () => {},
    status: async () => ({ phase: 'running' }) as SessionStatus,
    stop: async () => {},
    execSpec: () => ({
      bin: '/bin/sh',
      argsTty: ['-c', 'printf "LANDED-TTY %s in %s\\n" "$1" "$(tty)"', 'sh', name],
      argsPlain: ['-c', 'printf "LANDED-PLAIN %s\\n" "$1"', 'sh', name],
    }),
  };
}

function installDriver(handles: SessionHandle[]): void {
  const driver = {
    kind: 'fake-container',
    listSessions: vi.fn(async () => handles.map((handle) => ({ handle, phase: 'running' as const }))),
    watchSessions: () => ({ stop: () => {} }),
  } as unknown as SessionEventsDriver;
  vi.mocked(getSessionDriver).mockReturnValue(driver);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const PROXY = `
const net = require('node:net');
const [port, localPort] = process.argv.slice(2).map(Number);
const socket = net.connect({ host: '127.0.0.1', port, localAddress: '127.0.0.1', localPort });
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on('close', () => process.exit(0));
socket.on('error', (error) => { process.stderr.write(String(error) + '\\n'); process.exit(1); });
`;

interface Run {
  output: string;
  code: number | null;
}

describe.skipIf(!hasTools)('door e2e (real ssh client)', () => {
  const clientKey = path.join(ROOT, 'client_ed25519');
  const proxy = path.join(ROOT, 'proxy.cjs');
  let doorPort: number;

  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(`${ROOT}/groups`, { recursive: true, mode: 0o700 });
    fs.writeFileSync(proxy, PROXY);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'e2e', '-f', clientKey]);
    await runMigrations(await initTestDb());
    installDriver([]);
    vi.mocked(wakeContainer).mockImplementation(async (session: Session) => {
      installDriver([handleFor(session.agent_group_id, session.id, `ncl-${session.id}`)]);
      return true;
    });
  });

  afterAll(async () => {
    await disableDoor();
    await closeDb();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  /** Connect from a fresh registered source port; resolves when ssh exits. */
  function ssh(
    args: string[],
    {
      target = { account: 'e2e-box' },
      onOutput,
    }: { target?: { account: string; sandbox?: string }; onOutput?: (text: string) => void | Promise<void> } = {},
  ): Promise<Run> & { kill: () => void } {
    let output = '';
    let child: ReturnType<typeof spawn> | undefined;
    const done = (async (): Promise<Run> => {
      const localPort = await freePort();
      registerTarget(localPort, { target, source: { ip: '203.0.113.5', port: 4242 }, stream: 'e2e' });
      child = spawn('ssh', [
        '-o',
        `ProxyCommand=${process.execPath} ${proxy} ${doorPort} ${localPort}`,
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
        ...args,
      ]);
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        void onOutput?.(output);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        void onOutput?.(output);
      });
      const code = await new Promise<number | null>((resolve) => child!.on('exit', (c) => resolve(c)));
      return { output, code };
    })();
    return Object.assign(done, { kill: () => child?.kill() });
  }

  it('admits an unknown key to the waiting room and lands it after approval, under any username', async () => {
    const enabled = await enableDoor({ name: 'e2e-box' });
    expect(enabled.enabled).toBe(true);
    expect(enabled.door.running).toBe(true);
    expect(enabled.hostKeyFingerprint).toMatch(/^SHA256:/);
    doorPort = enabled.doorPort!;

    const fingerprint = execFileSync('ssh-keygen', ['-lf', `${clientKey}.pub`], { encoding: 'utf8' }).split(' ')[1];
    let approved = false;
    const run = ssh(['-tt', 'someone-else@127.0.0.1'], {
      onOutput: async (text) => {
        if (approved || !/not approved for remote access yet/.test(text)) return;
        approved = true;
        expect((await listDoorKeys()).pending.map((k) => k.fingerprint)).toEqual([fingerprint]);
        expect((await doorStatus()).door).toMatchObject({ running: true, sessions: 1 });
        await approveDoorKey(fingerprint, 'e2e');
      },
    });
    const result = await run;
    expect(result.output).toContain(`key    ${fingerprint}`);
    expect(result.output).toContain('from   203.0.113.5');
    expect(result.output).toContain('Approved. Connecting');
    expect(result.output).toContain('Creating sandbox e2e-box');
    // The fake driver names its container after the session; the marker proves the attach ran on a real terminal.
    expect(result.output).toMatch(/LANDED-TTY ncl-sess-\S+ in \/dev\//);
    expect(result.code).toBe(0);
    expect((await listDoorKeys()).approved.map((k) => k.label)).toEqual(['e2e']);
  }, 60_000);

  it('lists sandboxes for `ssh … ls`, attaches the existing default without a TTY, and refuses passwords', async () => {
    const listing = await ssh(['-T', 'x@127.0.0.1', 'ls']);
    expect(listing.code).toBe(0);
    expect(listing.output).toContain('e2e-box');

    const plain = await ssh(['-T', 'y@127.0.0.1']);
    expect(plain.output).toContain('Attaching to sandbox e2e-box');
    expect(plain.output).toMatch(/LANDED-PLAIN ncl-sess-/);
    expect(plain.code).toBe(0);

    const denied = await ssh([
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'PasswordAuthentication=yes',
      '-o',
      'BatchMode=yes',
      'z@127.0.0.1',
    ]);
    expect(denied.code).toBe(255);
    expect(denied.output).toMatch(/Permission denied|no supported authentication methods/i);

    const off = await disableDoor();
    expect(off.door.running).toBe(false);
  }, 60_000);
});
