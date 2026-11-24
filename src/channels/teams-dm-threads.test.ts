import { describe, expect, it } from 'vitest';

import { dmThreadRoot, installTeamsDmThreads, splitDmThreadConversationId } from './teams.js';

const DM = 'a:1dEjSEbe';
const CHAT = '19:user_bot@unq.gbl.spaces';

function dmActivity(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id: '200',
    conversation: { conversationType: 'personal', id: DM },
    channelData: { replyChain: { id: '100' }, chat: { id: CHAT } },
    ...overrides,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- a minimal stand-in for the adapter */
function fakeAdapter() {
  const webhookBodies: any[] = [];
  const sends: { params: any; ref: any; options: any }[] = [];
  const edits: string[] = [];
  const state = new Map<string, string>();
  const encode = (conversationId: string) => `teams:${Buffer.from(conversationId).toString('base64url')}:svc`;
  const adapter: any = {
    chat: {
      getState: () => ({
        set: async (k: string, v: string) => void state.set(k, v),
        get: async (k: string) => state.get(k) ?? null,
      }),
    },
    handleWebhook: async (request: Request) => {
      webhookBodies.push(await request.json());
      return new Response('ok');
    },
    app: {
      activitySender: {
        send: async (params: any, ref: any, options: any) => {
          sends.push({ params, ref, options });
          return { id: 'sent' };
        },
      },
    },
    decodeThreadId: (threadId: string) => ({
      conversationId: Buffer.from(threadId.split(':')[1], 'base64url').toString(),
    }),
    channelIdFromThreadId(threadId: string) {
      return encode(this.decodeThreadId(threadId).conversationId.replace(/;messageid=\d+$/, ''));
    },
    editMessage: async (threadId: string) => void edits.push(threadId),
  };
  installTeamsDmThreads(adapter);
  return { adapter, webhookBodies, sends, edits, encode };
}

const post = (body: unknown) =>
  new Request('http://localhost/webhook/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('dmThreadRoot', () => {
  it('returns the root for a thread reply in a personal chat', () => {
    expect(dmThreadRoot(dmActivity())).toBe('100');
  });

  it('makes a top-level message the root of its own thread', () => {
    expect(dmThreadRoot(dmActivity({ id: '100' }))).toBe('100');
  });

  it('is null outside personal chats and without reply-chain data', () => {
    expect(
      dmThreadRoot(dmActivity({ conversation: { conversationType: 'channel', id: '19:x@thread.tacv2' } })),
    ).toBeNull();
    expect(dmThreadRoot(dmActivity({ channelData: {} }))).toBeNull();
  });

  it('anchors reactions and card clicks on the target message', () => {
    expect(dmThreadRoot(dmActivity({ type: 'messageReaction', id: 'x', replyToId: '200' }))).toBe('100');
    expect(dmThreadRoot(dmActivity({ type: 'messageReaction', id: 'x', replyToId: '100' }))).toBeNull();
  });

  it('leaves an id that already carries a thread suffix alone', () => {
    expect(
      dmThreadRoot(dmActivity({ conversation: { conversationType: 'personal', id: `${DM};messageid=100` } })),
    ).toBeNull();
  });
});

describe('splitDmThreadConversationId', () => {
  it('splits personal thread ids only', () => {
    expect(splitDmThreadConversationId(`${DM};messageid=100`)).toEqual({ base: DM, root: '100' });
    expect(splitDmThreadConversationId(DM)).toBeNull();
    expect(splitDmThreadConversationId('19:x@thread.tacv2;messageid=100')).toBeNull();
  });
});

describe('installTeamsDmThreads', () => {
  it('threads DM thread replies on their root and top-level messages on themselves', async () => {
    const { adapter, webhookBodies } = fakeAdapter();
    await adapter.handleWebhook(post(dmActivity()), {});
    await adapter.handleWebhook(post(dmActivity({ id: '100' })), {});
    expect(webhookBodies[0].conversation.id).toBe(`${DM};messageid=100`);
    expect(webhookBodies[1].conversation.id).toBe(`${DM};messageid=100`);
  });

  it('leaves a DM message without reply-chain data (no threads preview) top-level', async () => {
    const { adapter, webhookBodies } = fakeAdapter();
    await adapter.handleWebhook(post(dmActivity({ channelData: { chat: { id: CHAT } } })), {});
    expect(webhookBodies[0].conversation.id).toBe(DM);
  });

  it('posts a DM thread message through the reply-chain route on the chat id', async () => {
    const { adapter, sends } = fakeAdapter();
    await adapter.handleWebhook(post(dmActivity({ id: '100' })), {});
    await adapter.app.activitySender.send(
      { type: 'message', text: 'hi' },
      { conversation: { id: `${DM};messageid=100` } },
      undefined,
    );
    expect(sends[0].ref.conversation.id).toBe(CHAT);
    expect(sends[0].options).toEqual({ replyChainId: '100' });
  });

  it('sends typing to the plain DM, and falls back to top-level when the chat id is unknown', async () => {
    const { adapter, sends } = fakeAdapter();
    await adapter.app.activitySender.send(
      { type: 'message', text: 'hi' },
      { conversation: { id: `${DM};messageid=1` } },
    );
    await adapter.app.activitySender.send({ type: 'typing' }, { conversation: { id: `${DM};messageid=1` } });
    expect(sends.map((s) => [s.ref.conversation.id, s.options?.replyChainId])).toEqual([
      [DM, undefined],
      [DM, undefined],
    ]);
  });

  it('passes channel and group-chat sends through untouched', async () => {
    const { adapter, sends } = fakeAdapter();
    const ref = { conversation: { id: '19:x@thread.tacv2;messageid=5' } };
    await adapter.app.activitySender.send({ type: 'message' }, ref, undefined);
    expect(sends[0].ref).toBe(ref);
  });

  it('edits a DM thread message through the plain DM thread id', async () => {
    const { adapter, edits, encode } = fakeAdapter();
    await adapter.editMessage(encode(`${DM};messageid=100`), 'm1', {});
    await adapter.editMessage(encode('19:x@thread.tacv2;messageid=5'), 'm2', {});
    expect(edits).toEqual([encode(DM), encode('19:x@thread.tacv2;messageid=5')]);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
