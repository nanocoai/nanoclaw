/**
 * propose_repo_edit — barrel wiring and the outbound system action.
 *
 * The barrel (index.ts) starts the MCP server on import, so its import of
 * this module is asserted structurally. The tool itself is driven through a
 * real MCP client/server pair, so the listing and the call go through the
 * same registry the agent sees.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import ts from 'typescript';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import './repo-self-edit.js';
import { createMcpServer } from './server.js';

const DIFF =
  'diff --git a/src/router.ts b/src/router.ts\n--- a/src/router.ts\n+++ b/src/router.ts\n@@ -1 +1 @@\n-a\n+b\n';

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('mcp-tools barrel', () => {
  it('imports the repo-self-edit tool module', () => {
    const file = path.join(import.meta.dir, 'index.ts');
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = sf.statements
      .filter(ts.isImportDeclaration)
      .map((s) => (s.moduleSpecifier as ts.StringLiteral).text);
    expect(imports).toContain('./repo-self-edit.js');
  });
});

describe('propose_repo_edit', () => {
  it('is listed and writes the repo_self_edit system action', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('propose_repo_edit');

    const result = await client.callTool({
      name: 'propose_repo_edit',
      arguments: { diff: DIFF, reason: 'swap a for b' },
    });
    expect(result.isError).not.toBe(true);
    const [row] = getUndeliveredMessages();
    expect(row.kind).toBe('system');
    expect(JSON.parse(row.content)).toEqual({ action: 'repo_self_edit', diff: DIFF, reason: 'swap a for b' });
  });

  it('refuses malformed or oversized proposals without writing anything', async () => {
    const client = await connect();
    for (const args of [
      { diff: '', reason: 'x' },
      { diff: DIFF, reason: '' },
      { diff: '--- a/x\n+++ b/x\n', reason: 'not git format' },
      { diff: DIFF + '+x\n'.repeat(1500), reason: 'too big' },
      { diff: DIFF, reason: 'r'.repeat(301) },
    ]) {
      const result = await client.callTool({ name: 'propose_repo_edit', arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
