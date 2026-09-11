/**
 * Settings reconcile for the mailbox hooks: keyed by our command string,
 * idempotent, preserves foreign entries, refuses to clobber a corrupt file
 * (which claude already treats as hook-less — overwriting would also eat
 * whatever the operator was editing).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach } from 'bun:test';

import {
  ensureTerminalDefaults,
  ensureMailboxHooks,
  removeMailboxHooks,
  BOUNDARY_HOOK_COMMAND,
  BOUNDARY_HOOK_TIMEOUT_S,
  MAILBOX_HOOK_COMMAND,
} from './settings-hooks.js';

let settingsPath: string;

function read(): { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> } & Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

beforeEach(() => {
  settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-settings-')), 'settings.json');
});

describe('ensureMailboxHooks', () => {
  it('creates the file with all six events wired to the hook script', () => {
    expect(ensureMailboxHooks(settingsPath)).toBe(true);
    const settings = read();
    // Notification is the permission-prompt hold : the one event
    // that fires while a dialog waits, so dropping it re-opens the
    // container-expires-mid-prompt gap.
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Notification']) {
      const commands = settings.hooks[event].flatMap((e) => e.hooks.map((h) => h.command));
      expect(commands).toEqual([MAILBOX_HOOK_COMMAND]);
    }
    // PreToolUse alone also carries the boundary confirm as its own entry.
    const preToolUse = settings.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    expect(preToolUse).toEqual([MAILBOX_HOOK_COMMAND, BOUNDARY_HOOK_COMMAND]);
  });

  it('the boundary entry gets the long timeout; the mailbox entries keep timeout 10', () => {
    ensureMailboxHooks(settingsPath);
    const settings = read() as unknown as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;
    };
    for (const [event, entries] of Object.entries(settings.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          if (hook.command === BOUNDARY_HOOK_COMMAND) {
            // The confirm must outwait a human approver; the ladder is
            // host-deny (~590s) < hook self-deny (600s) < this kill (660s).
            expect(event).toBe('PreToolUse');
            expect(hook.timeout).toBe(BOUNDARY_HOOK_TIMEOUT_S);
            expect(entry.matcher).toBe('Bash|Edit|Write');
          } else {
            expect(hook.timeout).toBe(10);
          }
        }
      }
    }
  });

  it('is idempotent and preserves foreign hooks and unrelated settings', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        autoMemoryEnabled: false,
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'bun /app/src/other-hook.ts' }] }],
          PreCompact: [{ hooks: [{ type: 'command', command: 'bun /app/src/compact-instructions.ts' }] }],
        },
      }),
    );
    ensureMailboxHooks(settingsPath);
    ensureMailboxHooks(settingsPath); // twice — no duplicates
    const settings = read();
    expect(settings.autoMemoryEnabled).toBe(false);
    const stopCommands = settings.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
    expect(stopCommands).toEqual(['bun /app/src/other-hook.ts', MAILBOX_HOOK_COMMAND]);
    expect(settings.hooks.PreCompact.flatMap((e) => e.hooks.map((h) => h.command))).toEqual([
      'bun /app/src/compact-instructions.ts',
    ]);
    expect(settings.hooks.PostToolUse.flatMap((e) => e.hooks.map((h) => h.command))).toEqual([MAILBOX_HOOK_COMMAND]);
  });

  it('leaves a corrupt settings.json untouched and reports failure', () => {
    fs.writeFileSync(settingsPath, '{ not json');
    expect(ensureMailboxHooks(settingsPath)).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not json');
  });
});

it('preserves operator settings it does not own and adds none of its own', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'operator-choice' }));
  ensureMailboxHooks(settingsPath);
  expect(read().model).toBe('operator-choice');
  fs.writeFileSync(settingsPath, '{}');
  ensureMailboxHooks(settingsPath);
  expect(read().model).toBeUndefined();
});

describe('removeMailboxHooks', () => {
  it('is the exact inverse: strips ours everywhere, keeps foreign entries, drops emptied events', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        autoMemoryEnabled: false,
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bun /app/src/other-hook.ts' }] }] },
      }),
    );
    ensureMailboxHooks(settingsPath);
    expect(removeMailboxHooks(settingsPath)).toBe(true);
    const settings = read();
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command))).toEqual(['bun /app/src/other-hook.ts']);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification']) {
      expect(settings.hooks[event]).toBeUndefined();
    }
  });

  it('no-ops on a missing file and refuses a corrupt one', () => {
    expect(removeMailboxHooks(settingsPath)).toBe(true); // nothing there
    fs.writeFileSync(settingsPath, '{ not json');
    expect(removeMailboxHooks(settingsPath)).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not json');
  });
});

describe('ensureTerminalDefaults', () => {
  it('seeds the fullscreen renderer when the operator has expressed no preference', () => {
    expect(ensureTerminalDefaults(settingsPath)).toBe(true);
    expect(read().tui).toBe('fullscreen');
  });

  it('never overrides an operator choice — /tui wins, and the choice is durable', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ tui: 'plain', hooks: { Stop: [] } }));
    expect(ensureTerminalDefaults(settingsPath)).toBe(false);
    const after = read();
    expect(after.tui).toBe('plain');
    expect(after.hooks).toEqual({ Stop: [] });
  });

  it('preserves the hooks the mailbox registered', () => {
    ensureMailboxHooks(settingsPath);
    ensureTerminalDefaults(settingsPath);
    const after = read();
    expect(after.tui).toBe('fullscreen');
    expect(Object.keys(after.hooks ?? {}).length).toBeGreaterThan(0);
  });
});
