import { describe, expect, it } from 'vitest';
import { PassThrough } from 'stream';
import { inspect } from 'util';

import type { ApprovalEvent } from './approval-contract.js';
import {
  ApprovalTransportUnavailable,
  HttpsGatewayApprovalTransport,
  readBoundedJsonResponse,
  SseApprovalParser,
} from './approval-transport.js';

describe('approval SSE parsing', () => {
  it('preserves a multibyte Unicode codepoint split across Buffer chunks', () => {
    const frame = Buffer.from(sseFrame(requestedEvent('shape 🔒 only')));
    const lock = Buffer.from('🔒');
    const start = frame.indexOf(lock);
    expect(start).toBeGreaterThan(0);

    const parser = new SseApprovalParser('deployment-1');
    expect(parser.push(frame.subarray(0, start + 2))).toEqual([]);
    const events = parser.push(frame.subarray(start + 2));
    expect(events).toHaveLength(1);
    expect(events[0]!.approval.presentation.fields[0]).toEqual({
      label: 'Message',
      kind: 'long_text',
      value: 'shape 🔒 only',
    });
    expect(parser.finish()).toEqual([]);
  });

  it('rejects an oversized complete frame before parsing it', () => {
    const parser = new SseApprovalParser('deployment-1');
    const oversizedHeartbeat = Buffer.from(`: ${'x'.repeat(66 * 1024)}\n\n`);
    expect(() => parser.push(oversizedHeartbeat)).toThrow(ApprovalTransportUnavailable);
  });

  it('accepts 64 KiB of event JSON framing but rejects one byte more', () => {
    const exactPayload = `"${'x'.repeat(64 * 1024 - 2)}"`;
    const overPayload = `"${'x'.repeat(64 * 1024 - 1)}"`;
    expect(Buffer.byteLength(exactPayload)).toBe(64 * 1024);
    expect(Buffer.byteLength(overPayload)).toBe(64 * 1024 + 1);

    const exact = new SseApprovalParser('deployment-1');
    expect(() => exact.push(Buffer.from(`event: approval\nid: 1\ndata: ${exactPayload}\n\n`))).toThrow(
      'approval event is not an object',
    );

    const over = new SseApprovalParser('deployment-1');
    expect(() => over.push(Buffer.from(`event: approval\nid: 1\ndata: ${overPayload}\n\n`))).toThrowError(
      expect.objectContaining({ code: 'sse_payload' }),
    );
  });

  it('bounds a JSON response body that stalls after headers', async () => {
    const response = new PassThrough() as unknown as import('http').IncomingMessage;
    const reading = readBoundedJsonResponse(response, 1024, 20);
    await expect(reading).rejects.toMatchObject({ code: 'response_timeout' });
    expect(response.destroyed).toBe(true);
  });

  it('rejects user information in the configured control origin', () => {
    expect(
      () =>
        new HttpsGatewayApprovalTransport({
          deploymentId: 'deployment-1',
          controlUrl: 'https://user:secret@gateway.example.com',
          controlServerName: 'gateway.example.com',
          gatewayCaPath: '/not-read/ca.pem',
          deploymentCertificatePath: '/not-read/certificate.pem',
          deploymentPrivateKeyPath: '/not-read/private-key.pem',
        }),
    ).toThrow('NanoCo Gateway control URL must be an HTTPS origin');
  });

  it('does not expose a malformed control URL in configuration errors', () => {
    const secretLikeUrl = 'https://[secret-token.example';
    let failure: unknown;
    try {
      new HttpsGatewayApprovalTransport({
        deploymentId: 'deployment-1',
        controlUrl: secretLikeUrl,
        controlServerName: 'gateway.example.com',
        gatewayCaPath: '/not-read/ca.pem',
        deploymentCertificatePath: '/not-read/certificate.pem',
        deploymentPrivateKeyPath: '/not-read/private-key.pem',
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ message: 'NanoCo Gateway control URL must be an HTTPS origin' });
    expect(String(failure)).not.toContain('secret-token');
    expect(inspect(failure)).not.toContain('secret-token');
  });
});

function requestedEvent(message: string): ApprovalEvent {
  return {
    version: 'nanoco.approval.v2',
    eventId: 1,
    gatewayEpoch: 'gw_0123456789abcdef0123456789abcdef',
    type: 'approval_requested',
    approval: {
      approvalId: 'ask_0123456789abcdef0123456789abcdef',
      requestDigest: '01'.repeat(32),
      deadline: '2099-07-23T00:00:00.000Z',
      lineage: {
        requestId: 77,
        deploymentId: 'deployment-1',
        agentId: 'agent-1',
        sessionId: 'session-1',
        containerInstanceId: 'container-1',
        channelId: 'channel-1',
      },
      approver: { issuer: 'https://idp.example.com', subject: 'stable-idp-subject' },
      policy: { policyVersion: 'policy-v7', matchedPolicyIds: ['ask-production'] },
      summary: {
        method: 'POST',
        origin: 'https://api.example.com:443',
        path: '/v1/action',
      },
      presentation: {
        appId: 'gmail',
        appLabel: 'Gmail',
        operationId: 'gmail:send-email',
        title: 'Send email',
        description: 'Send a new email on the user\'s behalf.',
        class: 'write',
        fields: [{ label: 'Message', kind: 'long_text', value: message }],
      },
    },
  };
}

function sseFrame(event: ApprovalEvent): string {
  return `id: ${event.eventId}\nevent: approval\ndata: ${JSON.stringify(event)}\n\n`;
}
