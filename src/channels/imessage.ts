/**
 * iMessage channel adapter — one channel, two pluggable backends
 * (skill-installed via /add-imessage). The factory picks a backend from
 * config; only one is ever active per install.
 *
 *   - local   — the Chat SDK bridge over `chat-adapter-imessage`, reading
 *               THIS Mac's signed-in iMessage account (chat.db; macOS + Full
 *               Disk Access). Selected when IMESSAGE_ENABLED is truthy.
 *   - hosted  — this native adapter, connecting to iMessage through Photon's
 *               managed Spectrum platform using the TypeScript `spectrum-ts`
 *               SDK directly on the host. Selected when PHOTON_PROJECT_ID /
 *               PHOTON_PROJECT_SECRET are set.
 *
 * Set IMESSAGE_BACKEND=local|hosted to force one when both are configured.
 *
 * Hosted backend (the bulk of this file): unlike Hermes (whose gateway is
 * Python and therefore needs a Node sidecar to run the SDK), NanoClaw's host
 * is already Node, so the SDK runs in-process — no sidecar, no loopback HTTP,
 * no extra supervised subprocess. Like Discord/Slack it is a
 * persistent-connection channel — no webhook, no public URL, no signing
 * secret. `spectrum-ts` holds a long-lived gRPC stream to Photon for both
 * directions:
 *   - Inbound:  the SDK's `app.messages` async iterator yields
 *               `[space, message]` pairs. We normalize each to an
 *               InboundMessage and hand it to the router. The consumer loop
 *               re-subscribes with capped backoff if the stream ends/errors.
 *   - Outbound: `deliver()` resolves the target space (a DM by phone, or a
 *               group by its opaque space id) and calls `space.send(...)`.
 *
 * Hosted credentials come from `.env` (host-side; never enters a container):
 *   PHOTON_PROJECT_ID       — the Spectrum project id (SDK `projectId`)
 *   PHOTON_PROJECT_SECRET   — the project secret
 * Both are provisioned frictionlessly by `scripts/photon-setup.ts`
 * (`/add-imessage`), which runs Photon's device-login flow and creates the
 * project, secret, user, and iMessage line for you.
 *
 * Neither backend's package (`chat-adapter-imessage`, `spectrum-ts`) is
 * imported at module load: `spectrum-ts` loads via a runtime dynamic import in
 * setup(), and `chat-adapter-imessage` via a dynamic import in the local
 * factory branch — so the channel barrel evaluates (and this module registers)
 * even when neither is installed. The factory returns an adapter only when a
 * backend is configured, and setup() throws a clear "run /add-imessage" error
 * if the hosted SDK is missing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { isSafeAttachmentName } from '../attachment-safety.js';
import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import { registerChannelAdapter } from './channel-registry.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
// Type-only import from the baseline `chat` dep — no runtime cost, and the
// local backend's `chat-adapter-imessage` is loaded dynamically (see the
// factory) so this module still evaluates without that package installed.
import type { Adapter } from 'chat';

// ---------------------------------------------------------------------------
// Minimal structural typings for the slice of `spectrum-ts` we consume.
//
// We intentionally do not `import` from 'spectrum-ts' at type level: the
// package is installed on demand by /add-imessage, and the barrel must typecheck and
// the barrel must evaluate without it. These interfaces mirror the shapes the
// SDK returns (see the Hermes sidecar for the reference usage against v11).
// ---------------------------------------------------------------------------

/** A content node on an inbound message (text / media / group / reaction). */
export interface SpectrumContent {
  type: string;
  text?: string;
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
  duration?: number;
  items?: Array<{ id?: string | null; content?: SpectrumContent }>;
  emoji?: string;
  target?: { id?: string | null; direction?: string; content?: SpectrumContent } | null;
  read?: () => Promise<Uint8Array>;
}

/** Handle returned by `target.react(emoji)` — retractable via unsend(). */
export interface SpectrumReactionHandle {
  id?: string | null;
  unsend?: () => Promise<void>;
}

/** A resolved inbound message target, used for reactions. */
export interface SpectrumTargetMessage {
  id?: string | null;
  react?: (emoji: string) => Promise<SpectrumReactionHandle | undefined>;
}

/** A conversation surface (a DM or a group). */
export interface SpectrumSpace {
  id?: string;
  type?: string; // "dm" | "group"
  phone?: string | null;
  send: (builder: unknown) => Promise<{ id?: string | null } | undefined>;
  getMessage?: (id: string) => Promise<SpectrumTargetMessage | undefined>;
}

/** An inbound message off the `app.messages` stream. */
export interface SpectrumMessage {
  id?: string | null;
  direction?: string; // "inbound" | "outbound"
  platform?: string;
  sender?: { id?: string | null } | null;
  space?: SpectrumSpace;
  content?: SpectrumContent;
  timestamp?: Date | string | null;
}

/** The running Spectrum app. */
export interface SpectrumApp {
  messages: AsyncIterable<[SpectrumSpace, SpectrumMessage]>;
  stop: () => Promise<void>;
}

/** The `spectrum-ts` module surface we use. */
export interface SpectrumModule {
  Spectrum: (opts: {
    projectId: string;
    projectSecret: string;
    /** v10 renamed `providers` to `platforms`. */
    platforms: unknown[];
    options?: Record<string, unknown>;
    telemetry?: boolean;
  }) => Promise<SpectrumApp>;
  text: (s: string) => unknown;
  markdown: (s: string) => unknown;
  typing: (state: 'start' | 'stop') => unknown;
  read: (message: SpectrumMessage) => unknown;
  attachment: (filePath: string, opts?: { name?: string; mimeType?: string }) => unknown;
  voice: (filePath: string, opts?: { name?: string; mimeType?: string }) => unknown;
}

/** The `spectrum-ts/providers/imessage` provider surface we use. */
export interface ImessageProvider {
  config: () => unknown;
  (app: SpectrumApp): {
    space: {
      create: (target: string) => Promise<SpectrumSpace>;
      get: (id: string) => Promise<SpectrumSpace | undefined>;
    };
  };
}

/** Loaded SDK bundle. */
export interface PhotonSdk {
  spectrum: SpectrumModule;
  imessage: ImessageProvider;
}

/** Injection seam — tests supply a fake SDK; production dynamically imports. */
export type SpectrumLoader = () => Promise<PhotonSdk>;

const defaultLoader: SpectrumLoader = async () => {
  // Non-literal specifiers keep tsc from resolving (and failing on) a module
  // that may not be installed. Node resolves the bare specifier + subpath
  // export at runtime once /add-imessage has installed spectrum-ts.
  const spectrumSpec: string = 'spectrum-ts';
  const imessageSpec: string = 'spectrum-ts/providers/imessage';
  const spectrum = (await import(spectrumSpec)) as unknown as SpectrumModule;
  const providerMod = (await import(imessageSpec)) as unknown as { imessage: ImessageProvider };
  return { spectrum, imessage: providerMod.imessage };
};

// ---------------------------------------------------------------------------
// Config + constants
// ---------------------------------------------------------------------------

export interface PhotonConfig {
  projectId: string;
  projectSecret: string;
  /** Send agent replies as markdown (iMessage renders it natively). Default true. */
  markdown: boolean;
  /** Spectrum SDK telemetry. Default false. */
  telemetry: boolean;
  /** Cap on inbound attachment bytes we read + cache. Default 20 MB. */
  maxInlineAttachmentBytes: number;
}

const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const RECONNECT_BACKOFF_START_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const SPACE_CACHE_MAX = 2048;
const PENDING_QUESTIONS_MAX = 64;
const OUTBOUND_TEXT_CHUNK = 4000;

const REACTION_EMOJI_ALIASES: Record<string, string> = {
  thumbs_up: '👍',
  '+1': '👍',
  thumbs_down: '👎',
  '-1': '👎',
  heart: '❤️',
  laugh: '😂',
  joy: '😂',
  exclamation: '‼️',
  question: '❓',
  eyes: '👀',
  white_check_mark: '✅',
  check: '✅',
};

// Photon represents a DM chat id either as a bare E.164 number or as the
// iMessage chat GUID `any;-;+15551234567`. Both address the same DM and
// `space.create` accepts the bare number, so we normalize to the number.
const E164_RE = /^\+\d{6,15}$/;
const DM_CHAT_GUID_RE = /^any;-;(\+\d{6,15})$/;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/x-caf': '.caf',
  'application/pdf': '.pdf',
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Extract the bare E.164 phone a space id addresses, or null. */
export function phoneTargetFromSpaceId(spaceId: string | null | undefined): string | null {
  if (typeof spaceId !== 'string') return null;
  if (E164_RE.test(spaceId)) return spaceId;
  const m = spaceId.match(DM_CHAT_GUID_RE);
  return m ? m[1] : null;
}

/**
 * Resolve the stable NanoClaw platform id + group flag for a message.
 * DMs use the counterpart's E.164 number (addressable via space.create);
 * groups use the opaque Spectrum space id.
 */
export function resolveSpaceIdentity(
  space: SpectrumSpace | undefined,
  message: SpectrumMessage,
): { platformId: string; isGroup: boolean } | null {
  const id = space?.id ?? message.space?.id ?? null;
  const type = space?.type ?? message.space?.type ?? 'dm';
  const phone = space?.phone ?? message.space?.phone ?? null;
  const isGroup = type === 'group';
  if (isGroup) {
    if (!id) return null;
    return { platformId: id, isGroup: true };
  }
  const dmPhone = (phone && E164_RE.test(phone) ? phone : null) ?? phoneTargetFromSpaceId(id);
  const platformId = dmPhone ?? id;
  if (!platformId) return null;
  return { platformId, isGroup: false };
}

/** Normalize an option label to a slash command: "Approve" → "/approve". */
export function optionToCommand(option: string): string {
  return '/' + option.toLowerCase().replace(/\s+/g, '-');
}

/** Convert NanoClaw's cross-channel emoji shortcodes to values iMessage accepts. */
export function photonReactionEmoji(emoji: string): string {
  return REACTION_EMOJI_ALIASES[emoji] ?? emoji;
}

/** Remove the router's per-agent namespace before resolving a Photon message. */
export function photonReactionTargetId(messageId: string): string {
  return messageId.replace(/:ag-[A-Za-z0-9-]+$/, '');
}

/** Pick a safe on-disk filename for an inbound attachment. */
export function attachmentFilename(content: SpectrumContent): string {
  const raw = content.name ?? undefined;
  if (raw && isSafeAttachmentName(raw)) return raw;
  const ext = (content.mimeType && MIME_EXT[content.mimeType]) || (content.type === 'voice' ? '.caf' : '');
  const stem = content.type === 'voice' ? 'voice' : content.type === 'attachment' ? 'attachment' : 'media';
  const id = (content.id ?? '').replace(/[^A-Za-z0-9._-]/g, '') || String(Date.now());
  return `${stem}-${id}${ext}`;
}

/** Split long outbound text on line boundaries so a huge reply isn't truncated. */
export function chunkText(text: string, limit = OUTBOUND_TEXT_CHUNK): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/** A downloaded inbound attachment reference. */
export interface PhotonAttachment {
  type: string;
  name: string;
  localPath: string;
}

/** Extracted, normalized inbound payload built from a Spectrum message. */
export interface NormalizedInbound {
  text: string;
  attachments: PhotonAttachment[];
  failures: string[];
  isReaction: boolean;
}

/**
 * Walk a Spectrum content node into agent-visible text + downloaded
 * attachments. `saveMedia` is injected (the adapter caches to disk; tests
 * stub it) and receives the raw bytes + a chosen filename.
 */
export async function normalizeContent(
  content: SpectrumContent | undefined,
  saveMedia: (content: SpectrumContent) => Promise<PhotonAttachment | null>,
  out: NormalizedInbound,
): Promise<void> {
  if (!content || typeof content !== 'object') return;
  if (content.type === 'text') {
    if (content.text) out.text = out.text ? `${out.text}\n${content.text}` : content.text;
    return;
  }
  if (content.type === 'attachment' || content.type === 'voice') {
    const saved = await saveMedia(content);
    if (saved) out.attachments.push(saved);
    else out.failures.push(content.type === 'voice' ? 'voice message' : 'attachment');
    return;
  }
  if (content.type === 'group') {
    for (const item of content.items ?? []) {
      await normalizeContent(item?.content, saveMedia, out);
    }
    return;
  }
  if (content.type === 'reaction') {
    const emoji = content.emoji || '';
    if (emoji) {
      out.isReaction = true;
      const marker = `reaction:added:${emoji}`;
      out.text = out.text ? `${out.text}\n${marker}` : marker;
    }
    return;
  }
}

/** Append a visible note for media that failed to download. */
export function appendMediaFailureNote(text: string, failures: string[]): string {
  if (failures.length === 0) return text;
  const note = failures.map((t) => `[${t} could not be downloaded]`).join(' ');
  return text ? `${text}\n${note}` : note;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createPhotonAdapter(
  config: PhotonConfig,
  deps: { loadSpectrum?: SpectrumLoader } = {},
): ChannelAdapter {
  const loadSpectrum = deps.loadSpectrum ?? defaultLoader;

  let app: SpectrumApp | null = null;
  let sdk: PhotonSdk | null = null;
  let im: ReturnType<ImessageProvider> | null = null;
  let setupConfig: ChannelSetup;
  let connected = false;
  let shuttingDown = false;

  // Space cache keyed by platform id (phone or group id) — avoids a
  // create/get round trip on every outbound to a recently-seen conversation.
  const spaceCache = new Map<string, SpectrumSpace>();

  // Pending ask_user_question by platformId → { questionId, options }.
  // The user answers by replying with a slash command (iMessage has no buttons).
  const pendingQuestions = new Map<string, { questionId: string; options: NormalizedOption[] }>();

  function cacheSpace(key: string, space: SpectrumSpace): void {
    if (!key || !space) return;
    if (spaceCache.has(key)) spaceCache.delete(key);
    spaceCache.set(key, space);
    if (spaceCache.size > SPACE_CACHE_MAX) {
      const oldest = spaceCache.keys().next().value;
      if (oldest !== undefined) spaceCache.delete(oldest);
    }
  }

  function rememberInboundSpace(space: SpectrumSpace | undefined, platformId: string): void {
    if (!space) return;
    cacheSpace(platformId, space);
    if (space.id) cacheSpace(space.id, space);
  }

  async function resolveSpace(platformId: string): Promise<SpectrumSpace> {
    const cached = spaceCache.get(platformId);
    if (cached) return cached;
    if (!im) throw new Error('Photon adapter not connected');

    const phone = phoneTargetFromSpaceId(platformId);
    let space: SpectrumSpace | undefined;
    if (phone) {
      try {
        space = await im.space.create(phone);
      } catch (err) {
        log.debug('Photon: phone → DM space.create failed', { platformId, err });
      }
    }
    if (!space) {
      try {
        space = await im.space.get(platformId);
      } catch (err) {
        log.debug('Photon: space.get failed', { platformId, err });
      }
    }
    if (!space) throw new Error(`Photon: unable to resolve space for ${platformId}`);
    cacheSpace(platformId, space);
    if (space.id) cacheSpace(space.id, space);
    return space;
  }

  /** Read + cache an inbound media node to DATA_DIR/attachments. */
  async function saveMedia(content: SpectrumContent): Promise<PhotonAttachment | null> {
    if (typeof content.read !== 'function') return null;
    if (typeof content.size === 'number' && content.size > config.maxInlineAttachmentBytes) {
      log.warn('Photon: inbound attachment over inline cap, skipping', {
        size: content.size,
        cap: config.maxInlineAttachmentBytes,
      });
      return null;
    }
    let bytes: Uint8Array;
    try {
      bytes = await content.read();
    } catch (err) {
      log.warn('Photon: failed to read inbound attachment bytes', { err });
      return null;
    }
    if (bytes.length > config.maxInlineAttachmentBytes) {
      log.warn('Photon: inbound attachment over inline cap after read, skipping', { size: bytes.length });
      return null;
    }
    const filename = attachmentFilename(content);
    try {
      const attachDir = path.join(DATA_DIR, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });
      fs.writeFileSync(path.join(attachDir, filename), Buffer.from(bytes));
    } catch (err) {
      log.warn('Photon: failed to write inbound attachment', { filename, err });
      return null;
    }
    log.info('Photon: media downloaded', { type: content.type, filename });
    return {
      type: content.type === 'voice' ? 'voice' : 'attachment',
      name: filename,
      localPath: `attachments/${filename}`,
    };
  }

  async function handleInbound(space: SpectrumSpace, message: SpectrumMessage): Promise<void> {
    // Ignore our own outbound echoes. `direction` is only set on messages the
    // provider has classified; when absent we treat it as inbound.
    if (message.direction && message.direction !== 'inbound') return;

    const identity = resolveSpaceIdentity(space, message);
    if (!identity) {
      log.debug('Photon: could not resolve space identity, dropping message');
      return;
    }
    const { platformId, isGroup } = identity;
    rememberInboundSpace(space, platformId);

    // Remote iMessage marks the whole chat read. Keep this best-effort so a
    // transient receipt failure never prevents the message from reaching the agent.
    if (sdk) {
      try {
        await space.send(sdk.spectrum.read(message));
      } catch (err) {
        log.debug('Photon: failed to mark inbound message read', { platformId, messageId: message.id, err });
      }
    }

    const out: NormalizedInbound = { text: '', attachments: [], failures: [], isReaction: false };
    await normalizeContent(message.content, saveMedia, out);
    const text = appendMediaFailureNote(out.text, out.failures);

    // Nothing usable (empty protocol frame, unsupported content) — drop.
    if (!text && out.attachments.length === 0) return;

    const sender = message.sender?.id ?? platformId;
    const senderName = sender;
    const ts = message.timestamp;
    const timestamp = ts instanceof Date ? ts.toISOString() : ts ? String(ts) : new Date().toISOString();

    setupConfig.onMetadata(platformId, undefined, isGroup);

    // A pending ask_user_question answered by a slash-command reply routes to
    // onAction instead of waking the agent with the raw "/approve" text.
    const pending = pendingQuestions.get(platformId);
    if (pending && text.trim().startsWith('/')) {
      const cmd = text.trim().toLowerCase();
      const matched = pending.options.find((o) => optionToCommand(o.label) === cmd);
      if (matched) {
        setupConfig.onAction(pending.questionId, matched.value, sender);
        pendingQuestions.delete(platformId);
        await deliverText(platformId, `${matched.selectedLabel}`).catch((err) =>
          log.debug('Photon: failed to confirm question answer', { err }),
        );
        return;
      }
    }

    const inbound: InboundMessage = {
      id: message.id || `photon-${Date.now()}`,
      kind: 'chat',
      // DMs are addressed to the bot by definition → platform-confirmed mention
      // so the router auto-engages / creates an approval-gated messaging group.
      // In groups we leave it undefined and let the router fall back to
      // agent-name text matching (iMessage groups carry no structured mention).
      isMention: isGroup ? undefined : true,
      isGroup,
      content: {
        text,
        sender,
        senderId: `imessage:${sender}`,
        senderName,
        isGroup,
        ...(out.attachments.length > 0 && { attachments: out.attachments }),
      },
      timestamp,
    };
    await setupConfig.onInbound(platformId, null, inbound);
    log.info('Photon message received', { platformId, isGroup });
  }

  /** The re-subscribing inbound consumer loop. */
  async function consumeInbound(): Promise<void> {
    let backoff = RECONNECT_BACKOFF_START_MS;
    while (!shuttingDown) {
      try {
        if (!app) return;
        for await (const [space, message] of app.messages) {
          backoff = RECONNECT_BACKOFF_START_MS;
          try {
            await handleInbound(space, message);
          } catch (err) {
            log.error('Photon: error handling inbound message', { err });
          }
        }
        if (shuttingDown) return;
        log.warn('Photon: inbound stream ended — re-subscribing');
      } catch (err) {
        if (shuttingDown) return;
        log.error('Photon: inbound stream errored — restarting', { err });
      }
      await new Promise((r) => setTimeout(r, backoff + Math.random() * backoff * 0.2));
      backoff = Math.min(backoff * 2, RECONNECT_BACKOFF_MAX_MS);
    }
  }

  /** Send plain-or-markdown text (chunked) to a resolved space. */
  async function deliverText(platformId: string, text: string): Promise<string | undefined> {
    if (!sdk) return undefined;
    const space = await resolveSpace(platformId);
    const chunks = chunkText(text);
    let firstId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const builder = config.markdown ? sdk.spectrum.markdown(chunks[i]) : sdk.spectrum.text(chunks[i]);
      const result = await space.send(builder);
      if (i === 0) firstId = result?.id ?? undefined;
    }
    return firstId;
  }

  const adapter: ChannelAdapter = {
    name: 'imessage',
    channelType: 'imessage',
    supportsThreads: false,

    async setup(hostConfig: ChannelSetup): Promise<void> {
      setupConfig = hostConfig;

      try {
        sdk = await loadSpectrum();
      } catch (err) {
        throw new Error(
          'Photon: the `spectrum-ts` SDK is not installed. Run /add-imessage ' +
            '(or `pnpm install spectrum-ts@11.0.0`) to enable the channel.',
          { cause: err },
        );
      }

      app = await sdk.spectrum.Spectrum({
        projectId: config.projectId,
        projectSecret: config.projectSecret,
        platforms: [sdk.imessage.config()],
        options: { flattenGroups: true },
        telemetry: config.telemetry,
      });
      im = sdk.imessage(app);
      connected = true;

      // Fire-and-forget: the consumer loop owns its own reconnect lifecycle.
      void consumeInbound();

      log.info('Photon channel connected', { projectId: config.projectId });
    },

    async teardown(): Promise<void> {
      shuttingDown = true;
      connected = false;
      const current = app;
      app = null;
      im = null;
      if (current) {
        try {
          await Promise.race([current.stop(), new Promise((resolve) => setTimeout(resolve, 3000))]);
        } catch (err) {
          log.debug('Photon: app.stop() failed', { err });
        }
      }
      log.info('Photon channel disconnected');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!sdk) return undefined;
      // Delivery normally passes an object; tolerate a bare string too.
      if (typeof message.content === 'string') {
        return message.content ? deliverText(platformId, message.content) : undefined;
      }
      const content = (message.content ?? {}) as Record<string, unknown>;

      // ask_user_question → text + slash-command replies (no iMessage buttons).
      if (content.type === 'ask_question' && content.questionId && content.options) {
        const questionId = content.questionId as string;
        const title = content.title as string;
        const question = content.question as string;
        if (!title) {
          log.error('Photon: ask_question missing required title — skipping', { questionId });
          return undefined;
        }
        const options: NormalizedOption[] = normalizeOptions(content.options as never);
        const lines = options.map((o) => `  ${optionToCommand(o.label)} — ${o.label}`).join('\n');
        const body = `**${title}**\n\n${question}\n\nReply with:\n${lines}`;
        const msgId = await deliverText(platformId, body);
        pendingQuestions.set(platformId, { questionId, options });
        if (pendingQuestions.size > PENDING_QUESTIONS_MAX) {
          const oldest = pendingQuestions.keys().next().value;
          if (oldest !== undefined) pendingQuestions.delete(oldest);
        }
        return msgId;
      }

      // Reaction (tapback) on a prior message.
      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        const messageId = photonReactionTargetId(content.messageId as string);
        const emoji = photonReactionEmoji(content.emoji as string);
        try {
          const space = await resolveSpace(platformId);
          const target = await space.getMessage?.(messageId);
          if (!target?.react) {
            throw new Error(`Photon message not found or cannot be reacted to: ${messageId}`);
          }
          await target.react(emoji);
        } catch (err) {
          log.error('Photon: failed to send reaction', { platformId, messageId, emoji, err });
          throw err;
        }
        return undefined;
      }

      const rawText = (content.markdown as string) || (content.text as string) || '';
      const files = message.files ?? [];

      // Files first so a caption lands beneath the media in the chat. iMessage
      // runs on a dedicated line here, so replies are not name-prefixed.
      if (files.length > 0) {
        await deliverFiles(platformId, files);
      }
      if (rawText) {
        return deliverText(platformId, rawText);
      }
      return undefined;
    },

    async setTyping(platformId: string): Promise<void> {
      if (!sdk || !connected) return;
      try {
        const space = await resolveSpace(platformId);
        await space.send(sdk.spectrum.typing('start'));
      } catch (err) {
        log.debug('Photon: typing indicator failed', { platformId, err });
      }
    },
  };

  /** Send outbound file attachments via temp files spectrum-ts can read. */
  async function deliverFiles(platformId: string, files: NonNullable<OutboundMessage['files']>): Promise<void> {
    if (!sdk) return;
    const space = await resolveSpace(platformId);
    for (const file of files) {
      const safeName = file.filename.replace(/[/\\\0]/g, '_');
      const tempPath = path.join(
        os.tmpdir(),
        `photon-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`,
      );
      try {
        fs.writeFileSync(tempPath, file.data);
        const builder = sdk.spectrum.attachment(tempPath, { name: file.filename });
        await space.send(builder);
      } catch (err) {
        log.error('Photon: failed to send attachment', { platformId, filename: file.filename, err });
      } finally {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* best-effort temp cleanup */
        }
      }
    }
  }

  return adapter;
}

// ---------------------------------------------------------------------------
// Self-registration — one `imessage` channel; the factory picks the backend
// ---------------------------------------------------------------------------

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

type Backend = 'local' | 'hosted';

/**
 * Decide which backend (if any) is configured. An explicit IMESSAGE_BACKEND
 * wins; otherwise Photon credentials imply hosted and IMESSAGE_ENABLED implies
 * local. Returns null when neither is set (the channel stays dormant).
 */
function pickBackend(env: Record<string, string | undefined>): Backend | null {
  const explicit = (process.env.IMESSAGE_BACKEND ?? env.IMESSAGE_BACKEND ?? '').trim().toLowerCase();
  if (explicit === 'local' || explicit === 'hosted') return explicit;

  const hasPhoton =
    Boolean(process.env.PHOTON_PROJECT_ID ?? env.PHOTON_PROJECT_ID) &&
    Boolean(process.env.PHOTON_PROJECT_SECRET ?? env.PHOTON_PROJECT_SECRET);
  const localEnabled = truthy(process.env.IMESSAGE_ENABLED ?? env.IMESSAGE_ENABLED);

  if (hasPhoton && localEnabled) {
    log.warn(
      'iMessage: both Photon credentials and IMESSAGE_ENABLED are set — defaulting to the hosted ' +
        'backend. Set IMESSAGE_BACKEND=local|hosted to choose explicitly.',
    );
    return 'hosted';
  }
  if (hasPhoton) return 'hosted';
  if (localEnabled) return 'local';
  return null;
}

/**
 * Build the local backend: the Chat SDK bridge over `chat-adapter-imessage`,
 * reading this Mac's signed-in iMessage account. The package is pulled via a
 * non-literal dynamic specifier so tsc never resolves it and the barrel
 * evaluates without it installed; /add-imessage (Local) installs it on demand.
 */
async function createLocalAdapter(): Promise<ChannelAdapter> {
  const spec: string = 'chat-adapter-imessage';
  let mod: { createiMessageAdapter: (opts: { local?: boolean }) => Adapter };
  try {
    mod = (await import(spec)) as unknown as typeof mod;
  } catch (err) {
    throw new Error(
      'iMessage (local): the `chat-adapter-imessage` package is not installed. Run /add-imessage ' +
        '(or `pnpm install chat-adapter-imessage@0.1.1`) to enable the local backend.',
      { cause: err },
    );
  }
  const raw = mod.createiMessageAdapter({ local: true });
  // The community adapter omits channelIdFromThreadId; polyfill an identity fn.
  const adapter = Object.assign(raw, { channelIdFromThreadId: (threadId: string) => threadId });
  return createChatSdkBridge({ adapter, concurrency: 'concurrent', supportsThreads: false });
}

registerChannelAdapter('imessage', {
  factory: () => {
    const env = readEnvFile([
      'IMESSAGE_BACKEND',
      'IMESSAGE_ENABLED',
      'PHOTON_PROJECT_ID',
      'PHOTON_PROJECT_SECRET',
      'PHOTON_MARKDOWN',
      'PHOTON_TELEMETRY',
      'PHOTON_MAX_INLINE_ATTACHMENT_BYTES',
    ]);

    const backend = pickBackend(env);
    if (!backend) {
      log.debug(
        'iMessage: no backend configured — set PHOTON_PROJECT_ID/PHOTON_PROJECT_SECRET for hosted ' +
          'or IMESSAGE_ENABLED=true for local. Skipping channel.',
      );
      return null;
    }

    if (backend === 'local') {
      if (os.platform() !== 'darwin') {
        log.warn("iMessage: the local backend reads this Mac's chat.db and requires macOS — skipping channel");
        return null;
      }
      return createLocalAdapter();
    }

    // hosted (Photon)
    const projectId = process.env.PHOTON_PROJECT_ID || env.PHOTON_PROJECT_ID;
    const projectSecret = process.env.PHOTON_PROJECT_SECRET || env.PHOTON_PROJECT_SECRET;
    if (!projectId || !projectSecret) {
      log.debug('iMessage (hosted): PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET not set, skipping channel');
      return null;
    }
    const markdownRaw = process.env.PHOTON_MARKDOWN ?? env.PHOTON_MARKDOWN;
    const maxInline =
      Number(process.env.PHOTON_MAX_INLINE_ATTACHMENT_BYTES || env.PHOTON_MAX_INLINE_ATTACHMENT_BYTES) ||
      DEFAULT_MAX_INLINE_ATTACHMENT_BYTES;
    return createPhotonAdapter({
      projectId,
      projectSecret,
      // Default on — iMessage renders markdown natively.
      markdown: markdownRaw === undefined ? true : markdownRaw !== 'false',
      telemetry: truthy(process.env.PHOTON_TELEMETRY ?? env.PHOTON_TELEMETRY),
      maxInlineAttachmentBytes: maxInline,
    });
  },
});
