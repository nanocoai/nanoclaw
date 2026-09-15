/**
 * Seeding the CLI's first-run state: the two facts an unattended sandbox
 * needs asserted, everything else preserved, a corrupt file left alone.
 * Plus the per-session conversation id and the transcript probe over the
 * CLI's per-project session store.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach } from 'bun:test';

import {
  conversationArgsResolver,
  ensureClaudeState,
  hasTranscript,
  mintConversationId,
  readConversationId,
  recordConversationId,
  resolveConversationId,
} from './claude-state.js';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveConversationId', () => {
  let statePath: string;

  beforeEach(() => {
    statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-conversation-')), 'code-session.json');
  });

  it('derives one id per session (uuid v5), records it, and reads it back on the next boot', () => {
    const first = resolveConversationId('sess-1', statePath);
    expect(first).toMatch(UUID);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ conversationId: first });
    expect(resolveConversationId('sess-1', statePath)).toBe(first);
    // Same session id elsewhere → the same conversation: a lost state file finds it again.
    const elsewhere = path.join(path.dirname(statePath), 'other.json');
    expect(resolveConversationId('sess-1', elsewhere)).toBe(first);
    expect(resolveConversationId('sess-2', elsewhere + '2')).not.toBe(first);
  });

  it('a saved id wins over the derivation (a fresh conversation minted after a failed resume)', () => {
    fs.writeFileSync(statePath, JSON.stringify({ conversationId: '11111111-2222-4333-8444-555555555555' }));
    expect(resolveConversationId('sess-1', statePath)).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('a corrupt or non-uuid saved id is replaced, and no session id means a random one', () => {
    fs.writeFileSync(statePath, '{ not json');
    const id = resolveConversationId('sess-1', statePath);
    expect(id).toMatch(UUID);
    fs.writeFileSync(statePath, JSON.stringify({ conversationId: 'latest' }));
    expect(resolveConversationId('sess-1', statePath)).toBe(id);
    const random = resolveConversationId(null, path.join(path.dirname(statePath), 'anon.json'));
    expect(random).toMatch(/^[0-9a-f-]{36}$/);
    expect(random).not.toBe(id);
  });

  it('mintConversationId replaces the saved id with a new one', () => {
    const first = resolveConversationId('sess-1', statePath);
    const minted = mintConversationId(statePath);
    expect(minted).not.toBe(first);
    expect(resolveConversationId('sess-1', statePath)).toBe(minted);
  });
});

describe('recordConversationId', () => {
  let statePath: string;
  const live = '0f0e0d0c-0b0a-4908-8706-050403020100';

  beforeEach(() => {
    statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-conversation-')), 'code-session.json');
  });

  it("puts the CLI's live conversation on record, replacing the minted one", () => {
    const minted = resolveConversationId('sess-1', statePath);
    expect(recordConversationId(live, statePath)).toBe(true);
    expect(readConversationId(statePath)).toBe(live);
    expect(readConversationId(statePath)).not.toBe(minted);
    // Unchanged: no rewrite.
    expect(recordConversationId(live.toUpperCase(), statePath)).toBe(false);
  });

  it('ignores anything that is not a uuid', () => {
    resolveConversationId('sess-1', statePath);
    const before = readConversationId(statePath);
    expect(recordConversationId('latest', statePath)).toBe(false);
    expect(recordConversationId(undefined, statePath)).toBe(false);
    expect(recordConversationId({ id: live }, statePath)).toBe(false);
    expect(readConversationId(statePath)).toBe(before);
  });
});

describe('conversationArgsResolver', () => {
  let home: string;
  let statePath: string;
  const lines: string[] = [];

  function transcript(id: string): void {
    const projectDir = path.join(home, '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), '{}\n');
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-claude-home-'));
    statePath = path.join(home, 'code-session.json');
    lines.length = 0;
  });

  it('starts the minted conversation, resumes it once its transcript exists', () => {
    const args = conversationArgsResolver({
      sessionId: 'sess-1',
      workspaceDir: WORKSPACE,
      statePath,
      home,
      log: (l) => lines.push(l),
    });
    const id = readConversationId(statePath)!;
    expect(args({ life: 1, previousLifeHealthy: null })).toEqual(['--session-id', id]);
    transcript(id);
    expect(args({ life: 2, previousLifeHealthy: true })).toEqual(['--resume', id]);
    expect(lines).toEqual([
      `[code-runner] life 1: starting conversation ${id}`,
      `[code-runner] life 2: resuming conversation ${id}`,
    ]);
  });

  it('after /clear the hook records the new id, and the next life resumes THAT conversation', () => {
    const args = conversationArgsResolver({ sessionId: 'sess-1', workspaceDir: WORKSPACE, statePath, home });
    const minted = readConversationId(statePath)!;
    args({ life: 1, previousLifeHealthy: null });
    transcript(minted);
    // The operator clears: the CLI opens a new conversation and its SessionStart hook reports it.
    const cleared = '0f0e0d0c-0b0a-4908-8706-050403020100';
    recordConversationId(cleared, statePath);
    transcript(cleared);
    expect(args({ life: 2, previousLifeHealthy: true })).toEqual(['--resume', cleared]);
    // A recorded id with no transcript yet is started under that id, not resumed.
    const fresh = '11111111-2222-4333-8444-555555555555';
    recordConversationId(fresh, statePath);
    expect(args({ life: 3, previousLifeHealthy: true })).toEqual(['--session-id', fresh]);
  });

  it('a resumed life that dies early is abandoned for a fresh conversation, once', () => {
    const args = conversationArgsResolver({ sessionId: 'sess-1', workspaceDir: WORKSPACE, statePath, home });
    const id = readConversationId(statePath)!;
    transcript(id);
    expect(args({ life: 1, previousLifeHealthy: null })).toEqual(['--resume', id]);
    const second = args({ life: 2, previousLifeHealthy: false });
    expect(second[0]).toBe('--session-id');
    expect(second[1]).not.toBe(id);
    expect(readConversationId(statePath)).toBe(second[1]);
    // The fresh conversation dying early too is not a reason to mint again.
    expect(args({ life: 3, previousLifeHealthy: false })).toEqual(['--session-id', second[1]]);
  });
});

describe('hasTranscript', () => {
  let home: string;
  const id = '3f2c9a40-6b1e-5c7d-8e9f-0a1b2c3d4e5f';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-claude-home-'));
  });

  it('a fresh workspace has nothing to resume — no store, no dir, no false start', () => {
    expect(hasTranscript(WORKSPACE, id, home)).toBe(false);
    // The project dir existing but EMPTY is still a fresh workspace.
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-workspace-group'), { recursive: true });
    expect(hasTranscript(WORKSPACE, id, home)).toBe(false);
  });

  it("this conversation's transcript in the munged project dir means it is resumable", () => {
    const projectDir = path.join(home, '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), '{}\n');
    expect(hasTranscript(WORKSPACE, id, home)).toBe(true);
  });

  it("another session's transcript in the same project dir is not this conversation", () => {
    const projectDir = path.join(home, '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a1b2c3d4-0000-4000-8000-000000000000.jsonl'), '{}\n');
    expect(hasTranscript(WORKSPACE, id, home)).toBe(false);
  });

  it("another project's transcript is not this workspace's conversation", () => {
    const other = path.join(home, '.claude', 'projects', '-somewhere-else');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, `${id}.jsonl`), '{}\n');
    expect(hasTranscript(WORKSPACE, id, home)).toBe(false);
  });
});
