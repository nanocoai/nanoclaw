/**
 * Ensure the mailbox hooks are registered in the group's settings.json
 * (plan T2: "per-group settings.json is the hook home").
 *
 * Runs at code-runner boot, before the interactive session spawns — the
 * same in-container pattern as the chat runner's writeMemorySessionHook,
 * with migrate-claude-memory-settings' discipline: keyed reconcile (only
 * entries whose command is OURS are touched; everything else in the file
 * is preserved) and an atomic tmp+rename write, because a half-written
 * settings.json silently disables EVERY hook with no error anywhere.
 *
 * Host-ownership of this file is T7's problem (D17) — today it lives in
 * the RW ~/.claude mount like the rest of provider state.
 */
import fs from 'fs';
import path from 'path';

export const MAILBOX_HOOK_COMMAND = 'bun /app/src/code-runner/mailbox-hook.ts';

/** The D17 detached-boundary confirm — its OWN entry (below), never folded
 *  into the mailbox entries: those keep timeout:10, this one must outwait a
 *  human approver. */
export const BOUNDARY_HOOK_COMMAND = 'bun /app/src/code-runner/boundary-hook.ts';

/**
 * The CLI kills a hook at its settings timeout (seconds). The boundary
 * ladder: host expiry denies at ~590s, the hook's own poll ceiling denies at
 * 600s (boundary.ts), and this is the last-resort kill for a wedged hook —
 * each rung under the next so the decision is always an explicit deny, never
 * a kill the CLI interprets on its own.
 */
export const BOUNDARY_HOOK_TIMEOUT_S = 660;

/** PreToolUse matcher: only the tools the D17 boundaries can name — a
 *  subprocess per unrelated tool call would be pure spawn tax. */
const BOUNDARY_HOOK_MATCHER = 'Bash|Edit|Write';

// 'Notification' closes the v0-accepted D14 gap "a permission-prompt wait
// fires no hooks and the pod expires mid-prompt": at the pinned CLI (2.1.197)
// a visible permission dialog fires the Notification hook with
// notification_type "permission_prompt" once the operator has been inactive
// ~6s, and the handler stamps a bounded busy hold (mailbox-hook.ts).
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'] as const;

/** Where the key helper lives — container-private, beside the attach socket. */
export const API_KEY_HELPER_PATH = '/tmp/code-runner/api-key-helper.sh';

/**
 * The env var the runner hands the provider key to the CLI under.
 *
 * Deliberately NOT `ANTHROPIC_API_KEY`: the CLI treats a raw key in its
 * environment as an unreviewed credential and holds it behind a "do you want
 * to use this API key?" prompt — which, unattended, is the same dead end as
 * the permission prompt. Under a private name the key reaches the CLI only
 * through the helper below, which is the reviewed path by construction.
 */
export const PROVIDER_KEY_ENV = 'NANOCLAW_PROVIDER_KEY';

/**
 * The helper reads the key from ITS OWN environment, which the CLI passes
 * down: nothing is written to disk, so a deployment that injects a real key
 * (rather than the gateway's sentinel) keeps the no-secrets-at-rest rule.
 */
const API_KEY_HELPER_SCRIPT = `#!/bin/sh\nprintf %s "$${PROVIDER_KEY_ENV}"\n`;

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

/** The keyed-reconcile key: an entry is OURS iff its command is one of these. */
function isOurCommand(command: string): boolean {
  return command === MAILBOX_HOOK_COMMAND || command === BOUNDARY_HOOK_COMMAND;
}

type SettingsShape = { hooks?: Record<string, HookEntry[]>; apiKeyHelper?: string } & Record<string, unknown>;

export function claudeSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '/home/node', '.claude');
  return path.join(configDir, 'settings.json');
}

/** True when settings were written; false when left alone (corrupt file). */
export function ensureMailboxHooks(settingsPath: string = claudeSettingsPath()): boolean {
  let settings: SettingsShape = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsShape;
    } catch (error) {
      // A corrupt file already means "no hooks anywhere"; overwriting would
      // also destroy whatever the operator was editing. Louder is better.
      console.error(`[code-runner] ${settingsPath} is not valid JSON — mailbox hooks NOT registered:`, error);
      return false;
    }
  }

  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const existing = (hooks[event] ?? []).filter((entry) => !entry.hooks?.some((h) => isOurCommand(h.command)));
    existing.push({ hooks: [{ type: 'command', command: MAILBOX_HOOK_COMMAND, timeout: 10 }] });
    if (event === 'PreToolUse') {
      existing.push({
        matcher: BOUNDARY_HOOK_MATCHER,
        hooks: [{ type: 'command', command: BOUNDARY_HOOK_COMMAND, timeout: BOUNDARY_HOOK_TIMEOUT_S }],
      });
    }
    hooks[event] = existing;
  }
  settings.hooks = hooks;

  // API-key mode, stated rather than negotiated. Given only ANTHROPIC_API_KEY
  // in the environment the CLI treats a key it has not seen before as
  // untrusted, holds it behind an interactive prompt, and — unattended —
  // falls through to the subscription/OAuth path instead: it then resolves
  // entitlements over an endpoint an API key cannot satisfy, and reports the
  // failure as "unable to connect". `apiKeyHelper` is the documented seam for
  // supplying the key programmatically; with it the CLI is in API-key mode
  // from the first request, which is the mode a governed sandbox wants
  // (the gateway injects the real credential by Origin match, so what rides
  // in the header here is the deployment's sentinel).
  if (writeApiKeyHelper()) settings.apiKeyHelper = API_KEY_HELPER_PATH;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeAtomic(settingsPath, settings);
  return true;
}

/**
 * Seed the fullscreen renderer as the sandbox default (terminal-architecture,
 * measured on the POC 2026-08-21).
 *
 * The CLI ships two renderers. The default plain-scrolling one enables
 * neither the alternate screen nor mouse tracking, so under tmux — where the
 * operator's clicks and wheel reach a real terminal — clicking to position
 * the cursor does nothing and scrolling fights the pane. Fullscreen turns
 * both on (verified: it emits ?1049h/?1000h/?1006h where the default emits
 * none of them). A durable sandbox terminal wants that.
 *
 * SEEDED, NOT FORCED: written only when the key is absent, so `/tui` remains
 * the operator's to change and the choice survives in group state. (The
 * CLAUDE_CODE_NO_FLICKER env var would win every boot instead — the wrong
 * shape for a preference.)
 *
 * Scoped to the tmux terminal mode by its caller: the retiring attach stack
 * replays a ring buffer, and replaying alternate-screen bytes into a fresh
 * client is a different question that need not be answered now.
 */
export function ensureTerminalDefaults(settingsPath: string = claudeSettingsPath()): boolean {
  let settings: SettingsShape = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsShape;
    } catch (error) {
      console.error(`[code-runner] ${settingsPath} is not valid JSON — terminal defaults NOT seeded:`, error);
      return false;
    }
  }
  if (settings.tui !== undefined) return false; // the operator has chosen; leave it
  settings.tui = 'fullscreen';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeAtomic(settingsPath, settings);
  return true;
}

/** Write the executable helper. False (logged) leaves the CLI's own default. */
function writeApiKeyHelper(): boolean {
  try {
    fs.mkdirSync(path.dirname(API_KEY_HELPER_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(API_KEY_HELPER_PATH, API_KEY_HELPER_SCRIPT, { mode: 0o700 });
    return true;
  } catch (error) {
    console.error('[code-runner] could not write the api-key helper:', error);
    return false;
  }
}

/**
 * The exact inverse — strip our hook entries, preserve everything foreign.
 * Called by the hook script itself when it finds it is running in a
 * non-code-mode container (a group flipped back to chat mode): the entries
 * are persistent per-group state, the chat runner must stay untouched
 * (D22), so the hooks self-heal the settings on their first firing.
 */
export function removeMailboxHooks(settingsPath: string = claudeSettingsPath()): boolean {
  if (!fs.existsSync(settingsPath)) return true;
  let settings: SettingsShape;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as SettingsShape;
  } catch {
    return false; // corrupt: not ours to rewrite
  }
  if (!settings.hooks) return true;

  const hooks: Record<string, HookEntry[]> = {};
  let changed = false;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const kept = entries.filter((entry) => !entry.hooks?.some((h) => isOurCommand(h.command)));
    if (kept.length !== entries.length) changed = true;
    if (kept.length > 0) hooks[event] = kept;
  }
  if (!changed) return true;
  settings.hooks = hooks;
  writeAtomic(settingsPath, settings);
  return true;
}

function writeAtomic(settingsPath: string, settings: SettingsShape): void {
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
}
