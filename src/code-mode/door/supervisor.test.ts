/**
 * The door supervisor against a fake sshd (a small Node program that honours
 * `-t` and `-D -f <config>`): start waits for the port, a crash is restarted,
 * stop closes the pipe and the listener goes away, a bad config is refused.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveEntry } from './paths.js';
import { DoorSupervisor, type DoorLogLevel } from './supervisor.js';

const DIR = `/tmp/nanoclaw-door-sup-${process.pid}`;
const FAKE_SSHD = path.join(DIR, 'fake-sshd.mjs');
const CONFIG = path.join(DIR, 'sshd_config');
const PID_FILE = path.join(DIR, 'fake.pid');
const FAKE_SSHD_LAUNCHER = path.join(DIR, 'fake-sshd');

const FAKE = `
import fs from 'node:fs';
import net from 'node:net';
const args = process.argv.slice(2);
const config = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8');
if (args[0] === '-t') {
  if (/BAD/.test(config)) { process.stderr.write('bad config: BAD\\n'); process.exit(1); }
  process.exit(0);
}
const port = Number(/Port (\\d+)/.exec(config)[1]);
const server = net.createServer();
server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(PID_FILE)}, String(process.pid));
  process.stderr.write('Server listening on 127.0.0.1 port ' + port + '.\\n');
});
process.on('SIGTERM', () => process.exit(0));
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let port: number;
let logs: { level: DoorLogLevel; message: string }[];
let supervisor: DoorSupervisor | undefined;

beforeEach(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FAKE_SSHD, FAKE);
  // The wrapper runs `<sshd> -D -e -f <config>`; the launcher makes the fake
  // script look like an sshd binary.
  fs.writeFileSync(FAKE_SSHD_LAUNCHER, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SSHD}" "$@"\n`, { mode: 0o755 });
  port = await freePort();
  fs.writeFileSync(CONFIG, `Port ${port}\n`);
  logs = [];
  supervisor = new DoorSupervisor({
    sshd: FAKE_SSHD_LAUNCHER,
    configFile: CONFIG,
    port,
    wrapper: resolveEntry('sshd-wrapper'),
    log: (level, message) => logs.push({ level, message }),
    maxRestarts: 2,
    readyTimeoutMs: 8000,
  });
});

afterEach(async () => {
  await supervisor?.stop();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe('DoorSupervisor', () => {
  it('starts the server, restarts it after a crash, and stops it with the pipe', async () => {
    await supervisor!.start();
    expect(supervisor!.status().running).toBe(true);
    expect(await probe(port)).toBe(true);
    await until(() => fs.existsSync(PID_FILE));
    const firstPid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    expect(logs.some((l) => l.message === 'sshd')).toBe(true);

    // Crash the server itself: the wrapper exits, the supervisor restarts.
    fs.rmSync(PID_FILE);
    process.kill(firstPid, 'SIGKILL');
    await until(() => fs.existsSync(PID_FILE) && Number(fs.readFileSync(PID_FILE, 'utf8')) !== firstPid);
    await until(() => probe(port));
    expect(supervisor!.status().restarts).toBe(1);
    expect(supervisor!.status().lastExit?.code).not.toBe(0);
    expect(logs.some((l) => l.level === 'warn' && /restarting/.test(l.message))).toBe(true);

    await supervisor!.stop();
    expect(supervisor!.status().running).toBe(false);
    await until(async () => !(await probe(port)));
  }, 20_000);

  it('refuses a configuration sshd -t rejects, and reports the server’s own words', async () => {
    fs.writeFileSync(CONFIG, `Port ${port}\nBAD\n`);
    await expect(supervisor!.start()).rejects.toThrow(/rejected the door configuration.*bad config: BAD/s);
    expect(supervisor!.status().running).toBe(false);
  });
});
