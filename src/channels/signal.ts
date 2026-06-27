/**
 * Signal channel via signal-cli (https://github.com/AsamK/signal-cli).
 *
 * Replaces the WhatsApp/Baileys channel. Privacy posture is better (Signal
 * is E2E with no metadata harvesting), stability is better (signal-cli is
 * officially-blessed-ish; protocol churn is far less aggressive than Baileys'
 * reverse-engineered WhatsApp protocol).
 *
 * Architecture:
 *   - Spawn `signal-cli daemon --socket <path>` as a long-running subprocess.
 *     Single process handles both directions; avoids account-file lock
 *     contention that would occur with concurrent `signal-cli send` /
 *     `signal-cli receive` invocations.
 *   - Connect to that socket and speak JSON-RPC 2.0 over it.
 *   - Inbound: daemon emits `receive` notifications (one per incoming
 *     envelope). Filter for Note-to-Self messages prefixed with the trigger
 *     phrase, strip the prefix, hand to NanoClaw's onMessage callback.
 *   - Outbound: JSON-RPC `send` method. Note-to-Self uses `noteToSelf: true`.
 *
 * Group identity:
 *   - Andy's main group is identified by jid `signal:<phone>` where phone
 *     is the registered signal-cli account. The channel `ownsJid` returns
 *     true for any jid starting with `signal:`.
 *
 * Daemon supervision:
 *   - On daemon exit, schedule a reconnect after 5s (exponential backoff up
 *     to 60s). Keeps the channel resilient to signal-cli crashes / restarts.
 *   - On `disconnect()`, SIGTERM the daemon and wait briefly before SIGKILL.
 */
import { spawn, ChildProcess } from 'child_process';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import net from 'net';
import path from 'path';

import { Channel, NewMessage } from '../types.js';
import { logger as baseLogger } from '../logger.js';
import { runSignalDetector } from '../signal-detector.js';
import { registerChannel, ChannelOpts } from './registry.js';

const SIGNAL_CLI = process.env.SIGNAL_CLI_BIN || '/opt/homebrew/bin/signal-cli';
const ACCOUNT = process.env.SIGNAL_ACCOUNT || '+15129217183';

// signal-cli 0.14.1's --socket (Unix domain socket) on macOS uses a Java
// transport that creates an abstract-namespace socket invisible to ls/lsof's
// file path and unreachable via nc -U or net.createConnection(<path>).
// --tcp avoids all of that. Local-only bind keeps the security posture
// identical to a unix socket.
const SIGNAL_HOST = process.env.SIGNAL_HOST || '127.0.0.1';
const SIGNAL_PORT = parseInt(process.env.SIGNAL_PORT || '17583', 10);
const TRIGGER_RE = /^@andy\b/i;
const SIGNAL_MAX_CHARS = 3500; // Signal client limit is ~4000; leave headroom

// Append-only JSONL archive of every text-bearing envelope the daemon
// delivers. Consumed by bd-brain-sync/scripts/sync_signal.py to write
// per-contact markdown files into the Obsidian vault. The path is in
// nanoclaw's gitignored data dir (no risk of secrets in git).
const INBOX_PATH =
  process.env.SIGNAL_INBOX_PATH ||
  '/Users/Shared/nanoclaw/data/signal-inbox.jsonl';

const logger = baseLogger;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: { message?: string; timestamp?: number };
  syncMessage?: {
    sentMessage?: {
      message?: string;
      destination?: string;
      destinationNumber?: string;
      destinationUuid?: string;
      timestamp?: number;
    };
  };
}

interface ReceiveParams {
  envelope?: SignalEnvelope;
  account?: string;
}

class SignalChannel implements Channel {
  name = 'signal';
  private daemon: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private rpcId = 1;
  private pendingRpc = new Map<
    number,
    {
      resolve: (r: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private rxBuffer = '';
  private connected = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelayMs = 5000;
  private intentionallyClosed = false;
  // True while connect()'s retry loop is in charge of the daemon lifecycle, so
  // the exit/close handlers don't kick off a competing background reconnect.
  private connecting = false;
  // Rolling buffer of the daemon's recent stderr lines, surfaced on abnormal
  // exit so the actual failure reason (e.g. account lock, captcha) is visible.
  private recentStderr: string[] = [];

  constructor(private opts: ChannelOpts) {}

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.connecting = true;
    // Initial boot is brittle: signal-cli sometimes exits before binding its
    // port (e.g. a stale account lock from a not-yet-dead prior daemon). Retry
    // with backoff here instead of throwing — a single flap should not take the
    // whole process down and rely on launchd to relaunch everything.
    const maxAttempts = 6;
    let delay = 2000;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.spawnDaemonAndConnect();
          return;
        } catch (err) {
          await this.cleanupDaemon();
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt >= maxAttempts) {
            logger.error(
              { err: msg, attempt },
              'signal channel failed to connect after retries; handing off to background reconnect',
            );
            // Don't crash the process — let scheduleRestart keep trying so the
            // rest of NanoClaw boots and Signal self-heals once it can.
            if (!this.intentionallyClosed) this.scheduleRestart();
            return;
          }
          logger.warn(
            { err: msg, attempt, maxAttempts, delayMs: delay },
            'signal channel initial connect failed; retrying',
          );
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 30_000);
        }
      }
    } finally {
      this.connecting = false;
    }
  }

  // Tear down a half-spawned daemon/socket before a retry so each attempt
  // starts clean and any lock held by the dying daemon is released.
  private async cleanupDaemon(): Promise<void> {
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.destroy();
      } catch {
        // best effort
      }
      this.socket = null;
    }
    if (this.daemon && !this.daemon.killed) {
      try {
        this.daemon.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 500));
        if (this.daemon && !this.daemon.killed) this.daemon.kill('SIGKILL');
      } catch {
        // best effort
      }
    }
    this.daemon = null;
    this.connected = false;
  }

  private async spawnDaemonAndConnect(): Promise<void> {
    logger.info(
      { account: ACCOUNT, host: SIGNAL_HOST, port: SIGNAL_PORT },
      'starting signal-cli daemon',
    );
    this.daemon = spawn(
      SIGNAL_CLI,
      [
        '-a',
        ACCOUNT,
        'daemon',
        '--tcp',
        `${SIGNAL_HOST}:${SIGNAL_PORT}`,
        '--receive-mode',
        'on-start',
        '--no-receive-stdout',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.recentStderr = [];
    let daemonExited: { code: number | null; signal: string | null } | null =
      null;

    this.daemon.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      logger.debug({ line: text }, 'signal-cli stderr');
      // Keep the last 20 lines so an abnormal exit can report the real reason.
      for (const l of text.split('\n')) {
        this.recentStderr.push(l);
        if (this.recentStderr.length > 20) this.recentStderr.shift();
      }
    });

    this.daemon.on('exit', (code, signal) => {
      daemonExited = { code, signal };
      if (code != null && code !== 0) {
        logger.warn(
          { code, signal, stderr: this.recentStderr.slice(-10) },
          'signal-cli daemon exited abnormally',
        );
      } else {
        logger.warn({ code, signal }, 'signal-cli daemon exited');
      }
      this.connected = false;
      this.daemon = null;
      // While connect()'s retry loop is active it owns retries; only the
      // background path (a drop after a good connection) self-schedules here.
      if (!this.intentionallyClosed && !this.connecting) this.scheduleRestart();
    });

    await this.waitForPort(
      SIGNAL_HOST,
      SIGNAL_PORT,
      30_000,
      () => daemonExited,
    );

    this.socket = net.createConnection({
      host: SIGNAL_HOST,
      port: SIGNAL_PORT,
    });
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.onSocketData(chunk));
    this.socket.on('error', (err) => {
      logger.warn({ err: err.message }, 'signal socket error');
    });
    this.socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      if (!this.intentionallyClosed && !this.connecting) this.scheduleRestart();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('signal socket connect timeout')),
        5000,
      );
      this.socket!.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.connected = true;
    this.restartDelayMs = 5000; // reset backoff on successful connect
    logger.info('signal channel connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('Signal channel not connected');
    const recipient = jidToRecipient(jid);
    const isNoteToSelf = recipient === ACCOUNT;

    for (const chunk of chunkMessage(text, SIGNAL_MAX_CHARS)) {
      const params: Record<string, unknown> = { message: chunk };
      if (isNoteToSelf) {
        params.noteToSelf = true;
      } else {
        params.recipient = [recipient];
      }
      await this.rpc('send', params);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // Reject pending RPCs so callers don't hang forever.
    for (const [, p] of this.pendingRpc) {
      clearTimeout(p.timer);
      p.reject(new Error('Signal channel disconnecting'));
    }
    this.pendingRpc.clear();

    this.socket?.end();
    this.socket = null;

    if (this.daemon && !this.daemon.killed) {
      this.daemon.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
      if (this.daemon && !this.daemon.killed) {
        this.daemon.kill('SIGKILL');
      }
    }
    this.daemon = null;
    this.connected = false;
  }

  private appendToInbox(record: {
    envelope: unknown;
    received_at: string;
  }): void {
    try {
      const dir = path.dirname(INBOX_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(INBOX_PATH, JSON.stringify(record) + '\n');
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          path: INBOX_PATH,
        },
        'failed to append to signal inbox JSONL',
      );
    }
  }

  private async waitForPort(
    host: string,
    port: number,
    timeoutMs: number,
    hasExited?: () => { code: number | null; signal: string | null } | null,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Fail fast instead of burning the full timeout when the daemon has
      // already died (the common code-3 flap) — lets connect() retry sooner.
      const exited = hasExited?.();
      if (exited) {
        throw new Error(
          `signal-cli daemon exited before binding ${host}:${port} (code ${exited.code}, signal ${exited.signal})`,
        );
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const probe = net.createConnection({ host, port });
          probe.once('connect', () => {
            probe.end();
            resolve();
          });
          probe.once('error', reject);
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(
      `signal-cli did not accept connections at ${host}:${port} within ${timeoutMs}ms`,
    );
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 60_000);
    logger.info({ delayMs: delay }, 'scheduling signal channel reconnect');
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.spawnDaemonAndConnect();
      } catch (err) {
        logger.error({ err }, 'signal channel reconnect failed; retrying');
        this.scheduleRestart();
      }
    }, delay);
  }

  private onSocketData(chunk: string): void {
    this.rxBuffer += chunk;
    let nl: number;
    while ((nl = this.rxBuffer.indexOf('\n')) !== -1) {
      const line = this.rxBuffer.slice(0, nl).trim();
      this.rxBuffer = this.rxBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.handleRpcMessage(msg);
      } catch (err) {
        logger.warn(
          { err, line: line.slice(0, 200) },
          'malformed JSON from signal-cli',
        );
      }
    }
  }

  private handleRpcMessage(msg: Record<string, unknown>): void {
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const handler = this.pendingRpc.get(msg.id);
      if (handler) {
        clearTimeout(handler.timer);
        this.pendingRpc.delete(msg.id);
        const r = msg as unknown as JsonRpcResponse;
        if (r.error)
          handler.reject(new Error(`${r.error.code}: ${r.error.message}`));
        else handler.resolve(r.result);
      }
    } else if (msg.method === 'receive' && msg.params) {
      this.handleInbound(msg.params as ReceiveParams);
    }
  }

  private handleInbound(params: ReceiveParams): void {
    const env = params.envelope;
    if (!env) return;

    const source = env.sourceNumber || env.source;
    let text: string | undefined;
    let destination: string | undefined;
    let timestamp: number | undefined;

    if (env.dataMessage?.message) {
      text = env.dataMessage.message;
      timestamp = env.dataMessage.timestamp || env.timestamp;
      // dataMessage is a message TO us from `source`. Not Note-to-Self.
      destination = ACCOUNT;
    } else if (env.syncMessage?.sentMessage?.message) {
      // syncMessage: this device's primary sent something; we're receiving the sync copy.
      const sent = env.syncMessage.sentMessage;
      text = sent.message;
      timestamp = sent.timestamp || env.timestamp;
      destination = sent.destinationNumber || sent.destination;
    }

    if (!text) return;

    // Archive every text-bearing envelope to the inbox JSONL BEFORE the
    // @andy trigger filter, so the archive is complete (sync_signal.py
    // can write all DMs to the vault, not just trigger phrases).
    this.appendToInbox({
      envelope: env,
      received_at: new Date().toISOString(),
    });

    // Note-to-Self determination is needed by BOTH the signal-detector
    // escalation logic (below) and the @andy trigger filter (further down),
    // so compute it once here.
    const isNoteToSelf =
      !!env.syncMessage?.sentMessage &&
      destination === ACCOUNT &&
      source === ACCOUNT;

    // Fire-and-forget signal-detector. Two-pass capture (Haiku always,
    // Opus only when Bogdan-as-speaker). Never blocks message routing
    // or trigger handling; errors are swallowed inside the detector.
    void runSignalDetector({
      channel: 'signal',
      source: source || '',
      text: text.trim(),
      noteToSelf: isNoteToSelf,
      envelopeTimestamp: timestamp,
      ownerPhone: ACCOUNT,
    }).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'signal-detector unexpected throw (should be impossible)',
      );
    });

    // Trigger filter: only "@andy" prefix.
    if (!TRIGGER_RE.test(text.trim())) return;

    if (!isNoteToSelf) {
      logger.info(
        { source, destination, textPreview: text.slice(0, 60) },
        'signal trigger received outside Note-to-Self — ignoring',
      );
      return;
    }

    const jid = `signal:${ACCOUNT}`;
    const tsIso = timestamp
      ? new Date(timestamp).toISOString()
      : new Date().toISOString();
    const messageId = `sig-${timestamp ?? Date.now()}`;
    const stripped = text.replace(/^@andy\s*/i, '').trim();

    const message: NewMessage = {
      id: messageId,
      chat_jid: jid,
      sender: source || ACCOUNT,
      sender_name: 'self',
      content: stripped || text,
      timestamp: tsIso,
      is_from_me: true,
      is_bot_message: false,
    };

    logger.info(
      { messageId, contentPreview: message.content.slice(0, 80) },
      'signal inbound trigger',
    );
    this.opts.onChatMetadata(jid, tsIso, 'Andy', 'signal', false);
    this.opts.onMessage(jid, message);
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('signal socket not connected'));
        return;
      }
      const id = this.rpcId++;
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`signal-cli RPC timeout: ${method}`));
      }, 30_000);
      this.pendingRpc.set(id, { resolve, reject, timer });
      const req = { jsonrpc: '2.0', id, method, params };
      this.socket.write(JSON.stringify(req) + '\n');
    });
  }
}

function jidToRecipient(jid: string): string {
  return jid.replace(/^signal:/, '');
}

/**
 * Split text on newlines so each chunk fits within `max`. Prefers paragraph
 * boundaries; falls back to hard-cutting only when no whitespace is available.
 */
function chunkMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const window = text.slice(i, end);
      const lastNl = window.lastIndexOf('\n');
      if (lastNl > Math.floor(max * 0.7)) {
        end = i + lastNl + 1;
      } else {
        const lastSpace = window.lastIndexOf(' ');
        if (lastSpace > Math.floor(max * 0.7)) end = i + lastSpace + 1;
      }
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

registerChannel('signal', (opts: ChannelOpts) => new SignalChannel(opts));
