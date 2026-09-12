import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** Query the live host, with a deadline even for an unresponsive socket. */
export function queryHost(root, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(join(root, 'data/ncl.sock'));
    let buffer = '';
    const timer = setTimeout(() => done(new Error('Host status timed out')), timeoutMs);
    function done(error, status) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(status);
    }
    socket.once('error', (error) => done(error));
    socket.once('end', () => done(new Error('Host closed without a status response')));
    socket.once('connect', () => socket.write(JSON.stringify({ id, command: 'status', args: {} }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 65536) return done(new Error('Invalid host status response'));
      if (!buffer.includes('\n')) return;
      try {
        const frame = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        const status = frame.data;
        if (
          frame.id !== id ||
          frame.ok !== true ||
          !Number.isInteger(status?.pid) ||
          status.pid <= 0 ||
          typeof status.instance_id !== 'string' ||
          !status.instance_id ||
          status.project_root !== realpathSync(root) ||
          !Array.isArray(status.channels)
        ) {
          throw new Error('Host status does not identify this running installation');
        }
        done(null, status);
      } catch (error) {
        done(error);
      }
    });
  });
}

/** Wait for an identified host; optionally demand a new instance or channel. */
export async function waitForHost(root, { previous = '', pid, channel, alive, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let reason = 'Host did not respond';
  while (Date.now() < deadline) {
    if (alive && !alive()) throw new Error('NanoClaw exited before becoming ready. Check logs/nanoclaw.error.log.');
    try {
      const status = await queryHost(root, Math.min(1000, deadline - Date.now()));
      if (status.instance_id === previous) reason = 'The previous host is still serving requests';
      else if (pid && status.pid !== pid) reason = 'A different process is serving requests';
      else if (channel && !status.channels.some((c) => c.instance === channel && c.connected === true)) {
        reason = `Channel ${channel} is not connected in the running host`;
      } else return status;
    } catch (error) {
      reason = error.message;
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${reason}. Check logs/nanoclaw.error.log.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, root, ...args] = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  try {
    if (mode === 'snapshot') {
      console.log((await queryHost(root)).instance_id);
    } else if (mode === 'wait') {
      const timeoutMs = Number(process.env.NANOCLAW_READY_TIMEOUT_MS ?? 30000);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid readiness timeout');
      const status = await waitForHost(root, {
        previous: args.includes('--previous') ? value('--previous') : '',
        pid: args.includes('--pid') ? Number(value('--pid')) : undefined,
        channel: args.includes('--channel') ? value('--channel') : undefined,
        timeoutMs,
      });
      console.log(`NanoClaw is ready (PID ${status.pid}).`);
    } else
      throw new Error(
        'Usage: host-status.mjs snapshot|wait <project-root> [--previous <instance>] [--pid <pid>] [--channel <instance>]',
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
