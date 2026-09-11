/**
 * Browser probe for the Live Voice channel: a real WebRTC call through the
 * production adapter, with a synthesized caller instead of a microphone and
 * a canned backend instead of a NanoClaw agent.
 *
 *   pnpm exec tsx .claude/skills/add-live-voice/scripts/browser-probe.ts [--port 3210] [--say "…"] [--clip file.wav] [--project <install dir>]
 *
 * Then open the printed URL in a browser and press Start. The page plays the
 * caller clip into the peer connection's audio track, posts its SDP offer to
 * the adapter's real `sdp` route, and the adapter does the rest exactly as
 * in production: creates the Live session, attaches the sideband, turns the
 * delegation into an inbound message. This probe answers that message with a
 * fixed reply and logs every sideband event, so the terminal shows whether
 * the voice model spoke the reply back. Costs a few cents of voice time.
 *
 * The API key is resolved exactly as the adapter resolves it and never
 * printed. Ctrl-C to stop.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { InboundMessage } from '../../../../src/channels/adapter.js';
import { createGptLiveAdapter } from '../../../../src/channels/gpt-live.js';
import { resolveOpenAiKey } from '../../../../src/channels/gpt-live-keychain.js';
import { readEnvFile } from '../../../../src/env.js';
import { registerWebhookHandler } from '../../../../src/webhook-server.js';

const REPLY = 'Tomorrow you have two things: standup at nine, and lunch with Dana at half past twelve.';
const REPLY_MARKER = /Dana|standup|half past/i;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('--port', '3210'));
process.env.WEBHOOK_PORT = String(port);
const projectRoot = path.resolve(arg('--project', process.cwd()));
const env = readEnvFile(
  ['OPENAI_API_KEY', 'GPT_LIVE_KEYCHAIN_SERVICE', 'GPT_LIVE_KEYCHAIN_ACCOUNT', 'GPT_LIVE_VOICE'],
  projectRoot,
);
const key = resolveOpenAiKey(env);
if (!key) {
  console.log(`No OpenAI key: set OPENAI_API_KEY or GPT_LIVE_KEYCHAIN_SERVICE in ${path.join(projectRoot, '.env')}.`);
  process.exit(2);
}
console.log(`key source: ${key.source} (value not shown)`);

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s`;
const line = (msg: string) => console.log(`${stamp()}  ${msg}`);

function clipPath(): string {
  const given = arg('--clip', '');
  if (given) return given;
  if (process.platform !== 'darwin') {
    console.log("Not macOS: pass --clip <WAV> with the caller's question.");
    process.exit(2);
  }
  const text = arg('--say', 'Hi. What is on my calendar tomorrow?');
  const dir = path.join(os.tmpdir(), 'nanoclaw-live-voice-probe');
  execFileSync('mkdir', ['-p', dir]);
  const aiff = path.join(dir, 'b.aiff');
  const wav = path.join(dir, 'b.wav');
  execFileSync('/usr/bin/say', ['-o', aiff, text]);
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', aiff, wav]);
  line(`caller clip synthesized with say: ${JSON.stringify(text)}`);
  return wav;
}
const clip = clipPath();
if (!existsSync(clip)) {
  console.log(`clip not found: ${clip}`);
  process.exit(2);
}
const clipBytes = readFileSync(clip);

const outputTx = new Map<string, string>();
const adapter = createGptLiveAdapter({
  apiKey: key.key,
  publicUrl: `http://127.0.0.1:${port}`,
  voice: env.GPT_LIVE_VOICE || 'marin',
  linkTokens: ['probe'],
  fallbackAgentName: 'Andy',
  resolveAgent: async () => ({ name: 'Andy', personality: 'Calm, precise, a little dry.' }),
  onSidebandEvent: (sessionId, e) => {
    const type = String(e.type);
    if (type === 'session.input_transcript.delta') line(`[${sessionId}] caller: ${JSON.stringify(String(e.delta ?? ''))}`);
    else if (type === 'session.output_transcript.delta') {
      const before = outputTx.get(sessionId) ?? '';
      const soFar = before + String(e.delta ?? '');
      outputTx.set(sessionId, soFar);
      line(`[${sessionId}] assistant: ${JSON.stringify(String(e.delta ?? ''))}`);
      if (!REPLY_MARKER.test(before) && REPLY_MARKER.test(soFar)) line(`[${sessionId}] >>> the backend reply is being spoken`);
    } else if (type === 'session.delegation.created') {
      const d = e.delegation as { id?: string } | undefined;
      line(`[${sessionId}] delegation.created id=${d?.id}`);
    } else if (type === 'session.usage.updated') line(`[${sessionId}] usage ${JSON.stringify(e.usage ?? {})}`);
    else if (type === 'error') line(`[${sessionId}] ERROR ${JSON.stringify(e.error ?? e).slice(0, 300)}`);
    else if (type !== 'session.output_audio.delta') line(`[${sessionId}] ${type}`);
  },
});

await adapter.setup({
  onInbound: (platformId: string, _threadId: string | null, message: InboundMessage) => {
    const c = message.content as { text?: string; gptLive?: { delegationId?: string } };
    line(`inbound for ${platformId} (delegation ${c.gptLive?.delegationId}): ${JSON.stringify(c.text ?? '')}`);
    setTimeout(() => {
      void adapter.deliver(platformId, null, { kind: 'chat', content: { text: REPLY } }).then((id) => {
        line(`canned backend reply delivered (event ${id})`);
      });
    }, 800);
  },
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
});

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Live Voice browser probe</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;margin:32px auto;padding:0 16px}pre{background:#f4f4f6;padding:12px;border-radius:8px;white-space:pre-wrap;min-height:80px}button{font:inherit;padding:10px 18px;border-radius:999px;border:0;background:#0b5fff;color:#fff;cursor:pointer}</style></head>
<body><h1>Live Voice browser probe</h1>
<p>Press Start. A synthesized caller plays into a real WebRTC call through the adapter; watch the terminal for the sideband log.</p>
<button id="start" type="button">Start</button>
<pre id="log"></pre><audio id="remote" autoplay playsinline></audio>
<script>
(function () {
  var logEl = document.getElementById('log');
  function log(m) { logEl.textContent += m + '\\n'; }
  document.getElementById('start').addEventListener('click', async function () {
    var btn = document.getElementById('start'); btn.disabled = true;
    try {
      var t = new URLSearchParams(location.search).get('t') || 'probe';
      var ctx = new AudioContext(); await ctx.resume();
      var wav = await (await fetch('clip.wav')).arrayBuffer();
      var buf = await ctx.decodeAudioData(wav);
      var dest = ctx.createMediaStreamDestination();
      var src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest);
      // A real microphone has a noise floor; a synthetic track goes digitally silent after the clip and the
      // sender may stop packets (silence suppression), which stalls the full-duplex session. Keep a whisper
      // of noise (about -70 dBFS) looping for the whole call.
      var noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); var nd = noiseBuf.getChannelData(0);
      for (var i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.0003;
      var noise = ctx.createBufferSource(); noise.buffer = noiseBuf; noise.loop = true; noise.connect(dest); noise.start();
      var pc = new RTCPeerConnection();
      pc.ontrack = function (e) { document.getElementById('remote').srcObject = e.streams[0]; log('remote audio track received'); };
      dest.stream.getTracks().forEach(function (tr) { pc.addTrack(tr, dest.stream); });
      var dc = pc.createDataChannel('oai-events');
      dc.onopen = function () { log('data channel open'); };
      dc.onmessage = function (e) { try { var ev = JSON.parse(e.data); if (ev.type && ev.type !== 'session.output_audio.delta') log('dc ' + ev.type + (ev.delta ? ' ' + JSON.stringify(ev.delta) : '')); } catch (err) {} };
      pc.onconnectionstatechange = function () { log('peer connection: ' + pc.connectionState); };
      var offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      await new Promise(function (r) { if (pc.iceGatheringState === 'complete') return r(); pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') r(); }); setTimeout(r, 1500); });
      var res = await fetch('/webhook/voice/sdp?t=' + encodeURIComponent(t), { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
      log('sdp: HTTP ' + res.status + ' session ' + (res.headers.get('x-voice-session') || '?'));
      if (!res.ok) { log(await res.text()); return; }
      var answer = await res.text();
      var fmtp = answer.match(/a=fmtp:[^\\r\\n]*/g) || [];
      log('answer fmtp: ' + (fmtp.join(' | ') || 'none'));
      log('answer usedtx: ' + (/usedtx=1/.test(answer) ? 'yes' : 'no'));
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      setTimeout(function () { src.start(); log('caller clip playing'); }, 3000);
    } catch (err) { log('error: ' + (err && err.message ? err.message : err)); }
  });
})();
</script></body></html>`;

registerWebhookHandler('live-voice-probe', (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.endsWith('/clip.wav')) {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
    res.end(clipBytes);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE);
});

console.log(`\nOpen  http://127.0.0.1:${port}/webhook/live-voice-probe/?t=probe  and press Start. Ctrl-C to stop.\n`);
