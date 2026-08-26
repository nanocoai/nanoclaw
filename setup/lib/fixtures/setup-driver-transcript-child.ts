import fs from 'node:fs';
import net, { type Socket } from 'node:net';
import path from 'node:path';

import { PLUGIN_SCHEMA_URL } from '../../../src/templates/manifest.js';
import { NdjsonSetupDriver } from '../setup-driver.js';
import { fixtureSetupReceipt } from './setup-receipt.js';

const scenario = process.argv[2];
if (scenario !== 'standard' && scenario !== 'template-first-agent') {
  throw new Error('unknown production parity scenario');
}

const driver = new NdjsonSetupDriver('setup');
const auto = await import('../../auto.js');

if (scenario === 'standard') {
  await auto.runTemplateSetup(driver, false, false);
} else {
  // The production helper lists template carriers before creating one, which
  // reads the template's manifest from the local templates directory.
  const templateDir = path.join(process.cwd(), 'templates', 'sales', 'sdr');
  fs.mkdirSync(templateDir, { recursive: true });
  fs.writeFileSync(path.join(templateDir, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }));
  const socketPath = path.join(process.cwd(), 'data', 'ncl.sock');
  const requests: Array<{ command: string; args: Record<string, unknown> }> = [];
  const sockets = new Set<Socket>();
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        command: string;
        args: Record<string, unknown>;
      };
      requests.push({ command: request.command, args: request.args });
      const data =
        request.command === 'groups-create'
          ? {
              id: 'ag-template',
              name: 'SDR',
              folder: 'sdr',
              agent_provider: null,
              created_at: '2026-01-01T00:00:00.000Z',
            }
          : request.command === 'groups-list' || request.command === 'wirings-list'
            ? []
            : {};
      socket.end(`${JSON.stringify({ id: request.id, ok: true, data })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await auto.installSelectedTemplateAgent(driver, 'claude');
    if (process.env.NANOCLAW_TEST_REQUESTS) {
      fs.writeFileSync(process.env.NANOCLAW_TEST_REQUESTS, JSON.stringify(requests));
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

driver.completeSetup(fixtureSetupReceipt());
