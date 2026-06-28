import { describe, it, expect, vi } from 'vitest';
import {
  isTablePrimary,
  hasRichOnlyConstruct,
  hasTDesktopCrashShape,
  stripCode,
  richTablesEnabled,
  richConstructsEnabled,
  isRichCapabilityError,
  chatIdFromTid,
  sendRichMessageRaw,
  wrapTelegramRichSend,
  RICH_MESSAGE_MAX_CHARS,
} from './telegram-rich-message.js';

const TABLE = ['| # | Titel | Typ |', '|---|-------|-----|', '| 1 | foo | bug |'].join('\n');

describe('isTablePrimary', () => {
  it('detects a GFM pipe table (with or without prose around it)', () => {
    expect(isTablePrimary(TABLE)).toBe(true);
    expect(isTablePrimary('intro\n\n' + TABLE + '\n\noutro')).toBe(true);
    expect(isTablePrimary('a | b | c\n:--- | ---: | :--:\nx | y | z')).toBe(true);
  });
  it('rejects prose, single-dash rows, and a table shown inside code', () => {
    expect(isTablePrimary('just text')).toBe(false);
    expect(isTablePrimary('| a | b |\n| - | - |\n| 1 | 2 |')).toBe(false);
    expect(isTablePrimary('example:\n```\n' + TABLE + '\n```')).toBe(false);
  });
});

describe('hasRichOnlyConstruct', () => {
  it('matches MarkdownV2-impossible constructs', () => {
    expect(hasRichOnlyConstruct('## Heading\ntext')).toBe(true);
    expect(hasRichOnlyConstruct('<details><summary>x</summary>y</details>')).toBe(true);
    expect(hasRichOnlyConstruct('above\n\n---\n\nbelow')).toBe(true);
    expect(hasRichOnlyConstruct('a $$x^2$$ b')).toBe(true);
    expect(hasRichOnlyConstruct('- [ ] todo')).toBe(true);
  });
  it('leaves plain MarkdownV2 content alone', () => {
    expect(hasRichOnlyConstruct('*bold* _italic_ `code`')).toBe(false);
    expect(hasRichOnlyConstruct('- one\n- two')).toBe(false);
    expect(hasRichOnlyConstruct('> a quote')).toBe(false);
  });
  it('does not match constructs shown inside code (copyability fix)', () => {
    expect(hasRichOnlyConstruct('discuss `<details>` and `##` in backticks')).toBe(false);
    expect(hasRichOnlyConstruct('fenced:\n```\n## h\n---\n```\ntext')).toBe(false);
  });
});

describe('stripCode', () => {
  it('removes fenced blocks and inline spans', () => {
    expect(stripCode('a `x` b\n```\nblock\n```\nc').includes('block')).toBe(false);
    expect(stripCode('a `x` b').includes('x')).toBe(false);
  });
});

describe('hasTDesktopCrashShape', () => {
  it('flags math inside a details fold, ignores other shapes', () => {
    expect(hasTDesktopCrashShape('<details><summary>m</summary>\n$$x$$\n</details>')).toBe(true);
    expect(hasTDesktopCrashShape('$$x$$\n\n<details>plain</details>')).toBe(false);
    expect(hasTDesktopCrashShape('docs: `<details>$$x$$</details>` span')).toBe(false);
  });
});

describe('toggles', () => {
  it('default ON, OFF for explicit falsey', () => {
    expect(richTablesEnabled({})).toBe(true);
    expect(richConstructsEnabled({})).toBe(true);
    for (const v of ['false', '0', 'off', 'no', 'FALSE']) {
      expect(richTablesEnabled({ TELEGRAM_RICH_TABLES: v })).toBe(false);
      expect(richConstructsEnabled({ TELEGRAM_RICH_CONSTRUCTS: v })).toBe(false);
    }
  });
});

describe('isRichCapabilityError', () => {
  it('latches on a genuine missing-method, NOT on per-message 400s', () => {
    expect(isRichCapabilityError({ errorCode: 404 })).toBe(true);
    expect(isRichCapabilityError(new Error('Bad Request: unknown method sendRichMessage'))).toBe(true);
    // our own error text contains "RichMessage" — must not be misread as capability
    expect(isRichCapabilityError(new Error('sendRichMessage failed: 400 Bad Request: chat not found'))).toBe(false);
    expect(isRichCapabilityError({ errorCode: 400, message: "can't parse rich_message" })).toBe(false);
  });
});

describe('chatIdFromTid', () => {
  it('strips the telegram: prefix to a numeric chat_id', () => {
    expect(chatIdFromTid('telegram:7754134287')).toBe(7754134287);
    expect(chatIdFromTid('telegram:-1001234567890')).toBe(-1001234567890);
    expect(chatIdFromTid('7754134287')).toBe(7754134287);
  });
});

describe('sendRichMessageRaw', () => {
  it('POSTs raw markdown + numeric chat_id, returns a RawMessage', async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    })) as unknown as typeof fetch;
    const out = await sendRichMessageRaw({ token: 'T', fetchImpl }, 'telegram:-100123', TABLE, 9);
    expect(out).toEqual({ id: '42', raw: { message_id: 42 }, threadId: 'telegram:-100123' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/botT/sendRichMessage');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.chat_id).toBe(-100123);
    expect(body.rich_message).toEqual({ markdown: TABLE });
    expect(body.reply_parameters).toEqual({ message_id: 9 });
  });
  it('throws (caller falls back) on ok:false, tagging the code', async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ ok: false, error_code: 404, description: 'Not Found' }),
    })) as unknown as typeof fetch;
    await expect(sendRichMessageRaw({ token: 'T', fetchImpl }, '1', TABLE)).rejects.toMatchObject({ errorCode: 404 });
  });
  it('respects the char cap constant', () => {
    expect(RICH_MESSAGE_MAX_CHARS).toBe(32768);
  });
});

describe('wrapTelegramRichSend', () => {
  function stubAdapter(calls: { rich: number; plain: number }) {
    return {
      postMessage: async (_tid: string, _m: { markdown?: string }) => {
        calls.plain++;
        return { id: 'p', threadId: _tid, raw: {} };
      },
    };
  }
  it('routes a table to the rich endpoint, falls back on non-table', async () => {
    const richFetch = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    })) as unknown as typeof fetch;
    // patch global fetch used by sendRichMessageRaw
    const origFetch = globalThis.fetch;
    globalThis.fetch = richFetch;
    try {
      const calls = { rich: 0, plain: 0 };
      const a = wrapTelegramRichSend(stubAdapter(calls), { token: 'T', richTables: true, richConstructs: true });
      await a.postMessage('telegram:123', { markdown: TABLE }); // table → rich
      await a.postMessage('telegram:123', { markdown: 'plain text' }); // → original
      expect((richFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      expect(calls.plain).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
  it('is a no-op passthrough when both toggles are off', async () => {
    const calls = { rich: 0, plain: 0 };
    const a = wrapTelegramRichSend(stubAdapter(calls), { token: 'T', richTables: false, richConstructs: false });
    await a.postMessage('telegram:123', { markdown: TABLE });
    expect(calls.plain).toBe(1);
  });
});
