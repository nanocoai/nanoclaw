/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import fs from 'fs';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendMessage, sendFile } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  mock.restore();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_file MCP tool — workspace confinement', () => {
  function mockFile(realPath: string) {
    spyOn(fs, 'existsSync').mockReturnValue(true);
    spyOn(fs, 'realpathSync').mockReturnValue(realPath);
    spyOn(fs, 'mkdirSync').mockReturnValue(undefined as never);
    return spyOn(fs, 'copyFileSync').mockReturnValue(undefined as never);
  }

  it('rejects absolute paths whose canonical location is outside /workspace', async () => {
    mockFile('/etc/passwd');

    const result = await sendFile.handler({ to: 'peer', path: '/etc/passwd' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('path must be within /workspace');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects /workspace symlinks that resolve outside /workspace', async () => {
    mockFile('/host/secrets/token');

    const result = await sendFile.handler({ to: 'peer', path: '/workspace/agent/link-to-secret' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('path must be within /workspace');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('basenames caller-provided filenames before writing to the outbox', async () => {
    const copyFile = mockFile('/workspace/agent/report.txt');

    const result = await sendFile.handler({
      to: 'peer',
      path: '/workspace/agent/report.txt',
      filename: '../../skills/evil/SKILL.md',
    });

    expect(result.isError).toBeUndefined();
    expect(copyFile).toHaveBeenCalledTimes(1);
    expect(copyFile.mock.calls[0][0]).toBe('/workspace/agent/report.txt');
    expect(String(copyFile.mock.calls[0][1])).toMatch(/^\/workspace\/outbox\/[^/]+\/SKILL\.md$/);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).files).toEqual(['SKILL.md']);
  });
});
