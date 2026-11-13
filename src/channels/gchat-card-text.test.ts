/**
 * Google Chat approval cards end to end through the real gchat bridge factory:
 * the adapter is stubbed to capture the card, then the real
 * @chat-adapter/gchat converter renders it, so the test sees the
 * textParagraph HTML Google Chat receives.
 */
import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { cardToGoogleCard } from '@chat-adapter/gchat';
import type { AdapterPostableMessage } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from '../gateway-providers/gateway-provider-registry.js';
import type { ChannelAdapter, ChannelRegistration } from './adapter.js';

const registered = vi.hoisted(() => new Map<string, ChannelRegistration>());
const posted = vi.hoisted(() => [] as AdapterPostableMessage[]);

vi.mock('./channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel-registry.js')>()),
  registerChannelAdapter: (name: string, registration: ChannelRegistration) => registered.set(name, registration),
}));

vi.mock('@chat-adapter/gchat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chat-adapter/gchat')>();
  return {
    ...actual,
    createGoogleChatAdapter: () => ({
      name: 'gchat',
      postMessage: async (threadId: string, message: AdapterPostableMessage) => {
        posted.push(message);
        return { id: 'm1', threadId, raw: {} };
      },
    }),
  };
});

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

import { escapeGChatHtml } from './gchat.js';

// The factory refuses credentials without a real RSA key.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('escapeGChatHtml', () => {
  it('entity-escapes &, < and >, ampersand first', () => {
    expect(escapeGChatHtml('a & <b> &lt;')).toBe('a &amp; &lt;b&gt; &amp;lt;');
  });

  it('leaves plain text and Markdown alone', () => {
    expect(escapeGChatHtml('*bold* `code` "quoted"')).toBe('*bold* `code` "quoted"');
  });

  it('drops the backslash before a Markdown mark, and keeps any other backslash', () => {
    expect(escapeGChatHtml('file\\_1 \\(a\\*b\\) \\\\ \\< C:\\path')).toBe('file_1 (a*b) \\ &lt; C:\\path');
  });
});

describe('Google Chat approval card text', () => {
  let dir: string;
  let bridge: ChannelAdapter;

  beforeEach(async () => {
    posted.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-card-text-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        `GCHAT_CREDENTIALS=${JSON.stringify({ client_email: 'bot@example.iam.gserviceaccount.com', private_key: privateKey })}`,
        'GOOGLE_CHAT_ENDPOINT_URL=https://chat.example.com/webhook/gchat',
        'GOOGLE_CHAT_PROJECT_NUMBER=123456789012',
      ].join('\n') + '\n',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    bridge = (await registered.get('gchat')!.factory())!;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Text of every textParagraph in the last posted card, as Google Chat receives it. */
  function postedParagraphs(): string[] {
    const google = cardToGoogleCard((posted.at(-1) as { card: Parameters<typeof cardToGoogleCard>[0] }).card, {});
    return google.card.sections
      .flatMap((s: { widgets: Array<{ textParagraph?: { text: string } }> }) => s.widgets)
      .filter((w: { textParagraph?: { text: string } }) => w.textParagraph)
      .map((w: { textParagraph?: { text: string } }) => w.textParagraph!.text);
  }

  async function ask(question: string, extra: Record<string, unknown> = {}): Promise<void> {
    await bridge.deliver('spaces/AAA', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-1',
        title: 'New sender',
        question,
        options: ['Approve'],
        ...extra,
      },
    });
  }

  it('renders HTML tags in the question as plain text', async () => {
    await ask('"<a href="https://example.com">Eve</a><br><b>owner</b>" wants to talk & more');

    expect(postedParagraphs()[0]).toBe(
      '"&lt;a href="https://example.com"&gt;Eve&lt;/a&gt;&lt;br&gt;&lt;b&gt;owner&lt;/b&gt;" wants to talk &amp; more',
    );
  });

  it('escapes every paragraph when a long host card is split', async () => {
    await ask('<b>Action</b> <a href="https://example.com">verify</a> & more\n'.repeat(120));

    const paragraphs = postedParagraphs();
    expect(paragraphs.length).toBeGreaterThan(1);
    for (const text of paragraphs) expect(text).not.toMatch(/[<>]/);
  });

  // Gateway cards escape Markdown for the other channels; Google Chat shows it as typed.
  it.each([
    ['legacy', { title: 'Delete', question: 'delete file_1.txt (a*b) [x](y)' }, 'delete file_1.txt (a*b) [x](y)'],
    [
      'summary',
      {
        title: 'T',
        question: '',
        summary: { agent: 'bot_1', action: 'Delete file_1.txt', resource: 'drive', reason: 'policy' },
      },
      '*Agent:* bot_1\n*Action:* Delete file_1.txt',
    ],
    [
      'typed',
      { title: 'T', question: 'Allow?', displayFields: [{ label: 'File', type: 'text', value: 'file_1.txt (a*b)' }] },
      'Allow?\n*File:* file_1.txt (a*b)',
    ],
  ])('shows a %s gateway card as typed, without the backslashes', async (_kind, request, shown) => {
    await ask(gatewayApprovalPresentation(request as GatewayApprovalRequest).question);

    expect(postedParagraphs()[0]).toContain(shown);
    expect(postedParagraphs().join('')).not.toContain('\\');
  });

  it('still blocks a link in a gateway card once the backslashes are gone', async () => {
    const value = '<a href="https://evil.test">Admin</a> <https://evil.test|Admin>';
    const request = { title: 'T', question: 'Allow?', displayFields: [{ label: 'Where', type: 'text', value }] };
    await ask(gatewayApprovalPresentation(request as GatewayApprovalRequest).question);

    const [text] = postedParagraphs();
    expect(text).toContain('&lt;a href="https://evil.test"&gt;Admin&lt;/a&gt; &lt;https://evil.test|Admin&gt;');
    expect(text).not.toMatch(/[<>]/);
  });

  // The known cost: a backslash someone really typed before a Markdown mark is dropped too.
  it('drops a typed backslash before a Markdown mark in any card', async () => {
    await ask('a\\_b wants to talk');

    expect(postedParagraphs()).toEqual(['a_b wants to talk']);
  });

  it('keeps the markup of a question the agent asked itself', async () => {
    await ask('See <a href="https://example.com">the docs</a>?', { fromAgent: true });

    expect(postedParagraphs()).toEqual(['See <a href="https://example.com">the docs</a>?']);
  });
});
