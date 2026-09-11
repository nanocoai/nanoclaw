/** Runner startup and mailbox delivery through the production tmux session. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { loadConfig } from '../config.js';
import { registerAgentMailbox, resetAgentMailboxForTesting } from '../mailbox/index.js';
import { SqliteAgentMailbox } from '../mailbox/sqlite/index.js';
import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import type { AgentMailboxFactory } from '../mailbox/types.js';
import { MailboxDeliveryLoop } from './mailbox.js';
import { sleep, spawnTmuxClient, startTmuxStack, waitFor } from './term-audit/harness.js';
import { CMD_SGR, PROBE_SGR_END } from './term-audit/probe.js';

for (const brokenBinary of [false, true]) {
  test(`startup refuses ${brokenBinary ? 'a failing' : 'a missing'} tmux executable`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-runner-boot-'));
    const config = path.join(dir, 'container.json');
    fs.writeFileSync(config, JSON.stringify({ agentGroupId: 'tmux-required', codeMode: true }));
    if (brokenBinary) fs.writeFileSync(path.join(dir, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    try {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'index.ts')], {
        cwd: dir,
        env: { ...process.env, PATH: dir, NANOCLAW_CONTAINER_JSON: config },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(stderr).toContain('Code mode requires tmux in the agent image');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

describe.if(Bun.which('tmux') !== null)('mailbox delivery through tmux', () => {
  let inbound: ReturnType<typeof initTestSessionDb>['inbound'];
  let composed: AgentMailboxFactory | undefined;

  beforeEach(() => {
    loadConfig();
    inbound = initTestSessionDb().inbound;
    composed = resetAgentMailboxForTesting();
    registerAgentMailbox(() => new SqliteAgentMailbox());
  });
  afterEach(() => {
    closeSessionDb();
    resetAgentMailboxForTesting();
    if (composed) registerAgentMailbox(composed);
  });

  function seedInbound(id: string, text: string): void {
    inbound
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, on_wake, content)
       VALUES (?, 'chat', ?, 'pending', 1, 0, ?)`,
      )
      .run(id, new Date().toISOString(), JSON.stringify({ text, sender: 'operator' }));
  }

  test('delivers mail to an attached terminal and continues after the client disconnects', async () => {
    const stack = await startTmuxStack();
    const client = spawnTmuxClient(stack.socketPath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-mailbox-'));
    const stateFilePath = path.join(dir, 'state.json');
    const loop = new MailboxDeliveryLoop({
      session: stack.session,
      stateFilePath,
      lastOperatorInputAt: () => stack.evidence.lastClientInputAt,
      onFatal: () => {},
    });
    try {
      await waitFor(() => stack.evidence.clientCount === 1, 'the attached operator');
      const idle = () =>
        fs.writeFileSync(stateFilePath, JSON.stringify({ state: 'idle', at: new Date().toISOString() }));
      idle();
      seedInbound('m1', `mail one ${CMD_SGR}`);
      await loop.tick();
      await waitFor(() => stack.rx().includes(Buffer.from('mail one')), 'mail at the session process');
      await waitFor(() => client.output().includes(PROBE_SGR_END), 'mail on the operator terminal');

      // A newer hook stamp acknowledges the first injection before the next one.
      await sleep(10);
      idle();
      client.kill();
      await client.exited;
      await waitFor(() => stack.evidence.clientCount === 0, 'the disconnected operator');
      seedInbound('m2', 'mail two');
      await loop.tick();
      await waitFor(() => stack.rx().includes(Buffer.from('mail two')), 'mail after disconnect');
      expect(stack.session.running).toBe(true);
    } finally {
      loop.stop();
      client.kill();
      stack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
