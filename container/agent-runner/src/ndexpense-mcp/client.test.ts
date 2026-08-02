import { describe, expect, test } from 'bun:test';

import { NdExpenseClient, routeFor } from './client.js';
import { parseToolInput } from './contracts.js';
import { redactError } from './redaction.js';

describe('routeFor', () => {
  test('maps every tool to an allowlisted backend route', () => {
    expect(routeFor('submit_text_expense', {})).toEqual({ method: 'POST', path: '/v1/agent/intakes' });
    expect(routeFor('submit_receipt_media', {})).toEqual({ method: 'POST', path: '/v1/agent/intakes' });
    expect(routeFor('get_pending_intakes', {})).toEqual({ method: 'GET', path: '/v1/agent/intakes/pending' });
    expect(routeFor('clarify_intake', { intakeId: 'i 1' })).toEqual({
      method: 'POST',
      path: '/v1/agent/intakes/i%201/clarify',
    });
    expect(routeFor('update_receipt', { receiptId: 'r1' })).toEqual({ method: 'PATCH', path: '/v1/agent/receipts/r1' });
    expect(routeFor('trash_receipt', { receiptId: 'r1' })).toEqual({
      method: 'POST',
      path: '/v1/agent/receipts/r1/trash',
    });
    expect(routeFor('restore_receipt', { receiptId: 'r1' })).toEqual({
      method: 'POST',
      path: '/v1/agent/receipts/r1/restore',
    });
    expect(routeFor('list_recent_receipts', {})).toEqual({ method: 'GET', path: '/v1/agent/receipts/recent' });
    expect(routeFor('get_spending_summary', {})).toEqual({ method: 'GET', path: '/v1/agent/reports/spending' });
  });
});

describe('contracts', () => {
  test('rejects model-supplied identity, URL, and unknown fields', () => {
    expect(() =>
      parseToolInput('submit_text_expense', {
        sourceKey: 'm1',
        text: 'expense: tea 20',
        userId: 'other',
      }),
    ).toThrow();
    expect(() =>
      parseToolInput('trash_receipt', {
        receiptId: 'r1',
        url: 'https://evil.invalid',
      }),
    ).toThrow();
  });
});

describe('NdExpenseClient', () => {
  test('sets safe request headers but never Authorization', async () => {
    let request: Request | undefined;
    const client = new NdExpenseClient('http://127.0.0.1:8787', {
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ success: true, data: { status: 'saved' } });
      },
    });

    await client.call('submit_text_expense', {
      sourceKey: 'message-1',
      text: 'expense: coffee 35',
    });

    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get('x-request-id')).toBeTruthy();
    expect(request?.headers.get('idempotency-key')).toBeTruthy();
    expect(request?.headers.has('authorization')).toBe(false);
  });

  test('retries GET requests on 429 and 5xx with capped delay', async () => {
    const statuses = [429, 503, 200];
    const delays: number[] = [];
    const client = new NdExpenseClient('http://127.0.0.1:8787', {
      fetch: async () =>
        Response.json(statuses[0] === 200 ? { success: true, data: [] } : { success: false }, {
          status: statuses.shift()!,
        }),
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 1,
    });

    expect(await client.call('get_pending_intakes', {})).toEqual([]);
    expect(delays).toEqual([250, 500]);
  });

  test('does not retry an ambiguous mutation without an idempotent source key', async () => {
    let attempts = 0;
    const client = new NdExpenseClient('http://127.0.0.1:8787', {
      fetch: async () => {
        attempts += 1;
        throw new TypeError('network failed');
      },
      sleep: async () => {},
    });

    await expect(client.call('trash_receipt', { receiptId: 'r1' })).rejects.toThrow('request failed');
    expect(attempts).toBe(1);
  });

  test('retries a submission only when it reuses the same source key', async () => {
    let attempts = 0;
    const client = new NdExpenseClient('http://127.0.0.1:8787', {
      fetch: async () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError('network failed');
        return Response.json({ success: true, data: { status: 'saved' } });
      },
      sleep: async () => {},
    });

    await client.call('submit_text_expense', { sourceKey: 'same-message', text: 'expense: tea 20' });
    expect(attempts).toBe(3);
  });

  test('enforces connect and total deadlines', async () => {
    const hangingFetch: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const connectClient = new NdExpenseClient('http://127.0.0.1:8787', {
      fetch: hangingFetch,
      sleep: async () => {},
      connectTimeoutMs: 2,
      totalTimeoutMs: 100,
    });
    await expect(connectClient.call('trash_receipt', { receiptId: 'r1' })).rejects.toThrow('connect deadline');

    const totalClient = new NdExpenseClient('http://127.0.0.1:8787', {
      fetch: hangingFetch,
      sleep: async () => {},
      connectTimeoutMs: 100,
      totalTimeoutMs: 2,
    });
    await expect(totalClient.call('get_pending_intakes', {})).rejects.toThrow('total deadline');
  });

  test('rejects non-HTTPS remote base URLs', () => {
    expect(() => new NdExpenseClient('http://example.com')).toThrow('HTTPS');
  });
});

test('redactError removes credentials and sensitive bodies', () => {
  const message = redactError(
    new Error('Authorization: Bearer nde_live_secret body={"text":"private receipt"} /workspace/downloads/a.pdf'),
  );
  expect(message).not.toContain('nde_live_secret');
  expect(message).not.toContain('private receipt');
  expect(message).not.toContain('/workspace/downloads/a.pdf');
});
