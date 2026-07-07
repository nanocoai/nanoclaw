/**
 * Approval-card actor byline in the Chat SDK bridge.
 *
 * Drives the bridge's real onAction handler through the real Chat SDK
 * dispatch (`chat.processAction`): `bridge.setup()` registers the handler on
 * a real Chat instance, which the test captures from the webhook-server
 * registration (mocked so no HTTP server binds a port). After a button click
 * the bridge edits the card; the edit must append " — <actor>" so shared
 * channels see who resolved an approval. Goes red if the byLine concatenation
 * is removed from the edited markdown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

interface CapturedEdit {
  threadId: string;
  messageId: string;
  markdown: string;
}

function makeAdapter(edits: CapturedEdit[]): Adapter {
  return {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    editMessage: async (threadId: string, messageId: string, content: { markdown: string }) => {
      edits.push({ threadId, messageId, markdown: content.markdown });
    },
  } as unknown as Adapter;
}

async function fireAction(user: Record<string, unknown>): Promise<{ edits: CapturedEdit[]; actions: string[] }> {
  const edits: CapturedEdit[] = [];
  const actions: string[] = [];
  const adapter = makeAdapter(edits);
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false });

  await bridge.setup({
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: (questionId: string, selectedOption: string, userId: string) => {
      actions.push(`${questionId}:${selectedOption}:${userId}`);
    },
  } as ChannelSetup);

  const chat = captured.chat as Chat;
  expect(chat).toBeTruthy();
  await chat.processAction(
    {
      actionId: 'ncq:q-1:approve',
      adapter,
      messageId: 'msg-1',
      raw: {},
      threadId: 'T-1',
      user: user as never,
      value: 'approve',
    },
    undefined,
  );
  return { edits, actions };
}

beforeEach(() => {
  captured.chat = null;
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('chat-sdk-bridge approval-card byline', () => {
  it('appends the acting user to the edited card markdown', async () => {
    const { edits, actions } = await fireAction({ userId: 'U1', userName: 'gavriel', fullName: 'Gavriel C' });

    expect(edits).toHaveLength(1);
    expect(edits[0].threadId).toBe('T-1');
    expect(edits[0].messageId).toBe('msg-1');
    expect(edits[0].markdown).toContain('approve — gavriel');
    expect(actions).toEqual(['q-1:approve:U1']);
  });

  it('falls back to fullName when userName is missing', async () => {
    const { edits } = await fireAction({ userId: 'U2', fullName: 'Gavriel C' });

    expect(edits).toHaveLength(1);
    expect(edits[0].markdown).toContain('— Gavriel C');
  });

  it('omits the byline when the actor has no name', async () => {
    const { edits } = await fireAction({ userId: 'U3' });

    expect(edits).toHaveLength(1);
    expect(edits[0].markdown).not.toContain('—');
    expect(edits[0].markdown).toContain('approve');
  });
});
