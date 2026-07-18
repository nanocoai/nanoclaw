/**
 * add_mcp_server approval-card regression coverage.
 *
 * The approval card is the only thing an admin sees before approving a
 * request that lets an agent point NanoClaw at an arbitrary MCP server
 * (command + args + env, executed on approve — see apply.ts). The card must
 * show every field that will actually be applied — JSON-encoded, invisibles
 * escaped, fenced, secret-shaped values redacted to a byte-count + sha256
 * fingerprint (applied verbatim from the payload) — and bad input (types,
 * counts, oversized payloads or cards) must be rejected before an approval
 * row is even created.
 *
 * Real central DB (matches reason-capture.test.ts's approach); delivery
 * adapter is a fake that records the card payload so the rendered question
 * text can be asserted on directly.
 */
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { createChatSdkBridge } from '../../channels/chat-sdk-bridge.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { Session } from '../../types.js';
import { escapeInvisibles, requestAddMcpServerHold, validateAddMcpServer } from './request.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-mcp-approval' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('../../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-mcp-approval';
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';

function now(): string {
  return new Date().toISOString();
}

let delivered: Array<{ channelType: string; platformId: string; content: string }>;

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _kind, content) {
    delivered.push({ channelType, platformId, content });
    return 'pm-1';
  },
};

let session: Session;

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  delivered = [];

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  createSession(session);

  // Authorized approver + a cached DM so ensureUserDm resolves without a
  // platform openDM call.
  upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  grantRole({ user_id: 'slack:admin-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });

  setDeliveryAdapter(fakeAdapter);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** The `question` text of the most recently delivered approval card. */
function lastQuestion(): string {
  expect(delivered.length).toBeGreaterThan(0);
  return (JSON.parse(delivered[delivered.length - 1].content) as { question: string }).question;
}

/** The text of the most recent agent-facing note written via writeSessionMessage. */
function lastNotifyText(): string {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

/**
 * Drive the two halves the delivery guard runs for a held action: the
 * precheck, then — only if it passes — the hold builder that renders the
 * card (delivery-guard.ts: precheck → guard → requestHold). The guard
 * consult in between is unconditional-hold from the container path, so this
 * is the production path for every case these tests cover.
 */
async function submitAddMcpServer(content: Record<string, unknown>, s: Session): Promise<void> {
  if (!validateAddMcpServer(content, s)) return;
  await requestAddMcpServerHold(content, s);
}

/** Assert the handler rejected: no card delivered, no row, agent notified with a failure. */
function expectRejected(): string {
  expect(delivered).toHaveLength(0);
  expect(getPendingApprovalsByAction('add_mcp_server')).toHaveLength(0);
  expect(vi.mocked(writeSessionMessage)).toHaveBeenCalled();
  const text = lastNotifyText();
  expect(text).toMatch(/add_mcp_server failed/);
  return text;
}

describe('add_mcp_server approval card', () => {
  it('shows every arg and every env key/value verbatim', async () => {
    await submitAddMcpServer(
      {
        name: 'evil',
        command: 'npx',
        args: ['-y', 'evil-pkg', '--flag'],
        env: { FOO: 'bar', NODE_OPTIONS: '--require /x.js' },
      },
      session,
    );

    const question = lastQuestion();
    expect(question).toContain('evil');
    expect(question).toContain('npx');
    for (const arg of ['-y', 'evil-pkg', '--flag']) {
      expect(question).toContain(arg);
    }
    expect(question).toContain('FOO');
    expect(question).toContain('bar');
    expect(question).toContain('NODE_OPTIONS');
    expect(question).toContain('--require /x.js');
  });

  it('renders an explicit empty state when args/env are omitted', async () => {
    await submitAddMcpServer({ name: 'plain', command: 'node' }, session);

    const question = lastQuestion();
    expect(question).toContain('args: []');
    expect(question).toContain('env: {}');
  });

  it('cannot be spoofed by newlines embedded in payload values', async () => {
    await submitAddMcpServer(
      {
        name: 'safe',
        command: 'node',
        args: ['ok\nenv: (none)'],
        env: { FOO: 'bar\ncommand: "rm"' },
      },
      session,
    );

    const question = lastQuestion();
    // Header + opening fence + name + command + args + env + closing fence —
    // payload content adds no lines.
    expect(question.split('\n').length).toBe(7);
    // Embedded newlines surface as visible \n escapes.
    expect(question).toContain('ok\\nenv: (none)');
    expect(question).toContain('bar\\ncommand:');
  });

  it('keeps markdown links and backticks inert inside a single intact fence', async () => {
    await submitAddMcpServer(
      {
        name: 'safe',
        command: 'node',
        args: ['```\nfake fence', '[click me](https://evil.example)'],
        env: { X: 'a`b' },
      },
      session,
    );

    const question = lastQuestion();
    // Exactly one opening and one closing fence — every payload backtick is
    // escaped, so the payload can never close the fence.
    expect(question.split('```')).toHaveLength(3);
    expect(question).toContain('\\u0060');
    // The link text is present, but only inside the fence (fence opens
    // before it and closes after it).
    const linkIdx = question.indexOf('[click me](https://evil.example)');
    expect(linkIdx).toBeGreaterThan(question.indexOf('```'));
    expect(linkIdx).toBeLessThan(question.lastIndexOf('```'));
  });

  it('renders bidi, zero-width, and BOM characters as visible escapes', async () => {
    await submitAddMcpServer(
      {
        name: 'safe',
        command: 'node',
        args: ['a\u202eb', 'c\u200bd'],
        env: { K: 'x\ufeffy' },
      },
      session,
    );

    const question = lastQuestion();
    for (const raw of ['\u202e', '\u200b', '\ufeff']) {
      expect(question).not.toContain(raw);
    }
    expect(question).toContain('\\u202e');
    expect(question).toContain('\\u200b');
    expect(question).toContain('\\ufeff');
  });
});

describe('add_mcp_server validation', () => {
  it('rejects a non-string element in args before creating an approval', async () => {
    await submitAddMcpServer({ name: 'bad', command: 'node', args: ['ok', 123] }, session);
    expectRejected();
  });

  it('rejects a non-record env before creating an approval', async () => {
    await submitAddMcpServer({ name: 'bad', command: 'node', env: ['not', 'a', 'record'] }, session);
    expectRejected();
  });

  it('accepts 32 args and rejects 33', async () => {
    await submitAddMcpServer(
      { name: 'ok', command: 'node', args: Array.from({ length: 32 }, (_, i) => `a${i}`) },
      session,
    );
    expect(delivered).toHaveLength(1);

    delivered = [];
    await submitAddMcpServer(
      { name: 'bad', command: 'node', args: Array.from({ length: 33 }, (_, i) => `a${i}`) },
      session,
    );
    expect(delivered).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/max 32 args/);
  });

  it('accepts 32 env vars and rejects 33', async () => {
    const envOf = (n: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`K${i}`, 'v']));

    await submitAddMcpServer({ name: 'ok', command: 'node', env: envOf(32) }, session);
    expect(delivered).toHaveLength(1);

    delivered = [];
    await submitAddMcpServer({ name: 'bad', command: 'node', env: envOf(33) }, session);
    expect(delivered).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/max 32 env vars/);
  });

  it('accepts a card of exactly 1500 bytes and rejects one byte over', async () => {
    // Measure the fixed overhead with an empty filler arg, then pad the arg
    // (pure ASCII: 1 char = 1 byte) so the rendered question lands exactly
    // on the cap.
    await submitAddMcpServer({ name: 'n', command: 'c', args: [''] }, session);
    const base = Buffer.byteLength(lastQuestion(), 'utf8');
    const filler = 'a'.repeat(1500 - base);

    delivered = [];
    await submitAddMcpServer({ name: 'n', command: 'c', args: [filler] }, session);
    expect(delivered).toHaveLength(1);
    expect(Buffer.byteLength(lastQuestion(), 'utf8')).toBe(1500);

    delivered = [];
    await submitAddMcpServer({ name: 'n', command: 'c', args: [`${filler}a`] }, session);
    expect(delivered).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/1500 bytes/);
  });

  it('accepts a payload of exactly 16384 bytes and rejects one byte over', async () => {
    // A secret-shaped filler renders as a tiny redaction placeholder, so the
    // raw payload can hit its cap without tripping the 1500-byte card cap.
    // Measure the fixed overhead with the bare prefix, then pad (ASCII:
    // 1 char = 1 byte in the JSON encoding).
    await submitAddMcpServer({ name: 'n', command: 'c', args: ['sk-'] }, session);
    const base = Buffer.byteLength(JSON.stringify({ name: 'n', command: 'c', args: ['sk-'], env: {} }), 'utf8');
    const filler = `sk-${'a'.repeat(16384 - base)}`;

    delivered = [];
    await submitAddMcpServer({ name: 'n', command: 'c', args: [filler] }, session);
    expect(delivered).toHaveLength(1);

    delivered = [];
    await submitAddMcpServer({ name: 'n', command: 'c', args: [`${filler}a`] }, session);
    expect(delivered).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/16384 bytes/);
  });
});

describe('add_mcp_server secret redaction', () => {
  function redactedForm(value: string): string {
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
    return `<redacted: ${Buffer.byteLength(value, 'utf8')} bytes, sha256 ${digest}>`;
  }

  it('redacts secret-shaped values on the card but keeps them verbatim in the payload', async () => {
    const keyMatched = 'hunter2-secret-value'; // secret by env KEY (GITHUB_TOKEN)
    const valueMatched = 'sk-abc123def456'; // secret by VALUE prefix under an innocuous key
    const argSecret = 'ghp_deadbeefcafe1234'; // secret by VALUE prefix in args
    await submitAddMcpServer(
      {
        name: 'safe',
        command: 'node',
        args: ['--token', argSecret],
        env: { GITHUB_TOKEN: keyMatched, HARMLESS: valueMatched, NODE_OPTIONS: '--require /x.js' },
      },
      session,
    );

    const question = lastQuestion();
    for (const secret of [keyMatched, valueMatched, argSecret]) {
      expect(question).not.toContain(secret);
      expect(question).toContain(redactedForm(secret));
    }
    // Non-secret values stay fully visible.
    expect(question).toContain('--require /x.js');
    expect(question).toContain('--token');

    // The approval payload carries the verbatim values — applied unchanged.
    const rows = getPendingApprovalsByAction('add_mcp_server');
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as {
      args: string[];
      env: Record<string, string>;
    };
    expect(payload.args).toEqual(['--token', argSecret]);
    expect(payload.env.GITHUB_TOKEN).toBe(keyMatched);
    expect(payload.env.HARMLESS).toBe(valueMatched);
  });
});

describe('escapeInvisibles', () => {
  it('escapes every bidi, zero-width, and separator character as \\uXXXX', () => {
    const invisibles = '\u202a\u202e\u2066\u2069\u200e\u200f\u061c\u200b\u200c\u200d\u2060\ufeff\u2028\u2029`';
    const out = escapeInvisibles(invisibles);
    for (const c of invisibles) expect(out).not.toContain(c);
    expect(out).toBe(
      '\\u202a\\u202e\\u2066\\u2069\\u200e\\u200f\\u061c\\u200b\\u200c\\u200d\\u2060\\ufeff\\u2028\\u2029\\u0060',
    );
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeInvisibles('hello world -y evil [link](https://x)')).toBe('hello world -y evil [link](https://x)');
  });
});

describe('add_mcp_server card through the chat-sdk bridge', () => {
  it('delivers CardText with the fence intact and escapes still visible', async () => {
    await submitAddMcpServer(
      {
        name: 'safe',
        command: 'node',
        args: ['```\nfake fence', 'a\u202eb'],
        env: { X: 'y`z' },
      },
      session,
    );
    const cardContent = JSON.parse(delivered[0].content) as Record<string, unknown>;

    const posts: Array<{ threadId: string; message: AdapterPostableMessage }> = [];
    const bridge = createChatSdkBridge({
      adapter: {
        name: 'stub',
        postMessage: async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
          posts.push({ threadId, message });
          return { id: 'msg-stub', threadId, raw: {} };
        },
      } as unknown as Adapter,
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, { kind: 'chat-sdk', content: cardContent });

    expect(posts).toHaveLength(1);
    const msg = posts[0].message as { card?: { children?: Array<{ type?: string; content?: string }> } };
    const text = msg.card?.children?.find((c) => c.type === 'text')?.content ?? '';
    expect(text.split('```')).toHaveLength(3);
    expect(text).toContain('\\u0060');
    expect(text).not.toContain('\u202e');
    expect(text).toContain('\\u202e');
  });
});
