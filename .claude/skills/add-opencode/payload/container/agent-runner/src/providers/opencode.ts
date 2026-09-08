import { initializeOpenCodeAuth } from './opencode-auth.js';
import { spawn, type ChildProcess } from 'child_process';
import { lstatSync, realpathSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { createOpencodeClient, type FilePartInput } from '@opencode-ai/sdk';
// The root client has no `.question` surface; reply/reject/list for the
// interactive `question` tool live on the `/v2` subpath client. Import it
// separately so the session/event client above is untouched.
import { createOpencodeClient as createOpencodeQuestionClient } from '@opencode-ai/sdk/v2';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { buildOpenCodeConfig, buildOpenCodeServerEnv } from './opencode-config.js';
export { buildOpenCodeConfig } from './opencode-config.js';
import { buildDeliverySentences } from '../compact-instructions.js';
import type { ResolvedRuntimeConfiguration } from '../provider-contracts/registry.js';
import { getTaskSeriesId } from '../db/session-routing.js';
import { getAllDestinations } from '../destinations.js';
import { prepareOpenCodeMemory, type OpenCodeMemorySessionHook } from './opencode-memory.js';
export { runMemorySessionHook, type OpenCodeMemorySessionHook } from './opencode-memory.js';
import {
  boundedOpenCodeCall,
  executeOpenCodeTurn,
  OpenCodeEventPump,
  type OpenCodeSessionClient,
} from './opencode-turn.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

/**
 * In-turn watchdog defaults (see the two tiers in `query()`). Env overrides:
 * `OPENCODE_STREAM_SILENCE_MS` and `OPENCODE_IDLE_TIMEOUT_MS`. The server
 * heartbeats every 10 s, so 60 s of total silence is six missed beats; the
 * activity budget is generous because a single tool call (a long build, a
 * browser session) legitimately streams nothing for many minutes.
 */
const DEFAULT_STREAM_SILENCE_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 900_000;

const AGENT_DIR = '/workspace/agent';
const DEFAULT_NATIVE_ATTACHMENT_MAX_COUNT = 8;
const DEFAULT_NATIVE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Native session lookup errors invalidate a stored continuation; backend/network failures do not. */
const STALE_SESSION_RE = /"name":"NotFoundError"/;

function killProcessTree(proc: ChildProcess): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
      return;
    } catch {
      /* fall through to the single-process kill */
    }
  }
  // No pid (spawn never produced one) or the group signal failed: best-effort
  // on the handle itself. A ChildProcess without a pid returns false here.
  try {
    proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

export function spawnOpencodeServer(
  config: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    initializeOpenCodeAuth(process.env.XDG_DATA_HOME ?? '/opencode-xdg', process.env.OPENCODE_AUTH_MODE);
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      // `opencode serve` has no directory flag. Its cwd is the project root
      // used by native document discovery and built-in filesystem tools.
      cwd: AGENT_DIR,
      env: buildOpenCodeServerEnv(config),
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

/**
 * The shared attachment contract carries only host-staged files, bound to the
 * source message whose inbox owns them. Remote URLs remain prompt text and are
 * never fetched implicitly.
 *
 * Attachments are ALSO described inline in the prompt text the formatter
 * produces, and that text rendering stays the contract every provider relies
 * on. Everything below is an additive view for OpenCode's file parts: when no
 * structured attachment arrives, the provider behaves exactly as it did before.
 */
interface OpenCodePromptAttachment {
  sourceMessageId: string;
  filename: string;
  path: string;
  mime?: string;
}

/** Extension → MIME fallback, for adapters that report no `mimeType`. */
const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

function attachmentMime(att: OpenCodePromptAttachment): string | undefined {
  if (att.mime) return att.mime;
  const name = att.path || att.filename || '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : ATTACHMENT_MIME_BY_EXT[name.slice(dot).toLowerCase()];
}

export interface NativeAttachmentLimits {
  maxCount: number;
  maxBytes: number;
}

export interface NativeAttachmentFileInfo {
  realPath: string;
  size: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    log(`Ignoring invalid ${name}: "${raw}"`);
    return fallback;
  }
  return parsed;
}

export function resolveNativeAttachmentLimits(): NativeAttachmentLimits {
  return {
    maxCount: positiveIntegerEnv('OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT', DEFAULT_NATIVE_ATTACHMENT_MAX_COUNT),
    maxBytes: positiveIntegerEnv('OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES', DEFAULT_NATIVE_ATTACHMENT_MAX_BYTES),
  };
}

function inspectNativeAttachment(filePath: string): NativeAttachmentFileInfo | null {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { realPath: realpathSync(filePath), size: stat.size };
  } catch {
    return null;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSafeComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

/**
 * Turn a turn's attachments into OpenCode file parts, so the model sees the
 * media itself rather than only the `[image: cat.png — saved to …]` line the
 * formatter already renders into the prompt text.
 *
 * The URL is a `file://` path, NOT a data: URI, deliberately: OpenCode resolves
 * a file: part server-side and converts supported local media for the model.
 * Base64-ing here would duplicate that work and inflate the request body. The
 * server shares this container's filesystem (spawnOpencodeServer), so the path
 * resolves.
 *
 * Only images and PDFs are forwarded; PDFs go through even though a given
 * backend may reject them, since the alternative is silently withholding a
 * document the user did send. Anything skipped is still described in the
 * prompt text, so it is never lost — just not handed over as media.
 *
 * `exists` is injectable so tests can drive resolvability without touching disk.
 */
export function buildAttachmentFileParts(
  attachments: OpenCodePromptAttachment[] | undefined,
  inspect: (path: string) => NativeAttachmentFileInfo | null = inspectNativeAttachment,
  limits: NativeAttachmentLimits = resolveNativeAttachmentLimits(),
): FilePartInput[] {
  const parts: FilePartInput[] = [];
  let totalBytes = 0;
  for (const att of attachments ?? []) {
    if (parts.length >= limits.maxCount) {
      log(`Native attachment count limit reached (${limits.maxCount}); remaining files stay prompt text only`);
      break;
    }
    if (!isSafeComponent(att.sourceMessageId) || !isSafeComponent(att.filename)) continue;
    const expectedRoot = `/workspace/inbox/${att.sourceMessageId}`;
    const expectedPath = `${expectedRoot}/${att.filename}`;
    if (path.resolve(att.path) !== expectedPath) {
      log(`Attachment path is not bound to its source message, not sent as media: ${att.filename}`);
      continue;
    }
    const mime = attachmentMime(att);
    if (!mime) continue;
    if (!mime.startsWith('image/') && mime !== 'application/pdf') continue;
    const info = inspect(att.path);
    if (!info || !isPathInside(expectedRoot, info.realPath) || path.basename(info.realPath) !== att.filename) {
      log(`Attachment has no safe regular file, not sent as media: ${att.filename}`);
      continue;
    }
    if (info.size < 0 || totalBytes + info.size > limits.maxBytes) {
      log(`Native attachment byte limit reached (${limits.maxBytes}); ${att.filename} stays prompt text only`);
      continue;
    }
    totalBytes += info.size;
    // OpenCode appends file parts after the combined batch text. Prefix the
    // display name with the source id so two messages carrying `image.png`
    // remain unambiguous to the model; the prompt text keeps the original name.
    parts.push({
      type: 'file',
      mime,
      filename: `${att.sourceMessageId}--${att.filename}`,
      url: pathToFileURL(info.realPath).href,
    });
  }
  return parts;
}

/**
 * The prompt body for one turn: the text the formatter produced, plus any
 * media that came with it. Both the opening prompt and every mid-turn push go
 * through here, so an attachment reaches the model the same way whichever path
 * carried it — OpenCode holds one query open per session, so in practice most
 * real messages arrive as pushes.
 */
export function buildPromptParts(
  text: string,
  attachments?: OpenCodePromptAttachment[],
  inspect: (path: string) => NativeAttachmentFileInfo | null = inspectNativeAttachment,
  limits: NativeAttachmentLimits = resolveNativeAttachmentLimits(),
): Array<{ type: 'text'; text: string } | FilePartInput> {
  return [{ type: 'text', text }, ...buildAttachmentFileParts(attachments, inspect, limits)];
}

type OpenCodeEvent = { type: string; properties: Record<string, unknown> };

/**
 * The client surface a shared runtime is built from: the per-turn session
 * calls `OpenCodeRuntimeHandle` already narrows, plus the event subscription
 * that only the shared (production) path opens. The real `OpencodeClient`
 * satisfies it structurally; tests hand in a fake.
 */
/**
 * The subset of the SDK's SSE options this module drives. `subscribe` spreads
 * them through `get.sse` → `beforeRequest` → `createSseClient` (verified in
 * @opencode-ai/sdk 1.18.25 dist/gen). Without a `signal`, that client swallows
 * a closed socket and reconnects forever with backoff, so a killed server
 * never ends the stream and an in-flight turn never learns it died.
 */
export interface SseSubscribeOptions {
  signal?: AbortSignal;
  sseSleepFn?: (ms: number) => Promise<void>;
  onSseError?: (error: unknown) => void;
}

type SharedRuntimeClient = OpenCodeRuntimeHandle['client'] & {
  event: { subscribe(options?: SseSubscribeOptions): Promise<{ stream: AsyncGenerator<OpenCodeEvent, void, void> }> };
};

/** The SDK's retry backoff, made to return the moment the runtime is released. */
function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
}

type SharedRuntime = {
  proc: ChildProcess;
  client: SharedRuntimeClient;
  questionClient: QuestionClient;
  stream: AsyncGenerator<OpenCodeEvent, void, void>;
  streamRelease: () => void;
};

/**
 * What `ensureSharedRuntime` needs from the outside world, injectable so the
 * shared-server lifecycle (spawn failure, init failure after spawn, server
 * death, stream death) can be driven in tests without an `opencode serve`
 * process. `OpenCodeRuntimeDeps` on the provider bypasses this whole path;
 * this seam exercises it.
 */
export interface OpenCodeSharedRuntimeDeps {
  spawnServer(config: Record<string, unknown>): Promise<{ url: string; proc: ChildProcess }>;
  createClient(url: string, cwd: string): SharedRuntimeClient;
  createQuestionClient(url: string): QuestionClient;
}

const defaultSharedRuntimeDeps: OpenCodeSharedRuntimeDeps = {
  spawnServer: (config) => spawnOpencodeServer(config),
  // OpenCode scopes sessions and tool execution by the directory carried by
  // the SDK client. The server process cwd is not sufficient: without this
  // option the SDK defaults requests to the server's launch directory.
  // The cast bridges one declared gap: the handle types `prompt` parts as
  // `unknown[]` so fakes stay light, while the SDK types them as its part
  // union. Every call site passes `buildPromptParts` output, which is the
  // SDK's own union, so the runtime shapes agree.
  createClient: (url, cwd) => createOpencodeClient({ baseUrl: url, directory: cwd }) as unknown as SharedRuntimeClient,
  createQuestionClient: (url) => createOpencodeQuestionClient({ baseUrl: url }),
};

let sharedRuntimeDeps: OpenCodeSharedRuntimeDeps = defaultSharedRuntimeDeps;

export function setSharedRuntimeDepsForTesting(deps?: OpenCodeSharedRuntimeDeps): void {
  sharedRuntimeDeps = deps ?? defaultSharedRuntimeDeps;
}

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

/**
 * One `opencode serve` per container, reused across queries. Every failure
 * mode leaves the module in a state the NEXT call can recover from: a failed
 * init is never cached (so a slow listen line or a stolen port costs one turn,
 * not the container's lifetime), a spawned server whose client setup fails is
 * reaped rather than orphaned on its port, and a server that exits out from
 * under us drops itself from the cache so the next turn respawns instead of
 * failing instantly forever.
 */
async function ensureSharedRuntime(
  options: ProviderOptions,
  cwd: string,
  configuration?: ResolvedRuntimeConfiguration,
): Promise<SharedRuntime> {
  const config = buildOpenCodeConfig(options, configuration);
  const key = JSON.stringify({ config, cwd });
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  const deps = sharedRuntimeDeps;
  const init = (async (): Promise<SharedRuntime> => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const { url, proc } = await deps.spawnServer(config);

    let runtime: SharedRuntime;
    // Owns the SSE subscription and its retry loop. Teardown closes the
    // server socket and prevents reconnection, waking a parked next() so an
    // active turn can report stream termination.
    const streamAbort = new AbortController();
    // SDK 1.18.25's abort handler does not handle reader.cancel() rejection.
    // Cancel the fetch only after its reader listener is gone. A separate
    // signal wakes retry backoff immediately when teardown was requested.
    const releaseAbort = new AbortController();
    const sleep = abortableSleep(releaseAbort.signal);
    try {
      const client = deps.createClient(url, cwd);
      const questionClient = deps.createQuestionClient(url);
      // Deliberately no `sseMaxRetryAttempts`: the SDK counts attempts
      // cumulatively per subscription and never resets after a successful
      // reconnect, so a cap would end a long-lived container's stream for
      // good on the Nth transient /event hiccup. The abort signal (server
      // exit, teardown) and the stream-silence watchdog are the stops.
      const sub = await client.event.subscribe({
        signal: streamAbort.signal,
        onSseError: () => {
          // The generated SDK calls this after removing its reader listener.
          if (releaseAbort.signal.aborted) streamAbort.abort();
        },
        sseSleepFn: async (ms) => {
          await sleep(ms);
          if (releaseAbort.signal.aborted) streamAbort.abort();
        },
      });
      const stream = sub.stream;
      // Belt-and-suspenders drain before this runtime serves any turn — see
      // drainPendingQuestions doc comment.
      await drainPendingQuestions(questionClient);
      runtime = {
        proc,
        client,
        questionClient,
        stream,
        streamRelease: () => {
          releaseAbort.abort();
          // return() closes an idle reader. If next() is parked, killing the
          // owned server closes its socket and onSseError ends the retry loop.
          // Both paths remove the broken listener before aborting the fetch.
          void stream.return(undefined).then(
            () => streamAbort.abort(),
            () => streamAbort.abort(),
          );
        },
      };
    } catch (err) {
      // The server came up and is holding its port; nothing downstream will
      // ever hold a handle to it, so this is the only place it can be reaped.
      streamAbort.abort();
      killProcessTree(proc);
      throw err;
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (sharedRuntime?.proc !== proc) return;
      log(`OpenCode server exited (code=${String(code)}, signal=${String(signal)}); next turn will respawn it`);
      try {
        runtime.streamRelease();
      } catch {
        /* ignore */
      }
      sharedRuntime = null;
      sharedConfigKey = null;
    };
    proc.once('exit', onExit);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      // Died between the listen line and the listener — the event is gone.
      try {
        runtime.streamRelease();
      } catch {
        /* ignore */
      }
      throw new Error(`OpenCode server exited during startup (code=${String(proc.exitCode)})`);
    }

    sharedRuntime = runtime;
    sharedConfigKey = key;
    return runtime;
  })();

  sharedInit = init;
  const release = (): void => {
    if (sharedInit === init) sharedInit = null;
  };
  init.then(release, release);
  return init;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

/**
 * The shared runtime's event stream died under a turn (SSE ended or threw).
 * Only the shared runtime is dropped, and only if `rt` is still it — a
 * test-injected handle or a runtime that was already replaced is untouched.
 */
function discardDeadSharedRuntime(rt: unknown): void {
  if (sharedRuntime && rt === sharedRuntime) {
    log('OpenCode event stream died; dropping shared runtime so the next turn respawns it');
    destroySharedRuntime();
  }
}

// Steers the model rather than just silently declining: nothing in this
// container can answer an interactive question, so tell it to decide on its
// own or fall back to nanoclaw's own blocking MCP tool (mcp-tools/interactive.ts,
// registered as `ask_user_question`), which actually reaches the human through
// the chat channel instead of OpenCode's headless-dead-end question tool.
export const QUESTION_STEERING_TEXT =
  'Interactive questions are not available in this environment. Decide autonomously based on your best judgment, or use the ask_user_question MCP tool to ask the human through the chat channel.';

/**
 * Minimal shape of the `/v2` SDK surface this module needs for question
 * handling — narrowed so tests can pass a fake without pulling in the real
 * `@opencode-ai/sdk/v2` client.
 */
export interface QuestionClient {
  question: {
    reply(params: { requestID: string; answers: string[][] }): Promise<{ data?: unknown; error?: unknown }>;
    list(): Promise<{ data?: Array<{ id: string; sessionID?: string; questions?: unknown[] }>; error?: unknown }>;
  };
}

/**
 * Narrow runtime surface so tests can drive `query()` without spawning
 * `opencode serve`. Production uses `ensureSharedRuntime`.
 */
export interface OpenCodeRuntimeHandle {
  client: {
    session: OpenCodeSessionClient;
    postSessionIdPermissionsPermissionId?(params: {
      path: { id: string; permissionID: string };
      body: { response: string };
    }): Promise<unknown>;
  };
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  questionClient: QuestionClient;
  /** Ends the event stream, waking any parked `stream.next()`. */
  streamRelease?(): void;
}

export interface OpenCodeRuntimeDeps {
  getRuntime(options: ProviderOptions, cwd: string): Promise<OpenCodeRuntimeHandle>;
}

/**
 * Answer a single pending question request with the steering text, one
 * custom answer per sub-question (OpenCode's `question` tool defaults
 * `custom: true`, i.e. an answer string that isn't one of the offered
 * option labels is accepted as free text). Never throws — a failed
 * auto-answer should not take down the session any more than the question
 * already threatened to.
 */
export async function autoAnswerQuestion(
  questionClient: QuestionClient,
  req: { id?: string; questions?: unknown[] },
): Promise<void> {
  if (!req.id) return;
  const count = Array.isArray(req.questions) && req.questions.length > 0 ? req.questions.length : 1;
  try {
    const res = await questionClient.question.reply({
      requestID: req.id,
      answers: Array.from({ length: count }, () => [QUESTION_STEERING_TEXT]),
    });
    if (res.error) {
      log(`Failed to auto-answer question ${req.id}: ${JSON.stringify(res.error)}`);
    }
  } catch (err) {
    log(`Failed to auto-answer question ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Matches the startup-blocking budget `spawnOpencodeServer` already uses for
 * its own default `timeoutMs`. This is a startup-path call like that one, so
 * it gets the same allowance. Shared with `handleQuestionAsked` below — the
 * same fail-open budget applies whether a hung reply is discovered at
 * runtime startup or mid-turn.
 */
const DRAIN_PENDING_QUESTIONS_TIMEOUT_MS = 10_000;

/**
 * Handle a `question.asked` SSE event: always answer it, regardless of which
 * session raised it. The `question: 'deny'` config above should stop this
 * tool from ever firing, but this is the real fix for the wedge: the
 * OpenCode server is shared across every session on this runtime, and a
 * pending question wedges the whole server, not just the session that asked
 * — so a config regression or an OpenCode-side path that raises the event
 * before consulting permission must never be able to leave a question
 * unanswered, no matter whose sessionID it carries. Same rule as
 * `drainPendingQuestions`, so behavior does not depend on which path sees a
 * question first.
 *
 * Bounded the same way `drainPendingQuestions` bounds its own await: this is
 * called inline from the turn's event loop (the `question.asked` case
 * below), so a `reply()` that never resolves would stall the turn, not just
 * startup. `timeoutMs` is injectable so tests don't wait out the real
 * default; on timeout this logs one line and returns, fail-open, same as the
 * drain path.
 */
export async function handleQuestionAsked(
  questionClient: QuestionClient,
  req: { id?: string; sessionID?: string; questions?: unknown[] },
  timeoutMs = DRAIN_PENDING_QUESTIONS_TIMEOUT_MS,
): Promise<void> {
  log(`Auto-answering question ${req.id ?? '(no id)'} (sessionID=${req.sessionID ?? 'unknown'})`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });

  try {
    if (await Promise.race([autoAnswerQuestion(questionClient, req).then(() => false as const), timedOut])) {
      log(`Timed out after ${timeoutMs}ms auto-answering question ${req.id ?? '(no id)'}; continuing`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Defensive belt: drain any question requests already pending when a shared
 * runtime comes up (e.g. one that raced the event subscription, or survived
 * from a prior server instance) so none of them can sit there wedging future
 * turns before the event-driven handler ever sees them.
 *
 * Bounded the same way `spawnOpencodeServer` bounds its own await: a plain
 * `Promise.race` against a timer, since (unlike that function's child-process
 * spawn) there is no cancellable handle on the in-flight SDK calls to abort.
 * A hung list()/reply() round-trip must not block runtime startup forever —
 * on timeout this logs one line and returns, fail-open, because the
 * event-driven `question.asked` handler still answers the question later if
 * the round-trip eventually completes.
 */
export async function drainPendingQuestions(
  questionClient: QuestionClient,
  timeoutMs = DRAIN_PENDING_QUESTIONS_TIMEOUT_MS,
): Promise<void> {
  const drain = (async () => {
    try {
      const res = await questionClient.question.list();
      if (res.error) {
        log(`Failed to list pending questions: ${JSON.stringify(res.error)}`);
        return;
      }
      for (const req of res.data ?? []) {
        await autoAnswerQuestion(questionClient, req);
      }
    } catch (err) {
      log(`Failed to list pending questions: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });

  try {
    if (await Promise.race([drain.then(() => false as const), timedOut])) {
      log(`Timed out after ${timeoutMs}ms draining pending questions; continuing startup`);
    }
  } finally {
    // A fast drain resolves before the timer fires, but the timer stays live
    // until it does — clear it here so it can't hold this call alive or fire
    // spuriously into a `timedOut` promise no one is racing against anymore.
    clearTimeout(timer);
  }
}

const runtimePumps = new WeakMap<OpenCodeRuntimeHandle, OpenCodeEventPump>();

function eventPump(runtime: OpenCodeRuntimeHandle): OpenCodeEventPump {
  let pump = runtimePumps.get(runtime);
  if (!pump) {
    pump = new OpenCodeEventPump(runtime.stream, (event) => {
      if (event.type === 'question.asked') {
        void handleQuestionAsked(runtime.questionClient, event.properties);
      }
      if (event.type === 'permission.updated') {
        const permission = event.properties as { id?: string; sessionID?: string };
        if (permission.id && permission.sessionID) {
          void boundedOpenCodeCall(
            () =>
              runtime.client.postSessionIdPermissionsPermissionId?.({
                path: { id: permission.sessionID!, permissionID: permission.id! },
                body: { response: 'always' },
              }) ?? Promise.resolve(),
          ).catch(() => log('Failed to auto-reply OpenCode permission'));
        }
      }
    });
    runtimePumps.set(runtime, pump);
  }
  return pump;
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private memorySessionHook?: OpenCodeMemorySessionHook;

  constructor(
    private readonly options: ProviderOptions = {},
    private readonly runtime?: OpenCodeRuntimeDeps,
    private readonly configuration?: ResolvedRuntimeConfiguration,
  ) {}

  registerMemorySessionHook(hook: OpenCodeMemorySessionHook, configuration?: unknown): void {
    this.memorySessionHook = (configuration ?? hook) as OpenCodeMemorySessionHook;
  }

  isSessionInvalid(error: unknown): boolean {
    return STALE_SESSION_RE.test(error instanceof Error ? error.message : String(error));
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('OpenCode memory session hook was not registered');
    const pending: Array<{ text: string; attachments?: OpenCodePromptAttachment[] }> = [
      {
        text: input.prompt,
        attachments: (input as QueryInput & { attachments?: OpenCodePromptAttachment[] }).attachments,
      },
    ];
    let waiting: (() => void) | undefined;
    let ended = false;
    const abort = new AbortController();
    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let sessionId = input.continuation;
      let initialized = false;
      const runtime = self.runtime
        ? await self.runtime.getRuntime(self.options, input.cwd)
        : await ensureSharedRuntime(self.options, input.cwd, self.configuration);
      const pump = eventPump(runtime);
      try {
        while (!abort.signal.aborted) {
          while (!pending.length && !ended && !abort.signal.aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = undefined;
          }
          if (abort.signal.aborted || (!pending.length && ended)) return;
          const turn = pending.shift()!;
          if (!sessionId) {
            const created = await boundedOpenCodeCall(
              (signal) => runtime.client.session.create({ signal }),
              abort.signal,
            );
            if (created.error) throw new Error(`OpenCode failed to create session: ${JSON.stringify(created.error)}`);
            sessionId = created.data?.id;
            if (!sessionId) throw new Error('OpenCode failed to create session (no id)');
          }
          if (!initialized) {
            initialized = true;
            yield { type: 'init', continuation: sessionId };
          }
          const result = yield* executeOpenCodeTurn({
            runtime,
            client: runtime.client.session,
            pump,
            sessionId,
            parts: buildPromptParts(turn.text, turn.attachments),
            prepare: () => {
              prepareOpenCodeMemory(
                self.memorySessionHook!,
                input.systemContext?.instructions,
                buildDeliverySentences(
                  getAllDestinations().map((destination) => destination.name),
                  getTaskSeriesId(),
                ).join(' '),
              );
            },
            signal: abort.signal,
            silenceMs: positiveIntegerEnv('OPENCODE_STREAM_SILENCE_MS', DEFAULT_STREAM_SILENCE_MS),
            idleMs: positiveIntegerEnv('OPENCODE_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS),
            discard: () => {
              discardDeadSharedRuntime(runtime);
              runtime.streamRelease?.();
            },
          });
          if (!abort.signal.aborted) yield { type: 'result', ...result };
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        abort.abort();
      }
    }

    return {
      push: (text: string, attachments?: OpenCodePromptAttachment[]) => {
        if (ended || abort.signal.aborted) return;
        pending.push({ text, attachments });
        waiting?.();
      },
      end: () => {
        ended = true;
        waiting?.();
      },
      events: gen(),
      abort: () => {
        abort.abort();
        waiting?.();
      },
    };
  }
}

registerProvider('opencode', (opts, configuration) => new OpenCodeProvider(opts, undefined, configuration));
