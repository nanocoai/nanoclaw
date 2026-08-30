import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ABSOLUTE_CEILING_MS, CLAIM_STUCK_MS, agentStarted, decideLiveness, heartbeatFresh, livenessHealthy } from './agent-health.js';

const NOW = Date.parse('2026-08-26T00:00:00.000Z');
const files: string[] = [];
afterEach(() => files.splice(0).forEach((file) => fs.rmSync(file, { force: true })));

describe('agent health', () => {
  it('uses six-second activity freshness', () => {
    const file = path.join(os.tmpdir(), `ncl-health-${crypto.randomUUID()}`);
    files.push(file);
    fs.writeFileSync(file, String(NOW - 1_000));
    fs.utimesSync(file, new Date(NOW - 5_999), new Date(NOW - 5_999));
    expect(heartbeatFresh(NOW, file)).toBe(true);
    fs.utimesSync(file, new Date(NOW - 6_000), new Date(NOW - 6_000));
    expect(heartbeatFresh(NOW, file)).toBe(false);
  });

  it('reports an IDLE-but-started agent Ready, and a never-started one NotReady', () => {
    const file = path.join(os.tmpdir(), `ncl-ready-${crypto.randomUUID()}`);
    files.push(file);
    // heartbeat-init's seed: start time as content, mtime backdated to epoch 0.
    fs.writeFileSync(file, String(NOW - 1_000));
    fs.utimesSync(file, new Date(0), new Date(0));
    expect(agentStarted(file)).toBe(false);

    // The runner beat once, then went idle far beyond the freshness window.
    fs.utimesSync(file, new Date(NOW - 60 * 60_000), new Date(NOW - 60 * 60_000));
    expect(heartbeatFresh(NOW, file)).toBe(false); // stale by activity…
    expect(agentStarted(file)).toBe(true); // …but up, so Ready.
  });

  it('reports NotReady when the heartbeat file is absent entirely', () => {
    expect(agentStarted(path.join(os.tmpdir(), `ncl-missing-${crypto.randomUUID()}`))).toBe(false);
  });

  it('matches the OSS ceiling, Bash timeout, and claim-stuck predicates', () => {
    expect(decideLiveness({
      now: NOW,
      heartbeatMtimeMs: NOW - ABSOLUTE_CEILING_MS - 1,
      containerState: null,
      claims: [],
    }).action).toBe('kill-ceiling');
    expect(decideLiveness({
      now: NOW,
      heartbeatMtimeMs: NOW - CLAIM_STUCK_MS - 1,
      containerState: { currentTool: 'Bash', toolDeclaredTimeoutMs: ABSOLUTE_CEILING_MS * 2 },
      claims: [{ messageId: 'm', statusChanged: new Date(NOW - CLAIM_STUCK_MS - 1).toISOString() }],
    }).action).toBe('ok');
    expect(decideLiveness({
      now: NOW,
      heartbeatMtimeMs: NOW - CLAIM_STUCK_MS - 1,
      containerState: null,
      claims: [{ messageId: 'm', statusChanged: new Date(NOW - CLAIM_STUCK_MS - 1).toISOString() }],
    })).toEqual({ action: 'kill-claim', messageId: 'm' });
  });

  it('uses the pod start time when no heartbeat exists', () => {
    expect(decideLiveness({
      now: NOW,
      heartbeatMtimeMs: 0,
      containerStartedAtMs: NOW - ABSOLUTE_CEILING_MS - 1,
      containerState: null,
      claims: [],
    }).action).toBe('kill-ceiling');
  });

  it('keeps probe infrastructure failures non-destructive', async () => {
    expect(await livenessHealthy(NOW, '/missing-heartbeat', () => { throw new Error('gateway unavailable'); })).toBe(true);
  });
});
