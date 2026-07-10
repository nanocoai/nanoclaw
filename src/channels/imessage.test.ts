/**
 * Photon adapter tests.
 *
 * Two layers:
 *  1. Pure helpers (id/phone resolution, content normalization, formatting).
 *  2. A mocked-SDK end-to-end pass: a fake `spectrum-ts` drives the real
 *     adapter so inbound routing, ask_question, reactions, typing, outbound
 *     delivery, and teardown all run the production code paths without a live
 *     Photon account.
 */
import { describe, it, expect, vi } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import {
  appendMediaFailureNote,
  attachmentFilename,
  chunkText,
  createPhotonAdapter,
  normalizeContent,
  optionToCommand,
  photonReactionEmoji,
  photonReactionTargetId,
  phoneTargetFromSpaceId,
  resolveSpaceIdentity,
  type NormalizedInbound,
  type PhotonAttachment,
  type PhotonSdk,
  type SpectrumApp,
  type SpectrumMessage,
  type SpectrumSpace,
} from './imessage.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('phoneTargetFromSpaceId', () => {
  it('returns a bare E.164 number as-is', () => {
    expect(phoneTargetFromSpaceId('+15551234567')).toBe('+15551234567');
  });
  it('extracts the number from an iMessage DM chat GUID', () => {
    expect(phoneTargetFromSpaceId('any;-;+15551234567')).toBe('+15551234567');
  });
  it('returns null for opaque group ids and junk', () => {
    expect(phoneTargetFromSpaceId('iMessage;+;group-abc123')).toBeNull();
    expect(phoneTargetFromSpaceId(undefined)).toBeNull();
    expect(phoneTargetFromSpaceId('')).toBeNull();
  });
});

describe('resolveSpaceIdentity', () => {
  it('resolves a DM to the counterpart E.164 phone', () => {
    const id = resolveSpaceIdentity(
      { id: 'any;-;+15551234567', type: 'dm', phone: '+15551234567', send: async () => ({}) },
      {},
    );
    expect(id).toEqual({ platformId: '+15551234567', isGroup: false });
  });
  it('falls back to the space id when a DM has no phone', () => {
    const id = resolveSpaceIdentity({ id: 'opaque-dm-id', type: 'dm', send: async () => ({}) }, {});
    expect(id).toEqual({ platformId: 'opaque-dm-id', isGroup: false });
  });
  it('resolves a group to its opaque space id', () => {
    const id = resolveSpaceIdentity({ id: 'group-guid-xyz', type: 'group', send: async () => ({}) }, {});
    expect(id).toEqual({ platformId: 'group-guid-xyz', isGroup: true });
  });
  it('reads identity off message.space when the stream space is bare', () => {
    const msg: SpectrumMessage = {
      space: { id: '+15550009999', type: 'dm', phone: '+15550009999', send: async () => ({}) },
    };
    const id = resolveSpaceIdentity(undefined, msg);
    expect(id).toEqual({ platformId: '+15550009999', isGroup: false });
  });
  it('returns null when there is no id at all', () => {
    expect(resolveSpaceIdentity(undefined, {})).toBeNull();
  });
});

describe('optionToCommand', () => {
  it('slugs a label into a slash command', () => {
    expect(optionToCommand('Approve')).toBe('/approve');
    expect(optionToCommand('Reject Request')).toBe('/reject-request');
  });
});

describe('Photon reaction normalization', () => {
  it('converts NanoClaw shortcodes and preserves raw emoji', () => {
    expect(photonReactionEmoji('thumbs_up')).toBe('👍');
    expect(photonReactionEmoji('heart')).toBe('❤️');
    expect(photonReactionEmoji('👀')).toBe('👀');
  });

  it('removes the router agent-group suffix from Photon message ids', () => {
    expect(photonReactionTargetId('spc-msg-123:ag-1234-abcd')).toBe('spc-msg-123');
    expect(photonReactionTargetId('spc-msg-123')).toBe('spc-msg-123');
  });
});

describe('attachmentFilename', () => {
  it('keeps a safe provided name', () => {
    expect(attachmentFilename({ type: 'attachment', name: 'photo.jpg' })).toBe('photo.jpg');
  });
  it('rejects a traversal name and synthesizes from mime', () => {
    const name = attachmentFilename({ type: 'attachment', name: '../../etc/passwd', mimeType: 'image/png', id: 'abc' });
    expect(name).toBe('attachment-abc.png');
  });
  it('defaults voice notes to .caf', () => {
    expect(attachmentFilename({ type: 'voice', id: 'v1' })).toBe('voice-v1.caf');
  });
});

describe('chunkText', () => {
  it('returns a single chunk under the limit', () => {
    expect(chunkText('hello', 100)).toEqual(['hello']);
  });
  it('splits long text on line boundaries', () => {
    const text = 'a'.repeat(30) + '\n' + 'b'.repeat(30);
    const chunks = chunkText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain('a'.repeat(30));
  });
});

describe('appendMediaFailureNote', () => {
  it('is a no-op with no failures', () => {
    expect(appendMediaFailureNote('hi', [])).toBe('hi');
  });
  it('appends notes for failed downloads', () => {
    expect(appendMediaFailureNote('hi', ['attachment'])).toBe('hi\n[attachment could not be downloaded]');
  });
});

describe('normalizeContent', () => {
  const saver = async (c: { type: string }): Promise<PhotonAttachment | null> => ({
    type: c.type,
    name: 'file.bin',
    localPath: 'attachments/file.bin',
  });

  it('extracts plain text', async () => {
    const out: NormalizedInbound = { text: '', attachments: [], failures: [], isReaction: false };
    await normalizeContent({ type: 'text', text: 'hello world' }, saver, out);
    expect(out.text).toBe('hello world');
  });

  it('collects text + attachments from a mixed group', async () => {
    const out: NormalizedInbound = { text: '', attachments: [], failures: [], isReaction: false };
    await normalizeContent(
      {
        type: 'group',
        items: [
          { content: { type: 'text', text: 'caption' } },
          { content: { type: 'attachment', read: async () => new Uint8Array([1, 2]) } },
        ],
      },
      saver,
      out,
    );
    expect(out.text).toBe('caption');
    expect(out.attachments).toHaveLength(1);
  });

  it('records a failure when media cannot be saved', async () => {
    const out: NormalizedInbound = { text: '', attachments: [], failures: [], isReaction: false };
    await normalizeContent({ type: 'attachment' }, async () => null, out);
    expect(out.failures).toEqual(['attachment']);
  });

  it('renders a reaction as a marker line', async () => {
    const out: NormalizedInbound = { text: '', attachments: [], failures: [], isReaction: false };
    await normalizeContent({ type: 'reaction', emoji: '👍' }, saver, out);
    expect(out.text).toBe('reaction:added:👍');
    expect(out.isReaction).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mocked-SDK end-to-end
// ---------------------------------------------------------------------------

/** A pushable async queue standing in for `app.messages`. */
class MessageQueue implements AsyncIterable<[SpectrumSpace, SpectrumMessage]> {
  private items: Array<[SpectrumSpace, SpectrumMessage]> = [];
  private waiters: Array<(r: IteratorResult<[SpectrumSpace, SpectrumMessage]>) => void> = [];
  private done = false;

  push(item: [SpectrumSpace, SpectrumMessage]): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  end(): void {
    this.done = true;
    let w = this.waiters.shift();
    while (w) {
      w({ value: undefined as never, done: true });
      w = this.waiters.shift();
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<[SpectrumSpace, SpectrumMessage]> {
    return {
      next: (): Promise<IteratorResult<[SpectrumSpace, SpectrumMessage]>> => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface RecordedSend {
  spaceId: string;
  builder: { kind: string; payload: unknown };
}

function makeFakeSdk(options: { missingReactionTarget?: boolean } = {}) {
  const queue = new MessageQueue();
  const sends: RecordedSend[] = [];
  const stop = vi.fn(async () => {});
  const reacted: Array<{ messageId: string; emoji: string }> = [];

  const makeSpace = (id: string, type: string, phone?: string): SpectrumSpace => ({
    id,
    type,
    phone,
    send: async (builder: unknown) => {
      sends.push({ spaceId: id, builder: builder as { kind: string; payload: unknown } });
      return { id: `sent-${sends.length}` };
    },
    getMessage: async (mid: string) =>
      options.missingReactionTarget
        ? undefined
        : {
            id: mid,
            react: async (emoji: string) => {
              reacted.push({ messageId: mid, emoji });
              return { id: `reaction-${reacted.length}`, unsend: async () => {} };
            },
          },
  });

  const app: SpectrumApp = { messages: queue, stop };

  const sdk: PhotonSdk = {
    spectrum: {
      Spectrum: async () => app,
      text: (s: string) => ({ kind: 'text', payload: s }),
      markdown: (s: string) => ({ kind: 'markdown', payload: s }),
      typing: (state: 'start' | 'stop') => ({ kind: 'typing', payload: state }),
      read: (message: SpectrumMessage) => ({ kind: 'read', payload: message.id }),
      attachment: (p: string, opts?: unknown) => ({ kind: 'attachment', payload: { p, opts } }),
      voice: (p: string, opts?: unknown) => ({ kind: 'voice', payload: { p, opts } }),
    },
    imessage: Object.assign(
      (_app: SpectrumApp) => ({
        space: {
          create: async (target: string) => makeSpace(target, 'dm', target),
          get: async (id: string) => makeSpace(id, 'group'),
        },
      }),
      { config: () => ({}) },
    ),
  };

  return { sdk, queue, sends, stop, reacted, makeSpace };
}

function makeHostConfig() {
  const inbound: Array<{ platformId: string; msg: InboundMessage }> = [];
  const metadata: Array<{ platformId: string; isGroup?: boolean }> = [];
  const actions: Array<{ questionId: string; option: string; userId: string }> = [];
  const config: ChannelSetup = {
    onInbound: async (platformId, _threadId, msg) => {
      inbound.push({ platformId, msg });
    },
    onInboundEvent: async () => {},
    onMetadata: (platformId, _name, isGroup) => {
      metadata.push({ platformId, isGroup });
    },
    onAction: (questionId, option, userId) => {
      actions.push({ questionId, option, userId });
    },
  };
  return { config, inbound, metadata, actions };
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('photon adapter (mocked SDK)', () => {
  it('routes an inbound DM as a platform-confirmed mention', async () => {
    const { sdk, queue } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);
    expect(adapter.isConnected()).toBe(true);

    const space: SpectrumSpace = {
      id: 'any;-;+15551112222',
      type: 'dm',
      phone: '+15551112222',
      send: async () => ({}),
    };
    queue.push([
      space,
      { id: 'm1', direction: 'inbound', sender: { id: '+15551112222' }, content: { type: 'text', text: 'hi bot' } },
    ]);

    await waitFor(() => host.inbound.length === 1);
    const { platformId, msg } = host.inbound[0];
    expect(platformId).toBe('+15551112222');
    expect(msg.isMention).toBe(true);
    expect(msg.isGroup).toBe(false);
    expect((msg.content as { text: string }).text).toBe('hi bot');
    expect((msg.content as { senderId: string }).senderId).toBe('imessage:+15551112222');
    expect(host.metadata[0]).toEqual({ platformId: '+15551112222', isGroup: false });

    await adapter.teardown();
  });

  it('routes an inbound group message without an auto-mention', async () => {
    const { sdk, queue } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);

    const space: SpectrumSpace = { id: 'group-abc', type: 'group', send: async () => ({}) };
    queue.push([
      space,
      { id: 'm2', direction: 'inbound', sender: { id: '+15559998888' }, content: { type: 'text', text: 'hello all' } },
    ]);

    await waitFor(() => host.inbound.length === 1);
    expect(host.inbound[0].platformId).toBe('group-abc');
    expect(host.inbound[0].msg.isMention).toBeUndefined();
    expect(host.inbound[0].msg.isGroup).toBe(true);

    await adapter.teardown();
  });

  it('still routes inbound messages when marking the chat read fails', async () => {
    const { sdk, queue } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);

    const space: SpectrumSpace = {
      id: '+15551112222',
      type: 'dm',
      phone: '+15551112222',
      send: async (builder) => {
        if ((builder as { kind?: string }).kind === 'read') throw new Error('read receipt unavailable');
        return {};
      },
    };
    queue.push([
      space,
      {
        id: 'm-read-fails',
        direction: 'inbound',
        sender: { id: '+15551112222' },
        content: { type: 'text', text: 'still deliver this' },
      },
    ]);

    await waitFor(() => host.inbound.length === 1);
    expect((host.inbound[0].msg.content as { text: string }).text).toBe('still deliver this');

    await adapter.teardown();
  });

  it('ignores our own outbound echoes on the stream', async () => {
    const { sdk, queue } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);

    const space: SpectrumSpace = { id: '+15551112222', type: 'dm', phone: '+15551112222', send: async () => ({}) };
    queue.push([
      space,
      { id: 'echo', direction: 'outbound', sender: { id: 'bot' }, content: { type: 'text', text: 'my reply' } },
    ]);
    queue.push([
      space,
      {
        id: 'real',
        direction: 'inbound',
        sender: { id: '+15551112222' },
        content: { type: 'text', text: 'their msg' },
      },
    ]);

    await waitFor(() => host.inbound.length === 1);
    expect(host.inbound).toHaveLength(1);
    expect((host.inbound[0].msg.content as { text: string }).text).toBe('their msg');

    await adapter.teardown();
  });

  it('delivers markdown text to a DM (via space.create)', async () => {
    const { sdk, sends } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);

    await adapter.deliver('+15551112222', null, { kind: 'chat', content: { text: 'hello **there**' } });
    expect(sends).toHaveLength(1);
    expect(sends[0].spaceId).toBe('+15551112222');
    expect(sends[0].builder.kind).toBe('markdown');
    expect(sends[0].builder.payload).toBe('hello **there**');

    await adapter.teardown();
  });

  it('tolerates a bare string outbound content', async () => {
    const { sdk, sends } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);
    await adapter.deliver('+15551112222', null, { kind: 'chat', content: 'just a string' });
    expect(sends).toHaveLength(1);
    expect(sends[0].builder.payload).toBe('just a string');
    await adapter.teardown();
  });

  it('sends plain text when markdown is disabled', async () => {
    const { sdk, sends } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: false, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);
    await adapter.deliver('+15551112222', null, { kind: 'chat', content: { text: 'plain' } });
    expect(sends[0].builder.kind).toBe('text');
    await adapter.teardown();
  });

  it('reuses the inbound space for outbound (no create round trip)', async () => {
    const { sdk, queue, sends } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);

    const inboundSpaceSends: unknown[] = [];
    const space: SpectrumSpace = {
      id: '+15551112222',
      type: 'dm',
      phone: '+15551112222',
      send: async (b) => {
        inboundSpaceSends.push(b);
        return { id: 'x' };
      },
    };
    queue.push([
      space,
      { id: 'm', direction: 'inbound', sender: { id: '+15551112222' }, content: { type: 'text', text: 'hey' } },
    ]);
    await waitFor(() => host.inbound.length === 1);

    await adapter.deliver('+15551112222', null, { kind: 'chat', content: { text: 'reply' } });
    // The read receipt and reply both use the cached inbound space, avoiding
    // a fresh space.create round trip.
    expect(inboundSpaceSends).toHaveLength(2);
    expect(inboundSpaceSends[0]).toEqual({ kind: 'read', payload: 'm' });
    expect(inboundSpaceSends[1]).toEqual({ kind: 'markdown', payload: 'reply' });
    expect(sends).toHaveLength(0);

    await adapter.teardown();
  });

  it('renders ask_question as slash options and routes the reply to onAction', async () => {
    const { sdk, queue, sends } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);

    await adapter.deliver('+15551112222', null, {
      kind: 'chat',
      content: {
        type: 'ask_question',
        questionId: 'q1',
        title: 'Deploy?',
        question: 'Ship it?',
        options: ['Approve', 'Reject'],
      },
    });
    const card = sends.find((s) => s.builder.kind === 'markdown');
    expect(card).toBeTruthy();
    expect(String(card!.builder.payload)).toContain('/approve');

    // User replies "/approve" → onAction with the option value, not a wake.
    const space: SpectrumSpace = { id: '+15551112222', type: 'dm', phone: '+15551112222', send: async () => ({}) };
    queue.push([
      space,
      { id: 'r1', direction: 'inbound', sender: { id: '+15551112222' }, content: { type: 'text', text: '/approve' } },
    ]);
    await waitFor(() => host.actions.length === 1);
    expect(host.actions[0]).toEqual({ questionId: 'q1', option: 'Approve', userId: '+15551112222' });
    // The slash reply must NOT have woken the agent as a normal inbound.
    expect(host.inbound).toHaveLength(0);

    await adapter.teardown();
  });

  it('sends a tapback reaction using the raw Photon id and emoji', async () => {
    const { sdk, reacted } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);
    await adapter.deliver('group-abc', null, {
      kind: 'chat',
      content: { operation: 'reaction', messageId: 'm9:ag-1234-abcd', emoji: 'thumbs_up' },
    });
    expect(reacted).toEqual([{ messageId: 'm9', emoji: '👍' }]);
    await adapter.teardown();
  });

  it('fails delivery when the reaction target cannot be resolved', async () => {
    const { sdk } = makeFakeSdk({ missingReactionTarget: true });
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);
    await expect(
      adapter.deliver('group-abc', null, {
        kind: 'chat',
        content: { operation: 'reaction', messageId: 'missing:ag-1234-abcd', emoji: 'thumbs_up' },
      }),
    ).rejects.toThrow(/message not found/i);
    await adapter.teardown();
  });

  it('emits a typing indicator', async () => {
    const { sdk, sends } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);
    await adapter.setTyping!('+15551112222', null);
    expect(sends.some((s) => s.builder.kind === 'typing' && s.builder.payload === 'start')).toBe(true);
    await adapter.teardown();
  });

  it('throws a clear error when the SDK is not installed', async () => {
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      {
        loadSpectrum: async () => {
          throw new Error("Cannot find module 'spectrum-ts'");
        },
      },
    );
    await expect(adapter.setup(host.config)).rejects.toThrow(/spectrum-ts.*not installed|add-imessage/i);
    expect(adapter.isConnected()).toBe(false);
  });

  it('stops the app on teardown', async () => {
    const { sdk, stop } = makeFakeSdk();
    const host = makeHostConfig();
    const adapter = createPhotonAdapter(
      { projectId: 'p', projectSecret: 's', markdown: true, telemetry: false, maxInlineAttachmentBytes: 1000 },
      { loadSpectrum: async () => sdk },
    );
    await adapter.setup(host.config);
    await adapter.teardown();
    expect(stop).toHaveBeenCalled();
    expect(adapter.isConnected()).toBe(false);
  });
});
