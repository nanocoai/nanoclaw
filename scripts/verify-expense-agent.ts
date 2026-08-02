import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PlayboxServer, type MaterializedPlayboxInbound } from '../src/channels/playbox/server';
import type { PlayboxEvent } from '../src/channels/playbox/protocol';

export class AcceptanceFailure extends Error {}

type ReceiptRow = {
  sourceKey: string;
  receiptId: string;
  vendor: string;
  date: string;
  total: number;
  currency: 'HKD';
  category: string;
  trashed: boolean;
  owner: string;
};

type ScenarioResult = { scenario: string; status: 'passed'; durationMs: number };

const REDACTIONS: Array<[RegExp, string]> = [
  [/authorization\s*:\s*bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]'],
  [/\bbody\s*=\s*\S+/gi, 'body=[REDACTED]'],
  [/\b(?:message|inbound|source)(?:Id|Key)?\s*=\s*\S+/gi, 'messageId=[REDACTED]'],
  [/\breceiptId\s*=\s*\S+/gi, 'receiptId=[REDACTED]'],
];

export function redactDiagnostic(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

export function assertUniqueReceiptSources(rows: Array<Pick<ReceiptRow, 'sourceKey' | 'receiptId'>>): void {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.sourceKey, (counts.get(row.sourceKey) ?? 0) + 1);
  const duplicate = [...counts.entries()].find(([, count]) => count !== 1);
  if (duplicate) throw new AcceptanceFailure('duplicate backend rows for messageId=[REDACTED]');
}

export class PlayboxEventClient {
  private readonly events: PlayboxEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private controller?: AbortController;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private readLoop?: Promise<void>;

  constructor(
    private readonly baseUrl: string,
    private readonly deadlineMs = 120_000,
  ) {}

  async connect(): Promise<void> {
    this.controller = new AbortController();
    const response = await fetch(`${this.baseUrl}/events`, { signal: this.controller.signal });
    if (!response.ok || !response.body) throw new AcceptanceFailure(`SSE connection failed: ${response.status}`);
    this.reader = response.body.getReader();
    this.readLoop = this.consume(this.reader);
  }

  close(): void {
    this.controller?.abort();
    void this.reader?.cancel().catch(() => undefined);
  }

  private async consume(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          if (data) {
            this.events.push(JSON.parse(data) as PlayboxEvent);
            for (const wake of this.waiters) wake();
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    }
  }

  private async waitFor(predicate: (event: PlayboxEvent) => boolean, label: string): Promise<PlayboxEvent> {
    const deadline = Date.now() + this.deadlineMs;
    while (Date.now() < deadline) {
      const index = this.events.findIndex(predicate);
      if (index >= 0) return this.events.splice(index, 1)[0]!;
      await new Promise<void>((resolve, reject) => {
        const remaining = deadline - Date.now();
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new AcceptanceFailure(`scenario deadline exceeded waiting for ${label}`));
        }, Math.max(1, remaining));
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
    throw new AcceptanceFailure(`scenario deadline exceeded waiting for ${label}`);
  }

  async waitForDelivery(inboundId: string): Promise<PlayboxEvent> {
    return this.waitFor(
      (event) => event.type === 'delivery' && event.inboundId === inboundId,
      'messageId=[REDACTED]',
    );
  }

  async waitForOutbound(inboundId: string): Promise<string> {
    const event = await this.waitFor(
      (candidate) => candidate.type === 'outbound' && candidate.text.startsWith(`[inbound:${inboundId}]`),
      'confirmation for messageId=[REDACTED]',
    );
    return (event as Extract<PlayboxEvent, { type: 'outbound' }>).text.replace(/^\[inbound:[^\]]+\]\s*/, '');
  }

  async expectNoOutbound(inboundId: string, quietMs = 80): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    if (
      this.events.some(
        (candidate) => candidate.type === 'outbound' && candidate.text.startsWith(`[inbound:${inboundId}]`),
      )
    ) {
      throw new AcceptanceFailure('unexpected reply for messageId=[REDACTED]');
    }
  }
}

class LocalExpenseDouble {
  readonly rows: ReceiptRow[] = [];
  private readonly pending = new Map<string, { sourceKey: string; vendor: string }>();
  private readonly lastReceipt = new Map<string, string>();

  constructor(private readonly emit: (event: PlayboxEvent) => void, private readonly takeFault: () => string | undefined) {}

  private reply(message: MaterializedPlayboxInbound, text: string): void {
    this.emit({ type: 'outbound', id: `local-${crypto.randomUUID()}`, text: `[inbound:${message.id}] ${text}`, files: [] });
  }

  private save(
    message: MaterializedPlayboxInbound,
    values: Pick<ReceiptRow, 'vendor' | 'total' | 'category'>,
    sourceKey = message.id,
    language: 'en' | 'zh' = 'en',
  ): ReceiptRow {
    const prior = this.rows.find((row) => row.sourceKey === sourceKey);
    if (prior) {
      this.reply(message, `Duplicate: prior outcome ${prior.receiptId}; no new receipt saved.`);
      return prior;
    }
    const row: ReceiptRow = {
      sourceKey,
      receiptId: `receipt-${this.rows.length + 1}`,
      vendor: values.vendor,
      date: '2026-08-02',
      total: values.total,
      currency: 'HKD',
      category: values.category,
      trashed: false,
      owner: message.senderId,
    };
    this.rows.push(row);
    this.lastReceipt.set(message.senderId, row.receiptId);
    const fields = `${row.vendor} | ${row.date} | HKD ${row.total.toFixed(2)} | ${row.category} | ${row.receiptId}`;
    this.reply(
      message,
      language === 'zh'
        ? `已儲存：${fields}。回覆以更改欄位或將此收據移至垃圾桶。`
        : `Saved: ${fields}. Reply to change a field or move this receipt to Trash.`,
    );
    return row;
  }

  async inbound(message: MaterializedPlayboxInbound): Promise<void> {
    if (message.senderId === 'playbox:guest') return;
    const fault = this.takeFault();
    if (fault) {
      this.reply(message, `Not saved yet: retryable ${fault}. Retry safely with the same source.`);
      return;
    }
    const text = message.text.trim();
    const pending = this.pending.get(message.senderId);
    if (pending && /^\$?\d+(?:\.\d{1,2})?$/.test(text)) {
      this.pending.delete(message.senderId);
      this.save(message, { vendor: pending.vendor, total: Number(text.replace('$', '')), category: 'Transport' }, pending.sourceKey);
      return;
    }
    if (message.attachments.length > 0) {
      const outcomes: string[] = [];
      for (const [index, attachment] of message.attachments.entries()) {
        const sourceKey = `${message.id}:${index + 1}`;
        if (attachment.name.includes('unclear')) {
          outcomes.push(`${index + 1}/${message.attachments.length} Needs clarification: what is the total?`);
          continue;
        }
        const grocery = attachment.name.includes('grocery');
        const row = this.save(
          message.attachments.length === 1 ? message : { ...message, id: `${message.id}-item-${index + 1}` },
          grocery
            ? { vendor: 'Harbour Grocery', total: 128.4, category: 'Groceries' }
            : { vendor: 'Coffee Corner', total: 42, category: 'Dining' },
          sourceKey,
        );
        outcomes.push(`${index + 1}/${message.attachments.length} Saved ${row.receiptId}`);
      }
      if (message.attachments.length > 1) this.reply(message, outcomes.join('\n'));
      return;
    }
    if (/^expense:\s*Taxi\s*$/i.test(text)) {
      this.pending.set(message.senderId, { sourceKey: message.id, vendor: 'Taxi' });
      this.reply(message, 'What is the total?');
      return;
    }
    if (/^expense:/i.test(text)) {
      const total = Number(text.match(/(\d+(?:\.\d{1,2})?)/)?.[1] ?? '25');
      const sourceKey = text.match(/source:([\w:-]+)/)?.[1] ?? message.id;
      this.save(message, { vendor: text.includes('Book') ? 'Book Shop' : 'Text Expense', total, category: 'Other' }, sourceKey);
      return;
    }
    if (/^收據:/u.test(text)) {
      const total = Number(text.match(/(\d+(?:\.\d{1,2})?)/)?.[1] ?? '36');
      this.save(message, { vendor: '茶餐廳', total, category: '餐飲' }, message.id, 'zh');
      return;
    }
    const lastId = this.lastReceipt.get(message.senderId);
    const last = this.rows.find((row) => row.receiptId === lastId);
    if (/change total to/i.test(text) && last) {
      last.total = Number(text.match(/\d+(?:\.\d{1,2})?/)?.[0] ?? last.total);
      this.reply(message, `Updated: ${last.receiptId} total HKD ${last.total.toFixed(2)}.`);
      return;
    }
    if (/move.*trash|trash/i.test(text) && last) {
      last.trashed = true;
      this.reply(message, `Moved ${last.receiptId} to Trash; not permanently deleted.`);
      return;
    }
    if (/restore/i.test(text) && last) {
      last.trashed = false;
      this.reply(message, `Restored ${last.receiptId}.`);
      return;
    }
    if (/recent receipts/i.test(text)) {
      this.reply(message, `Recent receipts: ${this.rows.filter((row) => !row.trashed).length}.`);
      return;
    }
    if (/this month/i.test(text)) {
      const rows = this.rows.filter((row) => !row.trashed);
      const total = rows.reduce((sum, row) => sum + row.total, 0);
      this.reply(message, `2026-08-01 to 2026-08-31: HKD ${total.toFixed(2)}; categories and vendors match ${rows.length} receipts.`);
    }
  }
}

function requireText(text: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    if (!pattern.test(text)) throw new AcceptanceFailure(`missing confirmation field: ${pattern.source}`);
  }
}

function message(id: string, senderId: 'playbox:alice' | 'playbox:bob' | 'playbox:guest', text: string, attachments: Array<{ name: string; type: 'image/png' | 'application/pdf'; dataBase64: string }> = []) {
  return { id, senderId, senderName: senderId.split(':')[1]!, text, timestamp: new Date().toISOString(), attachments };
}

async function post(baseUrl: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function runLocalScenarios(baseUrl: string, reportPath?: string): Promise<ScenarioResult[]> {
  let server!: PlayboxServer;
  let double!: LocalExpenseDouble;
  server = new PlayboxServer({
    port: Number(new URL(baseUrl).port || '3210'),
    onInbound: (inbound) => double.inbound(inbound),
  });
  double = new LocalExpenseDouble(
    (event) => server.emit(event),
    () => server.takeFault()?.kind,
  );
  await server.start();
  const events = new PlayboxEventClient(baseUrl);
  const results: ScenarioResult[] = [];
  await events.connect();

  const run = async (scenario: string, fn: () => Promise<void>) => {
    const started = Date.now();
    try {
      await fn();
      assertUniqueReceiptSources(double.rows);
      results.push({ scenario, status: 'passed', durationMs: Date.now() - started });
    } catch (error) {
      throw new AcceptanceFailure(`${scenario}: ${redactDiagnostic(error)}`);
    }
  };

  const send = async (payload: ReturnType<typeof message>, expectReply = true) => {
    const response = await post(baseUrl, '/api/messages', payload);
    if (!response.ok) throw new AcceptanceFailure(`messageId=${payload.id} rejected with ${response.status}; body=${await response.text()}`);
    await events.waitForDelivery(payload.id);
    if (!expectReply) {
      await events.expectNoOutbound(payload.id);
      return '';
    }
    return events.waitForOutbound(payload.id);
  };

  try {
    await run('1. clear image auto-save', async () => {
      const out = await send(message('s1-image', 'playbox:alice', '', [{ name: 'coffee.png', type: 'image/png', dataBase64: 'AA==' }]));
      requireText(out, [/Saved:/, /Coffee Corner/, /2026-08-02/, /HKD 42\.00/, /Dining/, /receipt-/, /Reply to change/]);
    });
    await run('2. incomplete text clarification', async () => {
      requireText(await send(message('s2-text', 'playbox:alice', 'expense: Taxi')), [/What is the total/]);
      requireText(await send(message('s2-reply', 'playbox:alice', '18')), [/Saved:/, /Taxi/, /HKD 18\.00/]);
      if (double.rows.filter((row) => row.sourceKey === 's2-text').length !== 1) throw new AcceptanceFailure('missing or duplicate backend rows');
    });
    await run('3. correction and app query', async () => {
      const out = await send(message('s3-correct', 'playbox:alice', 'change total to 45'));
      requireText(out, [/Updated:/, /HKD 45\.00/]);
      if (!double.rows.some((row) => row.total === 45)) throw new AcceptanceFailure('app query did not return changed total');
    });
    await run('4. ordered two-receipt batch', async () => {
      const out = await send(message('s4-batch', 'playbox:alice', '', [
        { name: 'coffee.png', type: 'image/png', dataBase64: 'AA==' },
        { name: 'grocery.pdf', type: 'application/pdf', dataBase64: 'AA==' },
      ]));
      requireText(out, [/1\/2 Saved/, /2\/2 Saved/]);
    });
    await run('5. mixed valid and unclear batch', async () => {
      const before = double.rows.length;
      const out = await send(message('s5-mixed', 'playbox:alice', '', [
        { name: 'grocery.pdf', type: 'application/pdf', dataBase64: 'AA==' },
        { name: 'unclear.png', type: 'image/png', dataBase64: 'AA==' },
      ]));
      requireText(out, [/1\/2 Saved/, /2\/2 Needs clarification: what is the total/]);
      if (double.rows.length !== before + 1) throw new AcceptanceFailure('valid batch item was not independently saved');
    });
    await run('6. exact-source resend idempotency', async () => {
      await send(message('s6-first', 'playbox:alice', 'expense: Book 60 source:resend-source'));
      const out = await send(message('s6-resend-transport', 'playbox:alice', 'expense: Book 60 source:resend-source'));
      requireText(out, [/Duplicate:/, /no new receipt saved/]);
      if (double.rows.filter((row) => row.sourceKey === 'resend-source').length !== 1) throw new AcceptanceFailure('duplicate backend rows');
    });
    await run('7. concurrent Alice and Bob isolation', async () => {
      const [alice, bob] = await Promise.all([
        send(message('s7-alice', 'playbox:alice', 'expense: Alice 71')),
        send(message('s7-bob', 'playbox:bob', 'expense: Bob 72')),
      ]);
      requireText(alice, [/HKD 71\.00/]);
      requireText(bob, [/HKD 72\.00/]);
    });
    await run('8. unrelated ignored and Guest denied', async () => {
      await Promise.all([
        send(message('s8-unrelated', 'playbox:alice', 'Dinner at 7?'), false),
        send(message('s8-guest', 'playbox:guest', 'expense: Guest 99'), false),
      ]);
      if (double.rows.some((row) => row.owner === 'playbox:guest')) throw new AcceptanceFailure('Guest created a backend row');
    });
    await run('9. retryable faults and idempotent recovery', async () => {
      for (const [index, kind] of ['parser_timeout', 'api_429', 'api_500'].entries()) {
        await post(baseUrl, '/api/faults', { kind, count: 1 });
        requireText(await send(message(`s9-fault-${index}`, 'playbox:alice', `expense: Retry ${80 + index}`)), [/Not saved yet:/, /retryable/]);
        requireText(await send(message(`s9-retry-${index}`, 'playbox:alice', `expense: Retry ${80 + index} source:s9-fault-${index}`)), [/Saved:/]);
      }
    });
    await run('10. recent and summary parity', async () => {
      requireText(await send(message('s10-recent', 'playbox:alice', 'recent receipts')), [/Recent receipts:/]);
      const out = await send(message('s10-summary', 'playbox:alice', 'summary this month'));
      requireText(out, [/2026-08-01 to 2026-08-31/, /categories and vendors match/]);
    });
    await run('11. Trash and restore only', async () => {
      requireText(await send(message('s11-trash', 'playbox:bob', 'move it to Trash')), [/to Trash/, /not permanently deleted/]);
      requireText(await send(message('s11-restore', 'playbox:bob', 'restore it')), [/Restored/]);
      if (double.rows.some((row) => row.trashed)) throw new AcceptanceFailure('restore did not return receipt');
    });
    await run('12. English and Traditional Chinese', async () => {
      requireText(await send(message('s12-en', 'playbox:alice', 'expense: Lunch 33')), [/Saved:/, /Reply to change/]);
      requireText(await send(message('s12-zh', 'playbox:bob', '收據: 茶餐廳 36')), [/已儲存/, /回覆以更改欄位/]);
    });
  } finally {
    events.close();
    await server.stop();
  }

  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({ mode: 'local-deterministic-double', passed: results.length, failed: 0, scenarios: results }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
  return results;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (!process.argv.includes('--local-double')) {
    throw new AcceptanceFailure(
      'live mode is deferred; pass --local-double for the local acceptance gate after stopping the NanoClaw playbox service',
    );
  }
  const baseUrl = arg('--base-url') ?? 'http://127.0.0.1:3210';
  const report = arg('--report');
  const results = await runLocalScenarios(baseUrl, report);
  process.stdout.write(JSON.stringify({ mode: 'local-deterministic-double', passed: results.length, failed: 0 }) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`expense-agent acceptance failed: ${redactDiagnostic(error)}\n`);
    process.exitCode = 1;
  });
}
