/**
 * Seed Claude Code's first-run state for the Host-provided workspace.
 * The container's home is disposable, while the workspace is durable. Without
 * this state, a fresh container can stop at a trust prompt before processing
 * messages. Preserve unrelated settings and the Host's permission policy.
 */
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { conversationArgs } from './claude-args.js';
import type { LifeContext } from './tmux-session.js';

export function claudeStatePath(): string {
  return path.join(process.env.HOME || '/home/node', '.claude.json');
}

/** Where this session's conversation id lives: the session dir is mounted
 * read-write at /workspace and outlives every container life, like the
 * turn stamp beside it. */
export const CONVERSATION_STATE_PATH = '/workspace/code-session.json';

/** Fixed namespace for deriving a conversation id from a session id (uuid v5). */
const CONVERSATION_NAMESPACE = '6f0d1a7e-2c4b-4e8a-9b3d-5a1c7e9f2b40';

function uuidV5(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.concat([Buffer.from(namespace.replace(/-/g, ''), 'hex'), Buffer.from(name, 'utf8')]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversation id on record for this session, or null when there is none (or the file is unreadable). */
export function readConversationId(statePath: string = CONVERSATION_STATE_PATH): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { conversationId?: unknown };
    return typeof parsed.conversationId === 'string' && UUID_RE.test(parsed.conversationId)
      ? parsed.conversationId.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function writeConversationId(statePath: string, conversationId: string): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ conversationId }, null, 2));
  fs.renameSync(tmp, statePath);
}

/**
 * The CLI conversation this session owns: one id per session, minted once
 * and kept in the session dir. Several sessions share a group's `~/.claude`
 * store and the same cwd, so the CLI's own "most recent conversation for
 * this directory" is not this session's; an explicit id is.
 *
 * Derived from the session id (uuid v5, so a lost state file finds the same
 * conversation again) when the host provided one; random otherwise. A file
 * already there wins — it may hold a fresh id minted after a resume the CLI
 * could not load (mintConversationId). Never throws: a state dir that
 * cannot be written costs the persistence, not the boot.
 */
export function resolveConversationId(
  sessionId: string | null | undefined,
  statePath: string = CONVERSATION_STATE_PATH,
): string {
  const saved = readConversationId(statePath);
  if (saved) return saved;
  const id = sessionId ? uuidV5(CONVERSATION_NAMESPACE, sessionId) : randomUUID();
  try {
    writeConversationId(statePath, id);
  } catch (error) {
    console.error(`[code-runner] could not record the conversation id at ${statePath}:`, error);
  }
  return id;
}

/**
 * The CLI told us which conversation is live (its SessionStart hook carries
 * the native session id): put it on record so the next life resumes THAT
 * one. `/clear` inside the session starts a new conversation under a new
 * id while the file would still name the old one; recording the hook's id
 * is what keeps a crash respawn or a post-retirement boot on the
 * conversation the operator actually sees. Anything that is not a uuid is
 * ignored; an unchanged id is not rewritten. Never throws.
 */
export function recordConversationId(sessionId: unknown, statePath: string = CONVERSATION_STATE_PATH): boolean {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return false;
  const id = sessionId.toLowerCase();
  if (readConversationId(statePath) === id) return false;
  try {
    writeConversationId(statePath, id);
    return true;
  } catch (error) {
    console.error(`[code-runner] could not record the conversation id at ${statePath}:`, error);
    return false;
  }
}

/** A new conversation for this session, replacing the saved one: the fresh start after a resume the CLI could not load. */
export function mintConversationId(statePath: string = CONVERSATION_STATE_PATH): string {
  const id = randomUUID();
  try {
    writeConversationId(statePath, id);
  } catch (error) {
    console.error(`[code-runner] could not record the conversation id at ${statePath}:`, error);
  }
  return id;
}

/**
 * Whether the CLI holds a transcript for `conversationId` in `workspaceDir`.
 *
 * The CLI keeps per-project transcripts under
 * `~/.claude/projects/<munged cwd>/<conversation id>.jsonl`, where the munge
 * replaces every non-alphanumeric character with '-' — the runner's fixed
 * cwd `/workspace/group` becomes `-workspace-group`. `~/.claude` is the
 * group's durable provider-state mount, so the store outlives the
 * container, which is what makes a post-reap `--resume` land. Absence and
 * unreadability both answer false: the fresh-start end, never a stall.
 */
export function hasTranscript(
  workspaceDir: string,
  conversationId: string,
  home: string = process.env.HOME || '/home/node',
): boolean {
  const munged = workspaceDir.replace(/[^A-Za-z0-9]/g, '-');
  try {
    return fs.statSync(path.join(home, '.claude', 'projects', munged, `${conversationId}.jsonl`)).isFile();
  } catch {
    return false;
  }
}

type ProjectState = Record<string, unknown> & { hasTrustDialogAccepted?: boolean };
type ClaudeState = Record<string, unknown> & {
  hasCompletedOnboarding?: boolean;
  bypassPermissionsModeAccepted?: boolean;
  projects?: Record<string, ProjectState>;
};

/**
 * True when the state was written. A corrupt file is left ALONE and reported:
 * overwriting would eat whatever produced it, and the CLI recreates its own.
 */
export function ensureClaudeState(
  workspaceDir: string,
  /**
   * True when the deployment chose the 'bypass' posture. The CLI asks the
   * operator to accept that mode once; configuring it IS that acceptance,
   * and the sandbox has no one to ask. Left false, the key is never written
   * — an 'auto' deployment keeps the dialog it expects.
   */
  acceptBypass = false,
  statePath: string = claudeStatePath(),
): boolean {
  let state: ClaudeState = {};
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as ClaudeState;
    } catch (error) {
      console.error(`[code-runner] ${statePath} is not valid JSON — leaving it alone:`, error);
      return false;
    }
  }

  state.hasCompletedOnboarding = true;
  if (acceptBypass) state.bypassPermissionsModeAccepted = true;
  const projects: Record<string, ProjectState> = { ...(state.projects ?? {}) };
  projects[workspaceDir] = { ...(projects[workspaceDir] ?? {}), hasTrustDialogAccepted: true };
  state.projects = projects;

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath);
    return true;
  } catch (error) {
    console.error('[code-runner] could not seed the CLI state — expect a first-run prompt:', error);
    return false;
  }
}

/** What the per-life argv resolver needs; every path is overridable for tests. */
export interface ConversationResolverOptions {
  /** The host's session id, when the mailbox context carried one. */
  sessionId: string | null | undefined;
  workspaceDir: string;
  statePath?: string;
  home?: string;
  log?: (line: string) => void;
}

/**
 * The conversation flags for each child life of the session, respawns
 * included. Before every life the id on record is read fresh — the
 * SessionStart hook may have replaced it after a `/clear` — and the CLI is
 * asked to resume it when its transcript exists, or to start it under that
 * id when none does. A resumed life that died before its healthy-run
 * window is a transcript the CLI cannot load: the session then starts a
 * fresh conversation under a new id, once per runner boot, both ids logged.
 */
export function conversationArgsResolver(options: ConversationResolverOptions): (life: LifeContext) => string[] {
  const statePath = options.statePath ?? CONVERSATION_STATE_PATH;
  const home = options.home ?? process.env.HOME ?? '/home/node';
  const log = options.log ?? ((line: string) => console.log(line));
  let conversationId = resolveConversationId(options.sessionId, statePath);
  let lastLifeResumed = false;
  let startedFresh = false;
  return ({ life, previousLifeHealthy }) => {
    conversationId = readConversationId(statePath) ?? conversationId;
    if (previousLifeHealthy === false && lastLifeResumed && !startedFresh) {
      startedFresh = true;
      const abandoned = conversationId;
      conversationId = mintConversationId(statePath);
      console.error(
        `[code-runner] resumed conversation ${abandoned} died before its healthy-run window — starting a fresh conversation ${conversationId}`,
      );
    }
    const resumable = hasTranscript(options.workspaceDir, conversationId, home);
    lastLifeResumed = resumable;
    log(`[code-runner] life ${life}: ${resumable ? 'resuming' : 'starting'} conversation ${conversationId}`);
    return conversationArgs(conversationId, resumable);
  };
}
