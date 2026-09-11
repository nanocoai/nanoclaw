/**
 * Smoke test for the gpt-live channel against the real OpenAI Live API,
 * with no microphone and no browser.
 *
 *   pnpm exec tsx .claude/skills/add-gpt-live/scripts/live-probe.ts [--say "…"] [--clip file.wav] [--project <install dir>]
 *
 * `--project` points at the NanoClaw install whose `.env` holds the key
 * settings (default: the current directory).
 *
 * Opens a primary WebSocket session in client-delegation mode with the same
 * voice prompt the adapter composes, attaches the production sideband to
 * that session, streams a short caller clip (synthesized with macOS `say`
 * unless --clip points at a mono 16-bit 24 kHz WAV), answers the resulting
 * delegation over the sideband the way the adapter would, and waits for the
 * voice model to speak the answer back. Exit code 0 when the reply was
 * spoken, 1 otherwise. Costs a few cents (voice minutes are billed per
 * second).
 *
 * The API key is resolved exactly as the adapter resolves it — `.env`, or
 * the macOS Keychain item named in `.env` — and is never printed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEnvFile } from '../../../../src/env.js';
import { resolveOpenAiKey } from '../../../../src/channels/gpt-live-keychain.js';
import { voiceInstructions } from '../../../../src/channels/gpt-live-prompt.js';
import { attachSideband, type SidebandSocket } from '../../../../src/channels/gpt-live-sideband.js';

const WS_BASE = 'wss://api.openai.com/v1';
const REPLY = 'Tomorrow you have two things: standup at nine, and lunch with Dana at half past twelve.';
const REPLY_MARKER = /Dana|standup|half past/i;
const OVERALL_TIMEOUT_MS = 75_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = path.resolve(arg('--project', process.cwd()));
const env = readEnvFile(
  ['OPENAI_API_KEY', 'GPT_LIVE_KEYCHAIN_SERVICE', 'GPT_LIVE_KEYCHAIN_ACCOUNT', 'GPT_LIVE_VOICE'],
  projectRoot,
);
const key = resolveOpenAiKey(env);
if (!key) {
  console.log(`No OpenAI key: set OPENAI_API_KEY or GPT_LIVE_KEYCHAIN_SERVICE in ${path.join(projectRoot, '.env')} (see /add-gpt-live).`);
  process.exit(2);
}
console.log(`key source: ${key.source} (value not shown)`);

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`;
const line = (msg: string) => console.log(`${stamp()}  ${msg}`);

function clipPath(): string {
  const given = arg('--clip', '');
  if (given) return given;
  if (process.platform !== 'darwin') {
    console.log('Not macOS: pass --clip <mono 16-bit 24 kHz WAV> with the caller\'s question.');
    process.exit(2);
  }
  const text = arg('--say', 'Hi. What is on my calendar tomorrow?');
  const dir = path.join(os.tmpdir(), 'nanoclaw-gpt-live-probe');
  execFileSync('mkdir', ['-p', dir]);
  const aiff = path.join(dir, 'q.aiff');
  const wav = path.join(dir, 'q.wav');
  execFileSync('/usr/bin/say', ['-o', aiff, text]);
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', aiff, wav]);
  line(`caller clip synthesized with say: ${JSON.stringify(text)}`);
  return wav;
}

/** Raw PCM from a WAV file: find the "data" chunk, skip the container. */
function pcmFromWav(file: string): Buffer {
  const buf = readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

const clip = clipPath();
if (!existsSync(clip)) {
  console.log(`clip not found: ${clip}`);
  process.exit(2);
}
const pcm = pcmFromWav(clip);
line(`caller clip: ${(pcm.length / 48000).toFixed(2)} s of PCM16 mono 24 kHz`);

const state = {
  sessionId: '',
  sidebandOpen: false,
  inputTx: '',
  outputTx: '',
  delegationId: '',
  replied: false,
  acked: false,
  audioDeltaBytes: 0,
  lastError: '',
  seen: new Map<string, number>(),
  closed: false,
};
const seenIds = new Set<string>();

const primary = new WebSocket(`${WS_BASE}/live/sessions`, { headers: { Authorization: `Bearer ${key.key}` } });
let sideband: SidebandSocket | null = null;
const send = (ev: Record<string, unknown>) => primary.send(JSON.stringify(ev));

function finish(reason: string): void {
  if (state.closed) return;
  state.closed = true;
  line(`closing (${reason})`);
  try {
    send({ type: 'session.close' });
  } catch {
    /* socket may already be gone */
  }
  setTimeout(() => {
    try {
      sideband?.close();
      primary.close();
    } catch {
      /* ignore */
    }
    const spoke = REPLY_MARKER.test(state.outputTx);
    console.log('\n===== SUMMARY');
    console.log(`session.started       ${state.sessionId ? 'yes  id=' + state.sessionId : 'NO'}`);
    console.log(`sideband attached     ${state.sidebandOpen ? 'yes' : 'NO'}`);
    console.log(`caller transcript     ${state.inputTx ? JSON.stringify(state.inputTx.trim()) : 'NONE'}`);
    console.log(`delegation.created    ${state.delegationId ? 'yes  id=' + state.delegationId : 'NO'}`);
    console.log(`commentary.appended   ${state.acked ? 'yes' : 'NO'}`);
    console.log(`assistant transcript  ${state.outputTx ? JSON.stringify(state.outputTx.trim()) : 'NONE'}`);
    console.log(`spoke the reply       ${spoke ? 'yes' : 'NO'}`);
    console.log(`output audio          ${state.audioDeltaBytes} base64 bytes`);
    console.log(`events: ${[...state.seen.entries()].map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`);
    if (state.lastError) {
      console.log(`last error: ${state.lastError}`);
      if (/output_creation_failed|insufficient_quota|credit/i.test(state.lastError)) {
        console.log(
          'Hint: every session.start failing with output_creation_failed, while the model lists fine, means the project has no prepaid credits — add credits at https://platform.openai.com/settings/organization/billing/ and rerun.',
        );
      }
    }
    process.exit(spoke ? 0 : 1);
  }, 1500);
}

function handle(source: 'primary' | 'sideband', e: Record<string, unknown>): void {
  const type = String(e.type);
  state.seen.set(`${source}:${type}`, (state.seen.get(`${source}:${type}`) ?? 0) + 1);
  const id = typeof e.event_id === 'string' ? e.event_id : '';
  const dup = id ? seenIds.has(id) : false;
  if (id) seenIds.add(id);

  switch (type) {
    case 'session.started': {
      const s = e.session as { id?: string } | undefined;
      if (!s?.id || state.sessionId) return;
      state.sessionId = s.id;
      line(`[${source}] session.started id=${s.id}`);
      void attachSideband({
        wsBase: WS_BASE,
        apiKey: key.key,
        sessionId: s.id,
        onEvent: (ev) => handle('sideband', ev as Record<string, unknown>),
        onClose: (code, reason) => line(`[sideband] closed code=${code} reason=${reason}`),
      })
        .then((sock) => {
          sideband = sock;
          state.sidebandOpen = true;
          line('[sideband] attached — streaming the caller clip on the primary socket');
          streamAudio();
        })
        .catch((err) => {
          line(`[sideband] attach FAILED: ${(err as Error).message}`);
          streamAudio();
        });
      return;
    }
    case 'session.output_audio.delta':
      state.audioDeltaBytes += String(e.delta ?? '').length;
      return;
    case 'session.input_transcript.delta':
      if (dup) return;
      state.inputTx += String(e.delta ?? '');
      line(`[${source}] caller: ${JSON.stringify(String(e.delta ?? ''))}`);
      return;
    case 'session.output_transcript.delta':
      if (dup) return;
      state.outputTx += String(e.delta ?? '');
      line(`[${source}] assistant: ${JSON.stringify(String(e.delta ?? ''))}`);
      if (state.replied && REPLY_MARKER.test(state.outputTx)) setTimeout(() => finish('reply was spoken'), 2500);
      return;
    case 'session.delegation.created': {
      const d = e.delegation as { id?: string; target?: string } | undefined;
      line(`[${source}] delegation.created id=${d?.id} target=${d?.target} offset_ms=${String(e.offset_ms)}`);
      if (state.delegationId || !d?.id) return;
      state.delegationId = d.id;
      const out = sideband ?? { send: (data: string) => primary.send(data) };
      setTimeout(() => {
        out.send(
          JSON.stringify({ type: 'session.thinking.append', event_id: 'probe_think_1', delegation_id: d.id, content: 'Checking the calendar.' }),
        );
        out.send(JSON.stringify({ type: 'session.commentary.append', event_id: 'probe_reply_1', delegation_id: d.id, content: REPLY }));
        state.replied = true;
        line(`[${sideband ? 'sideband' : 'primary'}] sent thinking.append + commentary.append for ${d.id}`);
      }, 400);
      return;
    }
    case 'session.commentary.appended':
      state.acked = true;
      line(`[${source}] commentary.appended event_id=${id}`);
      return;
    case 'session.thinking.appended':
      line(`[${source}] thinking.appended event_id=${id}`);
      return;
    case 'session.usage.updated':
      line(`[${source}] usage.updated ${JSON.stringify(e.usage ?? {}).slice(0, 200)}`);
      return;
    case 'session.closed':
      line(`[${source}] session.closed`);
      finish('server closed');
      return;
    case 'error': {
      const err = JSON.stringify(e.error ?? e).slice(0, 400);
      state.lastError = err;
      line(`[${source}] ERROR ${err}`);
      if (!state.sessionId) finish('session.start rejected');
      return;
    }
    default:
      if (!dup) line(`[${source}] ${type}`);
  }
}

function streamAudio(): void {
  // 100 ms chunks at 24 kHz PCM16 mono = 4,800 bytes, paced in real time, then 1.5 s of silence.
  const CHUNK = 4800;
  const all = Buffer.concat([pcm, Buffer.alloc(CHUNK * 15)]);
  let off = 0;
  const timer = setInterval(() => {
    if (off >= all.length) {
      clearInterval(timer);
      line('caller clip fully sent (plus 1.5 s of silence)');
      return;
    }
    send({ type: 'session.input_audio.append', audio: all.subarray(off, off + CHUNK).toString('base64') });
    off += CHUNK;
  }, 100);
}

primary.addEventListener('open', () => {
  line('[primary] socket open — sending session.start (client delegation, pcm 24 kHz)');
  send({
    type: 'session.start',
    session: {
      model: 'gpt-live-1',
      instructions: voiceInstructions({ name: 'Andy', personality: 'Calm, precise, a little dry.' }),
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: env.GPT_LIVE_VOICE || 'marin' } },
      delegation: { type: 'client' },
    },
  });
});
primary.addEventListener('message', (ev: MessageEvent) => {
  if (typeof ev.data !== 'string') return;
  try {
    handle('primary', JSON.parse(ev.data) as Record<string, unknown>);
  } catch (err) {
    line(`[primary] unparseable: ${(err as Error).message}`);
  }
});
primary.addEventListener('error', () => line('[primary] socket error'));
primary.addEventListener('close', (ev: { code: number; reason: string }) => {
  line(`[primary] closed code=${ev.code} reason=${ev.reason}`);
  finish('primary closed');
});
setTimeout(() => finish('overall timeout'), OVERALL_TIMEOUT_MS);
