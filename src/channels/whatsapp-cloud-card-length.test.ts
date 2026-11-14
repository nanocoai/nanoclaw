/**
 * WhatsApp Cloud card limit against the real @chat-adapter/whatsapp: only
 * fetch is stubbed, so the test sees the exact messages the adapter sends. A
 * card with reply buttons is an interactive message whose 1,024-character body
 * the adapter cuts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WHATSAPP_ACCESS_TOKEN: 'test-access-token',
    WHATSAPP_PHONE_NUMBER_ID: 'test-phone-number-id',
    WHATSAPP_APP_SECRET: 'test-app-secret',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  }),
}));

import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from '../gateway-providers/gateway-provider-registry.js';
import type { ChannelAdapter } from './adapter.js';
import { CardTooLongError } from './ask-question.js';
import { whatsappCloudRegistration } from './whatsapp-cloud.js';

interface Sent {
  type?: string;
  text?: { body: string };
  interactive?: { header?: { text: string }; body: { text: string } };
}

const sent: Sent[] = [];

vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 });
  }),
);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sent.length = 0;
});

/** The review case: a 572-character resource and six 600-character details. */
function longGatewayCard() {
  const summary = {
    agent: 'agent',
    action: 'Post a comment',
    resource: 'POST api.example.com/' + 'r'.repeat(551),
    reason: 'The gateway policy requires human approval for this request.',
    details: Array.from({ length: 6 }, (_, i) => ({ label: `Field ${i}`, value: `D${i}${'v'.repeat(596)}E${i}` })),
  };
  return gatewayApprovalPresentation({ title: 'Credentials Request', question: '', summary } as GatewayApprovalRequest);
}

describe('WhatsApp Cloud card limit through the bridge', () => {
  let bridge: ChannelAdapter;
  const ask = async (title: string, question: string) => {
    bridge ??= (await whatsappCloudRegistration.factory())!;
    return bridge.deliver('whatsapp:test-phone-number-id:15550001111', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-long-1',
        title,
        question,
        options: [{ label: 'Approve', style: 'primary' }, { label: 'Reject' }],
      },
    });
  };

  it('sends a card at the limit whole, with its buttons', async () => {
    await ask('Approve', 'x'.repeat(1017));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('interactive');
    expect(sent[0].interactive!.body.text).toBe('x'.repeat(1017));
  });

  it('refuses a card one character longer and sends nothing', async () => {
    await expect(ask('Approve', 'x'.repeat(1018))).rejects.toBeInstanceOf(CardTooLongError);
    expect(sent).toHaveLength(0);
  });

  it('refuses a long gateway card instead of cutting it', async () => {
    const { title, question } = longGatewayCard();
    await expect(ask(title, question)).rejects.toBeInstanceOf(CardTooLongError);
    expect(sent).toHaveLength(0);
  });
});
