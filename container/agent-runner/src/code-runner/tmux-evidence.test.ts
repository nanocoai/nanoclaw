import { describe, expect, test } from 'bun:test';

import { TmuxEvidence } from './tmux-evidence.js';
import type { TmuxExecResult } from './tmux-session.js';

function evidenceWith(result: () => TmuxExecResult): TmuxEvidence {
  return new TmuxEvidence({ socketPath: '/tmp/na.sock', exec: async () => result() });
}

describe('TmuxEvidence', () => {
  test('no server reads as detached, never as an error', async () => {
    const ev = evidenceWith(() => ({ exitCode: 1, stdout: '', stderr: 'no server running' }));
    await ev.poll();
    expect(ev.clientCount).toBe(0);
    expect(ev.lastClientInputAt).toBe(0);
    expect(ev.lastClientConnectAt).toBe(0);
    expect(ev.attachedClientActivityAt).toBeUndefined();
  });

  test('a freshly attached client is connect evidence, not input evidence', async () => {
    const t = 1_755_000_000; // seconds — tmux's own stamp unit
    const ev = evidenceWith(() => ({ exitCode: 0, stdout: `${t} ${t}\n`, stderr: '' }));
    await ev.poll();
    expect(ev.clientCount).toBe(1);
    expect(ev.lastClientConnectAt).toBe(t * 1000);
    // activity == created: an attach happened, no keystroke did. Counting it
    // as input would let an exec-shim orphan masquerade as a typing human.
    expect(ev.lastClientInputAt).toBe(0);
    // …but it IS live-client activity: the connected-client lease counts
    // idle from the attach, and this client verifiably exists right now.
    expect(ev.attachedClientActivityAt).toBe(t * 1000);
  });

  test('live-client activity dies with the connection — never high-water', async () => {
    const t = 1_755_000_000;
    let out = `${t} ${t + 40}\n`;
    let code = 0;
    const ev = evidenceWith(() => ({ exitCode: code, stdout: out, stderr: '' }));
    await ev.poll();
    expect(ev.attachedClientActivityAt).toBe((t + 40) * 1000);

    // Detach: the marks persist (asserted elsewhere); the live stamp must not.
    out = '';
    await ev.poll();
    expect(ev.attachedClientActivityAt).toBeUndefined();

    // A dead server is equally not a live client.
    out = `${t} ${t + 40}\n`;
    code = 1;
    await ev.poll();
    expect(ev.attachedClientActivityAt).toBeUndefined();
  });

  test('activity past the connect stamp is input evidence; marks are high-water across detach', async () => {
    const created = 1_755_000_000;
    let out = `${created} ${created + 40}\n`;
    let code = 0;
    const ev = evidenceWith(() => ({ exitCode: code, stdout: out, stderr: '' }));
    await ev.poll();
    expect(ev.clientCount).toBe(1);
    expect(ev.lastClientInputAt).toBe((created + 40) * 1000);

    // Client detaches (server answers with no lines) — presence drops, but
    // "a human was here recently" outlives the connection that proved it.
    out = '';
    await ev.poll();
    expect(ev.clientCount).toBe(0);
    expect(ev.lastClientInputAt).toBe((created + 40) * 1000);
    expect(ev.lastClientConnectAt).toBe(created * 1000);

    // Even a dead server never rolls the marks back.
    code = 1;
    await ev.poll();
    expect(ev.lastClientInputAt).toBe((created + 40) * 1000);
  });

  test('multiple clients: newest stamp wins per mark', async () => {
    const a = 1_755_000_000;
    const b = a + 100;
    const ev = evidenceWith(() => ({
      exitCode: 0,
      stdout: `${a} ${a + 500}\n${b} ${b}\n`,
      stderr: '',
    }));
    await ev.poll();
    expect(ev.clientCount).toBe(2);
    expect(ev.lastClientConnectAt).toBe(b * 1000);
    expect(ev.lastClientInputAt).toBe((a + 500) * 1000);
    expect(ev.attachedClientActivityAt).toBe((a + 500) * 1000); // min idle = newest live activity
  });

  test('malformed lines are ignored, not crashed on', async () => {
    const ev = evidenceWith(() => ({ exitCode: 0, stdout: 'garbage line\n', stderr: '' }));
    await ev.poll();
    expect(ev.clientCount).toBe(1); // a client exists even if its stamps are unreadable
    expect(ev.lastClientInputAt).toBe(0);
    // An unreadable stamp earns no lease — absent evidence expires, never holds.
    expect(ev.attachedClientActivityAt).toBeUndefined();
  });
});
