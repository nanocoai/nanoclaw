import type { ToolInput, ToolName } from './contracts.js';
import { parseToolInput } from './contracts.js';
import { resolveReceiptMedia } from './media.js';
import { redactError } from './redaction.js';

type Method = 'GET' | 'POST' | 'PATCH';
type Route = { method: Method; path: string };

const encodeId = (value: unknown): string => encodeURIComponent(String(value));

export function routeFor(name: ToolName, input: Record<string, unknown>): Route {
  switch (name) {
    case 'submit_receipt_media':
    case 'submit_text_expense':
      return { method: 'POST', path: '/v1/agent/intakes' };
    case 'get_pending_intakes':
      return { method: 'GET', path: '/v1/agent/intakes/pending' };
    case 'clarify_intake':
      return { method: 'POST', path: `/v1/agent/intakes/${encodeId(input.intakeId)}/clarify` };
    case 'update_receipt':
      return { method: 'PATCH', path: `/v1/agent/receipts/${encodeId(input.receiptId)}` };
    case 'trash_receipt':
      return { method: 'POST', path: `/v1/agent/receipts/${encodeId(input.receiptId)}/trash` };
    case 'restore_receipt':
      return { method: 'POST', path: `/v1/agent/receipts/${encodeId(input.receiptId)}/restore` };
    case 'list_recent_receipts':
      return { method: 'GET', path: '/v1/agent/receipts/recent' };
    case 'get_spending_summary':
      return { method: 'GET', path: '/v1/agent/reports/spending' };
  }
}

interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  downloadsRoot?: string;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function query(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export class NdExpenseClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly downloadsRoot: string;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    const parsed = new URL(baseUrl);
    const isLoopbackTest = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLoopbackTest) throw new Error('ND Expense API base URL must use HTTPS');
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('Invalid ND Expense API base URL');
    this.baseUrl = parsed;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? delay;
    this.random = options.random ?? Math.random;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 60_000;
    this.downloadsRoot = options.downloadsRoot ?? '/workspace/downloads';
  }

  async call<T extends ToolName>(name: T, rawInput: unknown): Promise<unknown> {
    const input = parseToolInput(name, rawInput) as ToolInput<T> & Record<string, unknown>;
    const route = routeFor(name, input);
    const idempotent = route.method === 'GET' || (name.startsWith('submit_') && typeof input.sourceKey === 'string');
    const total = new AbortController();
    const totalTimer = setTimeout(() => total.abort(new Error('total deadline exceeded')), this.totalTimeoutMs);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const connect = new AbortController();
        const connectTimer = setTimeout(
          () => connect.abort(new Error('connect deadline exceeded')),
          this.connectTimeoutMs,
        );
        try {
          const headers = new Headers({ 'X-Request-ID': crypto.randomUUID() });
          let body: BodyInit | undefined;
          let suffix = '';
          if (route.method === 'GET') {
            suffix = query(input);
          } else if (name === 'submit_receipt_media') {
            const form = new FormData();
            form.set('sourceKey', String(input.sourceKey));
            form.set('inputKind', 'media');
            if (input.text) form.set('text', String(input.text));
            if (input.batchKey) form.set('batchKey', String(input.batchKey));
            const media = await resolveReceiptMedia(input.attachmentPaths as string[], this.downloadsRoot);
            for (const item of media) form.append('files', item.file, item.name);
            body = form;
            headers.set('Idempotency-Key', String(input.sourceKey));
          } else {
            headers.set('Content-Type', 'application/json');
            if (name === 'submit_text_expense') {
              headers.set('Idempotency-Key', String(input.sourceKey));
              body = JSON.stringify({ ...input, inputKind: 'text' });
            } else if (name === 'clarify_intake') {
              body = JSON.stringify({ field: input.field, value: input.value });
            } else if (name === 'update_receipt') {
              body = JSON.stringify(input.changes);
            }
          }
          const response = await this.fetchImpl(new URL(`${route.path}${suffix}`, this.baseUrl), {
            method: route.method,
            headers,
            body,
            signal: AbortSignal.any([total.signal, connect.signal]),
          });
          clearTimeout(connectTimer);
          if ((response.status === 429 || response.status >= 500) && idempotent && attempt < 2) {
            await this.sleep(Math.min(1_000, 250 * 2 ** attempt * this.random()));
            continue;
          }
          if (!response.ok) throw new Error(`ND Expense request failed (${response.status})`);
          const payload = (await response.json()) as { success?: boolean; data?: unknown };
          if (!payload.success) throw new Error('ND Expense returned an invalid response');
          return payload.data;
        } catch (error) {
          clearTimeout(connectTimer);
          if (idempotent && attempt < 2 && (error instanceof TypeError || connect.signal.aborted)) {
            await this.sleep(Math.min(1_000, 250 * 2 ** attempt * this.random()));
            continue;
          }
          throw new Error(`ND Expense request failed: ${redactError(error)}`);
        }
      }
      throw new Error('ND Expense request failed after retries');
    } finally {
      clearTimeout(totalTimer);
    }
  }
}
