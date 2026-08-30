/**
 * nanoclaw-mailbox — the channel server (terminal-architecture phase 2).
 *
 * An MCP stdio server claude spawns from the workspace .mcp.json. It declares
 * the `claude/channel` capability, forwards spool entries from the mailbox
 * delivery loop as `notifications/claude/channel` events, and exposes one
 * `reply` tool that writes the group outbox through the exact same code path
 * as `ncl outbox send`.
 *
 * It holds NO delivery authority: claims, acks, retries and the durable
 * inbound/outbound record contract all stay in the delivery loop
 * (mailbox.ts) — and the store behind that contract is whatever the
 * deployment registered, not this server's business. Channels give no
 * delivery acknowledgment — a notification "sent" is only written to the
 * transport, and an unloaded/org-blocked channel drops it silently — so the
 * hook-evidence ack machinery is what makes this transport trustworthy, not
 * anything here. Sender gating is structural: the only inbound path is the
 * loop's spool directory (container-private /tmp), never a network listener.
 *
 * The protocol is hand-rolled, not the MCP SDK: one JSON-RPC 2.0 message per
 * line over stdio, the same hand-synced-wire-contract discipline as the
 * host's ncl socket port. The subset spoken here — initialize, initialized,
 * ping, tools/list, tools/call, and the one outbound notification — is
 * pinned by mailbox-channel.test.ts; if the client ever widens its demands,
 * the test is where that lands. (Contract: code.claude.com/docs/en/
 * channels-reference.md, research preview — expect change.)
 */
import fs from 'fs';

import { outboxSend } from '../cli/mailbox-verbs.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import { CHANNEL_SPOOL_DIR, listSpoolEntries, type SpoolEntry } from './channel-spool.js';
// Capability barrel — this file is its own PROCESS (claude spawns it from the
// workspace .mcp.json), so the singular mailbox slot has to be registered
// here too. Idempotent: an already-loaded barrel is a module-cache hit.
import '../modules/index.js';

const SERVER_NAME = 'nanoclaw-mailbox';

export const CHANNEL_INSTRUCTIONS =
  'Messages from your group mailbox arrive as <channel source="nanoclaw-mailbox" kind="mail|task" ...> events — ' +
  'the same mail `ncl inbox read` shows. Act on them as you would on injected mail. ' +
  'Reply ONLY when a message calls for a response, using the reply tool (it writes the group outbox, ' +
  'identical to `ncl outbox send`); pass reply_to from the tag when answering a specific message.';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

type Send = (msg: Record<string, unknown>) => void;

export interface ChannelServerOptions {
  spoolDir?: string;
  pollMs?: number;
  send?: Send;
  /** Test seam over the outbox write — production is the real outboxSend. */
  sendOutbox?: typeof outboxSend;
}

export class MailboxChannelServer {
  private readonly spoolDir: string;
  private readonly pollMs: number;
  private readonly send: Send;
  private readonly sendOutbox: typeof outboxSend;
  private initialized = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emitting = false;

  constructor(options: ChannelServerOptions = {}) {
    this.spoolDir = options.spoolDir ?? CHANNEL_SPOOL_DIR;
    this.pollMs = options.pollMs ?? 300;
    this.send =
      options.send ?? ((msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`));
    this.sendOutbox = options.sendOutbox ?? outboxSend;
  }

  start(input: NodeJS.ReadableStream = process.stdin): void {
    let buffer = '';
    input.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame: JsonRpcRequest;
        try {
          frame = JSON.parse(line) as JsonRpcRequest;
        } catch (error) {
          console.error(`[${SERVER_NAME}] unparseable frame:`, error);
          continue;
        }
        // handle() is async only because the outbox write is (the mailbox
        // seam's writeMessageOut returns a promise — a sequence over an
        // object store is not a synchronous allocation). Everything else
        // still replies before the first await, so frame order is unchanged
        // for every method but tools/call, whose reply carries its id.
        void this.handle(frame).catch((error) => console.error(`[${SERVER_NAME}] handler failed:`, error));
      }
    });
    // The client owns this process: EOF on stdin means the session is gone.
    input.on('end', () => process.exit(0));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One spool scan — exposed for tests; production runs it on the interval. */
  async emitSpool(): Promise<void> {
    if (!this.initialized || this.emitting) return;
    this.emitting = true;
    try {
      for (const file of listSpoolEntries(this.spoolDir)) {
        let entry: SpoolEntry;
        try {
          entry = JSON.parse(fs.readFileSync(file, 'utf8')) as SpoolEntry;
        } catch {
          // Torn files cannot exist (tmp+rename) — an unreadable entry is
          // debris; leave it for a human rather than crash-loop on it.
          console.error(`[${SERVER_NAME}] unreadable spool entry left in place: ${file}`);
          continue;
        }
        this.send({
          method: 'notifications/claude/channel',
          params: { content: entry.content, meta: entry.meta },
        });
        // Unlink AFTER the transport write: a crash between the two re-emits
        // (duplicates-over-loss); the reverse order would lose the delivery.
        fs.unlinkSync(file);
      }
    } finally {
      this.emitting = false;
    }
  }

  /** One protocol frame — public because it IS the pinned surface (tests drive it directly). */
  async handle(req: JsonRpcRequest): Promise<void> {
    switch (req.method) {
      case 'initialize': {
        this.reply(req, {
          protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
          serverInfo: { name: SERVER_NAME, version: '1.0.0' },
          instructions: CHANNEL_INSTRUCTIONS,
        });
        return;
      }
      case 'notifications/initialized': {
        this.initialized = true;
        this.timer = setInterval(() => void this.emitSpool(), this.pollMs);
        // fs.watch would race mkdir of the spool dir; the poll is the
        // contract, the watch would only be latency sugar.
        return;
      }
      case 'ping': {
        this.reply(req, {});
        return;
      }
      case 'tools/list': {
        this.reply(req, {
          tools: [
            {
              name: 'reply',
              description:
                'Send a message back over the group mailbox (identical to `ncl outbox send`).',
              inputSchema: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'The message to send' },
                  reply_to: {
                    type: 'string',
                    description: 'Optional inbound message id this answers (the reply_to tag attribute)',
                  },
                },
                required: ['text'],
              },
            },
          ],
        });
        return;
      }
      case 'tools/call': {
        const name = req.params?.name;
        if (name !== 'reply') {
          this.error(req, -32602, `unknown tool: ${String(name)}`);
          return;
        }
        const args = (req.params?.arguments ?? {}) as { text?: string; reply_to?: string };
        const frame = await this.sendOutbox({
          text: args.text,
          ...(args.reply_to ? { 'reply-to': args.reply_to } : {}),
        });
        if (frame.ok) {
          this.reply(req, { content: [{ type: 'text', text: 'sent' }] });
        } else {
          this.reply(req, {
            content: [{ type: 'text', text: `outbox refused: ${frame.error?.message ?? 'unknown error'}` }],
            isError: true,
          });
        }
        return;
      }
      default: {
        // Notifications (no id) are ignorable by contract; unknown REQUESTS
        // get a proper method-not-found so the client never hangs on us.
        if (req.id !== undefined) this.error(req, -32601, `method not found: ${req.method}`);
      }
    }
  }

  private reply(req: JsonRpcRequest, result: Record<string, unknown>): void {
    this.send({ id: req.id, result });
  }

  private error(req: JsonRpcRequest, code: number, message: string): void {
    this.send({ id: req.id, error: { code, message } });
  }
}

if (import.meta.main) {
  // The reply tool writes the group outbox, so this process opens the
  // registered mailbox for its own session exactly as `ncl` does — the seam
  // is per-process, and an implementation that is not a file learns WHICH
  // session it serves only from this context. Fatal on purpose: a channel
  // server whose reply tool cannot write is worse than one that never came
  // up, because the agent would believe it had replied.
  //
  // The async IIFE is not decoration: this file is bundled into the host's Node
  // SEA binary, and that target has no top-level await. A bare `await` here is
  // valid TypeScript and valid ESM — `tsc --noEmit` passes it, and so does every
  // gate we run — and then the SEA build refuses it with `"await" can only be
  // used inside an "async" function`, at bundle time, in a bake. Keep it wrapped.
  void (async () => {
    const mailbox = getAgentMailbox();
    await mailbox.start(await readMailboxContext());
    // The spool dir is fixed in production (container-private /tmp); the env
    // override exists for the spike/harness, which run the real server against
    // a scratch dir outside a container.
    const spoolDir = process.env.NANOCLAW_CHANNEL_SPOOL?.trim() || CHANNEL_SPOOL_DIR;
    const server = new MailboxChannelServer({ spoolDir });
    server.start();
    console.error(`[${SERVER_NAME}] channel server up, watching ${spoolDir}`);
  })().catch((err: unknown) => {
    // "Fatal on purpose" was the intent above and an unhandled rejection is not
    // reliably fatal — make it so, and say which process died.
    console.error(`[${SERVER_NAME}] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
