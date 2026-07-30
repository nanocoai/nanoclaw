import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import {
  listVaultAgents,
  readAgentGroupIds,
  resolveOnecliDeletions,
  splitVaultAgents,
  type VaultAgent,
} from './onecli-agents.js';

const agent = (uuid: string, identifier: string, name = identifier): VaultAgent => ({
  uuid,
  identifier,
  name,
});

describe('listVaultAgents', () => {
  it('parses non-default agents from onecli JSON output', () => {
    const payload = JSON.stringify({
      data: [
        { id: 'u-1', identifier: 'ag-main', name: 'Main', isDefault: false },
        { id: 'u-2', identifier: 'default', name: 'Default', isDefault: false },
        { id: 'u-3', identifier: 'ag-dev', name: 'Dev', isDefault: true },
      ],
    });
    const result = listVaultAgents(() => ({ status: 0, stdout: payload }));
    expect(result.available).toBe(true);
    expect(result.agents).toEqual([agent('u-1', 'ag-main', 'Main')]);
  });

  it('reports unavailable when the command fails', () => {
    expect(listVaultAgents(() => ({ status: 1, stdout: '' })).available).toBe(false);
  });

  it('reports unavailable when the command cannot be spawned', () => {
    const result = listVaultAgents(() => {
      throw new Error('ENOENT');
    });
    expect(result.available).toBe(false);
    expect(result.agents).toEqual([]);
  });

  it('reports unavailable on unparseable output', () => {
    expect(listVaultAgents(() => ({ status: 0, stdout: 'not json' })).available).toBe(false);
    expect(listVaultAgents(() => ({ status: 0, stdout: '{"nope":1}' })).available).toBe(false);
  });
});

describe('readAgentGroupIds', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-uninstall-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads ids from a real DB', () => {
    const dbPath = path.join(tempDir, 'v2.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO agent_groups (id) VALUES (?)').run('ag-one');
    db.prepare('INSERT INTO agent_groups (id) VALUES (?)').run('ag-two');
    db.close();

    const result = readAgentGroupIds(dbPath);
    expect(result.known).toBe(true);
    expect(result.ids).toEqual(new Set(['ag-one', 'ag-two']));
  });

  it('returns known:false for a missing file', () => {
    const result = readAgentGroupIds(path.join(tempDir, 'missing.db'));
    expect(result.known).toBe(false);
    expect(result.ids.size).toBe(0);
  });

  it('returns known:false for a corrupt file', () => {
    const dbPath = path.join(tempDir, 'corrupt.db');
    fs.writeFileSync(dbPath, 'this is not a sqlite database at all');
    const result = readAgentGroupIds(dbPath);
    expect(result.known).toBe(false);
    expect(result.ids.size).toBe(0);
  });
});

describe('splitVaultAgents', () => {
  it('splits mine vs ag-* orphans and ignores foreign identifiers', () => {
    const agents = [
      agent('u-1', 'ag-mine'),
      agent('u-2', 'ag-other'),
      agent('u-3', 'some-tool'),
    ];
    const { mine, orphans } = splitVaultAgents(agents, new Set(['ag-mine']), true);
    expect(mine).toEqual([agent('u-1', 'ag-mine')]);
    expect(orphans).toEqual([agent('u-2', 'ag-other')]);
  });

  it('forces all ag-* agents into orphans when ids are unknown', () => {
    const agents = [agent('u-1', 'ag-mine'), agent('u-2', 'ag-other')];
    // ids set even contains ag-mine — known:false must override.
    const { mine, orphans } = splitVaultAgents(agents, new Set(['ag-mine']), false);
    expect(mine).toEqual([]);
    expect(orphans).toEqual(agents);
  });
});

describe('resolveOnecliDeletions', () => {
  const mine = [agent('u-1', 'ag-mine')];
  const orphans = [agent('u-2', 'ag-other')];

  it('never deletes orphans under --yes, even if asked to', () => {
    const deletions = resolveOnecliDeletions({
      mine,
      orphans,
      assumeYes: true,
      deleteMine: false,
      deleteOrphans: true,
    });
    expect(deletions).toEqual(mine);
  });

  it('deletes orphans only on explicit interactive consent', () => {
    expect(
      resolveOnecliDeletions({
        mine,
        orphans,
        assumeYes: false,
        deleteMine: true,
        deleteOrphans: true,
      }),
    ).toEqual([...mine, ...orphans]);

    expect(
      resolveOnecliDeletions({
        mine,
        orphans,
        assumeYes: false,
        deleteMine: false,
        deleteOrphans: false,
      }),
    ).toEqual([]);
  });
});
