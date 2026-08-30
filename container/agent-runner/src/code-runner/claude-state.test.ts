/**
 * Seeding the CLI's first-run state: the two facts an unattended sandbox
 * needs asserted, everything else preserved, a corrupt file left alone.
 * Plus the C13 resume probe over the CLI's per-project session store.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach } from 'bun:test';

import { ensureClaudeState, hasResumableSession } from './claude-state.js';

const WORKSPACE = '/workspace/group';
let statePath: string;

function read(): Record<string, any> {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

beforeEach(() => {
  statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-claude-state-')), '.claude.json');
});

describe('ensureClaudeState', () => {
  it('creates the file with onboarding done and the workspace trusted', () => {
    expect(ensureClaudeState(WORKSPACE, false, statePath)).toBe(true);
    const state = read();
    expect(state.hasCompletedOnboarding).toBe(true);
    expect(state.projects[WORKSPACE].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves the CLI own keys and other projects', () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        machineID: 'abc123',
        migrationVersion: 13,
        projects: { '/somewhere/else': { hasTrustDialogAccepted: true, history: ['x'] } },
      }),
    );
    ensureClaudeState(WORKSPACE, false, statePath);
    const state = read();
    expect(state.machineID).toBe('abc123');
    expect(state.migrationVersion).toBe(13);
    expect(state.projects['/somewhere/else']).toEqual({ hasTrustDialogAccepted: true, history: ['x'] });
    expect(state.projects[WORKSPACE].hasTrustDialogAccepted).toBe(true);
  });

  it('keeps existing per-project fields while asserting trust', () => {
    fs.writeFileSync(statePath, JSON.stringify({ projects: { [WORKSPACE]: { history: ['prior turn'] } } }));
    ensureClaudeState(WORKSPACE, false, statePath);
    expect(read().projects[WORKSPACE]).toEqual({ history: ['prior turn'], hasTrustDialogAccepted: true });
  });

  it('is idempotent across respawns', () => {
    ensureClaudeState(WORKSPACE, false, statePath);
    const first = fs.readFileSync(statePath, 'utf8');
    ensureClaudeState(WORKSPACE, false, statePath);
    expect(fs.readFileSync(statePath, 'utf8')).toBe(first);
  });

  it('records the bypass acceptance only when the deployment chose it', () => {
    ensureClaudeState(WORKSPACE, false, statePath);
    expect(read().bypassPermissionsModeAccepted).toBeUndefined();
    ensureClaudeState(WORKSPACE, true, statePath);
    expect(read().bypassPermissionsModeAccepted).toBe(true);
  });

  it('leaves a corrupt file untouched and says so', () => {
    fs.writeFileSync(statePath, '{ not json');
    expect(ensureClaudeState(WORKSPACE, false, statePath)).toBe(false);
    expect(fs.readFileSync(statePath, 'utf8')).toBe('{ not json');
  });
});

describe('hasResumableSession', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-claude-home-'));
  });

  it('a fresh workspace has nothing to continue — no store, no dir, no false start', () => {
    expect(hasResumableSession(WORKSPACE, home)).toBe(false);
    // The project dir existing but EMPTY is still a fresh workspace.
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-workspace-group'), { recursive: true });
    expect(hasResumableSession(WORKSPACE, home)).toBe(false);
  });

  it('a transcript in the munged project dir means the reaped conversation is resumable', () => {
    const projectDir = path.join(home, '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a1b2c3.jsonl'), '{}\n');
    expect(hasResumableSession(WORKSPACE, home)).toBe(true);
  });

  it("another project's transcripts are not this workspace's conversation", () => {
    const other = path.join(home, '.claude', 'projects', '-somewhere-else');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'a1b2c3.jsonl'), '{}\n');
    expect(hasResumableSession(WORKSPACE, home)).toBe(false);
  });

  it('non-transcript files in the store do not count', () => {
    const projectDir = path.join(home, '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'x');
    expect(hasResumableSession(WORKSPACE, home)).toBe(false);
  });
});
