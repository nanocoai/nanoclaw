import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';

import {
  AcceptanceFailure,
  PlayboxEventClient,
  assertUniqueReceiptSources,
  redactDiagnostic,
} from './verify-expense-agent';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function fakeSse(frames: string[]): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': connected\n\n');
    for (const frame of frames) response.write(`data: ${frame}\n\n`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  return `http://127.0.0.1:${address.port}`;
}

describe('playbox acceptance primitives', () => {
  test('correlates delivery by immutable message ID through unrelated and out-of-order events', async () => {
    const baseUrl = await fakeSse([
      JSON.stringify({ type: 'typing', active: true }),
      JSON.stringify({ type: 'delivery', inboundId: 'other-message', state: 'accepted' }),
      JSON.stringify({ type: 'outbound', id: 'noise', text: 'unrelated', files: [] }),
      JSON.stringify({ type: 'delivery', inboundId: 'wanted-message', state: 'accepted' }),
    ]);
    const events = new PlayboxEventClient(baseUrl, 1_000);
    await events.connect();
    await expect(events.waitForDelivery('wanted-message')).resolves.toEqual({
      type: 'delivery',
      inboundId: 'wanted-message',
      state: 'accepted',
    });
    events.close();
  });

  test('enforces the scenario deadline', async () => {
    const baseUrl = await fakeSse([]);
    const events = new PlayboxEventClient(baseUrl, 20);
    await events.connect();
    await expect(events.waitForDelivery('never')).rejects.toBeInstanceOf(AcceptanceFailure);
    events.close();
  });

  test('redacts request bodies, credentials, message IDs, and receipt IDs from diagnostics', () => {
    const redacted = redactDiagnostic(
      'Authorization: Bearer top-secret body=coffee messageId=msg-private receiptId=receipt-private',
    );
    expect(redacted).not.toContain('top-secret');
    expect(redacted).not.toContain('coffee');
    expect(redacted).not.toContain('msg-private');
    expect(redacted).not.toContain('receipt-private');
    expect(redacted).toContain('[REDACTED]');
  });

  test('fails when a source key maps to duplicate backend receipt rows', () => {
    expect(() =>
      assertUniqueReceiptSources([
        { sourceKey: 'message-1', receiptId: 'receipt-1' },
        { sourceKey: 'message-1', receiptId: 'receipt-2' },
      ]),
    ).toThrow(AcceptanceFailure);
  });
});
