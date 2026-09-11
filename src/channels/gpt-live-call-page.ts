/**
 * The browser call page for the gpt-live channel, served by the adapter at
 * `/webhook/gpt-live/call?t=<link token>`.
 *
 * Plain WebRTC, no framework, no external resources. The page: greets by the
 * wired agent's name (`info` route), captures the microphone, posts its SDP
 * offer to the adapter's `sdp` route (same directory, so the link token in the
 * query string travels with it), applies the answer, plays the remote track.
 * A data channel carries the session's events back, which drive the agent
 * state (listening, thinking, speaking) and the live transcript.
 *
 * Visual language follows the voice-agent UI conventions people know from
 * LiveKit's Agents UI — a bar visualizer for the agent's voice, a state chip,
 * transcript bubbles, a control bar — hand-built so the skill ships one
 * self-contained file that cannot drift from the routes it talks to.
 */
export function callPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>NanoClaw voice</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='30' fill='%235b5bff'/%3E%3Crect x='18' y='24' width='6' height='16' rx='3' fill='%23fff'/%3E%3Crect x='29' y='16' width='6' height='32' rx='3' fill='%23fff'/%3E%3Crect x='40' y='22' width='6' height='20' rx='3' fill='%23fff'/%3E%3C/svg%3E">
<style>
  :root {
    --logo: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIQAAACECAIAAADeJhTwAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAARGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAACEoAMABAAAAAEAAACEAAAAAM4GhXgAAAPAaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOklwdGM0eG1wRXh0PSJodHRwOi8vaXB0Yy5vcmcvc3RkL0lwdGM0eG1wRXh0LzIwMDgtMDItMjkvIgogICAgICAgICAgICB4bWxuczpleGlmPSJodHRwOi8vbnMuYWRvYmUuY29tL2V4aWYvMS4wLyIKICAgICAgICAgICAgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIj4KICAgICAgICAgPElwdGM0eG1wRXh0OkRpZ2l0YWxTb3VyY2VUeXBlPmh0dHA6Ly9jdi5pcHRjLm9yZy9uZXdzY29kZXMvZGlnaXRhbHNvdXJjZXR5cGUvdHJhaW5lZEFsZ29yaXRobWljTWVkaWE8L0lwdGM0eG1wRXh0OkRpZ2l0YWxTb3VyY2VUeXBlPgogICAgICAgICA8SXB0YzR4bXBFeHQ6RGlnaXRhbFNvdXJjZUZpbGVUeXBlPmh0dHA6Ly9jdi5pcHRjLm9yZy9uZXdzY29kZXMvZGlnaXRhbHNvdXJjZXR5cGUvdHJhaW5lZEFsZ29yaXRobWljTWVkaWE8L0lwdGM0eG1wRXh0OkRpZ2l0YWxTb3VyY2VGaWxlVHlwZT4KICAgICAgICAgPGV4aWY6UGl4ZWxZRGltZW5zaW9uPjYwMDwvZXhp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');
    --bg: #f3f4f8; --card: #ffffff; --ink: #14161b; --muted: #6a7080; --line: #e5e7ee;
    --accent: #5b5bff; --accent-2: #9a6bff; --accent-soft: rgba(91, 91, 255, 0.12);
    --you: #0d9c86; --you-soft: rgba(13, 156, 134, 0.14); --danger: #d64541; --ok: #22a35a;
    --shadow: 0 18px 50px rgba(20, 24, 40, 0.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d0f14; --card: #161920; --ink: #eceef4; --muted: #9aa2b6; --line: #262b36;
      --accent: #8d8dff; --accent-2: #b48cff; --accent-soft: rgba(141, 141, 255, 0.16);
      --you: #3fd0b8; --you-soft: rgba(63, 208, 184, 0.16); --danger: #ff6f66; --ok: #4cd67f;
      --shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
    }
  }
  * { box-sizing: border-box; }
  html { height: 100%; }
  body {
    min-height: 100vh; min-height: 100dvh; margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Inter, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; display: flex; align-items: center; justify-content: center;
    padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  }
  .card {
    width: 100%; max-width: 480px; background: var(--card); border-radius: 26px; box-shadow: var(--shadow);
    padding: 30px 24px 20px; display: flex; flex-direction: column; gap: 16px;
  }
  .brand { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; }
  .logo { position: relative; width: 72px; height: 72px; border-radius: 20px; background: #fff var(--logo) center/78% no-repeat; box-shadow: 0 6px 18px rgba(20,24,40,.14), inset 0 0 0 1px rgba(20,24,40,.06); flex: none; }
  .logo .dot { position: absolute; right: -3px; bottom: -3px; width: 16px; height: 16px; border-radius: 50%; background: var(--muted); border: 3px solid var(--card); transition: background .25s; }
  .logo .dot.live { background: var(--ok); } .logo .dot.err { background: var(--danger); }
  h1 { font-size: 21px; font-weight: 700; margin: 0; letter-spacing: -0.015em; }
  .tagline { font-size: 14px; line-height: 1.5; color: var(--muted); margin: 0; max-width: 34ch; }
  .agentline { font-size: 13px; font-weight: 600; color: var(--accent); min-height: 18px; }
  .stage { display: grid; place-items: center; gap: 12px; padding: 6px 0 2px; }
  canvas { width: 240px; height: 96px; display: block; }
  canvas[hidden] { display: none; }
  .state {
    display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600;
    background: var(--accent-soft); color: var(--accent); min-height: 30px; transition: background .2s, color .2s;
  }
  .state.idle { background: var(--line); color: var(--muted); }
  .state.err { background: rgba(214, 69, 65, 0.12); color: var(--danger); }
  .state.you { background: var(--you-soft); color: var(--you); }
  .dots i { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: currentColor; margin-right: 3px; opacity: .35; animation: blink 1.2s infinite; }
  .dots i:nth-child(2) { animation-delay: .2s; } .dots i:nth-child(3) { animation-delay: .4s; }
  .dots[hidden] { display: none; }
  @keyframes blink { 0%, 80%, 100% { opacity: .35; } 40% { opacity: 1; } }
  .status { text-align: center; font-size: 14px; color: var(--muted); min-height: 21px; margin: 0; }
  .status.err { color: var(--danger); }
  .transcript {
    border-top: 1px solid var(--line); padding-top: 14px; display: flex; flex-direction: column; gap: 8px;
    max-height: 240px; overflow-y: auto; scroll-behavior: smooth;
  }
  .transcript:empty { display: none; }
  .b { max-width: 86%; padding: 9px 13px; border-radius: 16px; font-size: 15px; line-height: 1.45; }
  .b.you { align-self: flex-end; background: var(--you-soft); border-bottom-right-radius: 6px; }
  .b.agent { align-self: flex-start; background: var(--accent-soft); border-bottom-left-radius: 6px; }
  .b .n { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 2px; }
  .bar {
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; border-top: 1px solid var(--line); padding-top: 16px;
  }
  .timer { font-variant-numeric: tabular-nums; font-size: 14px; color: var(--muted); justify-self: start; min-width: 48px; }
  button {
    font: inherit; font-weight: 650; border: 0; border-radius: 999px; cursor: pointer;
    transition: transform .08s ease, opacity .15s ease, background .15s ease;
  }
  button:active { transform: scale(.97); }
  button:disabled { opacity: .45; cursor: default; }
  #call { background: var(--accent); color: #fff; padding: 14px 30px; min-width: 150px; font-size: 16px; }
  #call.hang { background: var(--danger); }
  #mute { justify-self: end; background: var(--line); color: var(--ink); padding: 10px 14px; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
  #mute.on { background: rgba(214, 69, 65, 0.12); color: var(--danger); }
  .meter { display: inline-flex; gap: 2px; align-items: flex-end; height: 14px; }
  .meter i { width: 3px; background: currentColor; border-radius: 2px; opacity: .35; height: 30%; transition: height .08s, opacity .08s; }
  .meter i.on { opacity: 1; }
  footer { text-align: center; font-size: 12px; color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { .dots i { animation: none; opacity: 1; } button, .dot, .state { transition: none; } }
</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <div class="logo"><span class="dot" id="dot" aria-hidden="true"></span></div>
    <h1>NanoClaw voice</h1>
    <p class="tagline">Talk to your agent. The voice model answers in real time and hands anything that needs memory or tools to the agent.</p>
    <div class="agentline" id="agentline" aria-live="polite"></div>
  </div>
  <div class="stage">
    <canvas id="viz" aria-hidden="true" hidden></canvas>
    <span class="state idle" id="state" role="status" aria-live="polite"><span class="dots" id="dots" hidden><i></i><i></i><i></i></span><span id="state-text">Ready</span></span>
  </div>
  <p class="status" id="status">Allow the microphone when asked.</p>
  <section class="transcript" id="transcript" aria-label="Live transcript" aria-live="polite"></section>
  <div class="bar">
    <span class="timer" id="timer"></span>
    <button id="call" type="button">Call</button>
    <button id="mute" type="button" disabled aria-pressed="false"><span class="meter" id="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span id="mute-text">Mute</span></button>
  </div>
  <footer id="foot">Voice by GPT-Live-1 &middot; answers by your agent</footer>
  <audio id="remote" autoplay playsinline></audio>
</main>
<script>
(function () {
  var token = new URLSearchParams(location.search).get('t') || '';
  var $ = function (id) { return document.getElementById(id); };
  var callBtn = $('call'), muteBtn = $('mute'), muteText = $('mute-text'), statusEl = $('status'), stateEl = $('state'),
      stateText = $('state-text'), dots = $('dots'), transcript = $('transcript'), remote = $('remote'), canvas = $('viz'),
      agentLine = $('agentline'), foot = $('foot'), dot = $('dot'), timerEl = $('timer'), meterBars = $('meter').children;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var agentName = 'your agent';
  var phase = 'idle';            // idle | connecting | live | ended | error
  var agentState = 'idle';       // idle | connecting | listening | thinking | speaking | ended
  var pc = null, stream = null, actx = null, micAn = null, agentAn = null, dc = null;
  var startedAt = 0, timer = null, muted = false, lastWho = '', lastBubble = null, lastAgentDelta = 0;
  var buf = new Uint8Array(512), agentLvl = 0, youLvl = 0;

  function setStatus(text, err) { statusEl.textContent = text; statusEl.className = 'status' + (err ? ' err' : ''); }
  function setState(s, text) {
    agentState = s;
    var labels = { idle: 'Ready', connecting: 'Connecting', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', ended: 'Call ended', error: 'Something went wrong' };
    stateText.textContent = text || labels[s] || s;
    stateEl.className = 'state' + (s === 'idle' || s === 'ended' ? ' idle' : s === 'error' ? ' err' : s === 'listening' ? ' you' : '');
    dots.hidden = !(s === 'connecting' || s === 'thinking');
  }
  function fmt(sec) { var m = Math.floor(sec / 60), r = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r; }
  function tick() { if (phase === 'live') timerEl.textContent = fmt(Math.floor((Date.now() - startedAt) / 1000)); }
  function errorText(status, body) {
    if (status === 403) return 'This call link is not valid.';
    if (status === 503) return 'The voice line is offline right now.';
    if (status === 502) return 'Could not start the call. ' + body;
    return 'Could not start the call (HTTP ' + status + ').';
  }
  function safe(s) { return String(s).replace(/[<>&]/g, ''); }

  if (token) {
    fetch(new URL('info?t=' + encodeURIComponent(token), location.href)).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.agent) { agentName = safe(j.agent); agentLine.textContent = 'Calling ' + agentName; foot.innerHTML = 'Voice by GPT-Live-1 &middot; answers by ' + agentName; } })
      .catch(function () {});
  } else { setStatus('This link is missing its token. Ask for the full call link.', true); setState('error'); callBtn.disabled = true; }

  // Transcript: one bubble per speaker turn, appended as deltas arrive.
  function caption(who, delta) {
    if (!delta) return;
    if (who !== lastWho || !lastBubble) {
      lastBubble = document.createElement('div'); lastBubble.className = 'b ' + who;
      var n = document.createElement('span'); n.className = 'n'; n.textContent = who === 'you' ? 'You' : agentName;
      lastBubble.appendChild(n); lastBubble.appendChild(document.createTextNode(''));
      transcript.appendChild(lastBubble); lastWho = who;
    }
    lastBubble.lastChild.nodeValue += delta;
    transcript.scrollTop = transcript.scrollHeight;
  }
  function onEvent(raw) {
    var ev; try { ev = JSON.parse(raw); } catch (e) { return; }
    if (ev.type === 'session.input_transcript.delta') { caption('you', ev.delta); if (agentState === 'listening' || agentState === 'speaking') setState('listening'); }
    else if (ev.type === 'session.output_transcript.delta') { caption('agent', ev.delta); lastAgentDelta = Date.now(); if (agentState !== 'thinking' || ev.delta) setState('speaking'); }
    else if (ev.type === 'session.delegation.created') { lastWho = ''; setState('thinking', 'Asking ' + agentName); }
    else if (ev.type === 'session.commentary.appended') { if (agentState === 'thinking') setState('listening'); }
    else if (ev.type === 'session.closed') { end(false, 'The call ended.'); }
  }

  // Visualizer: seven bars for the agent's voice; a small meter for yours in the mute button.
  var g = canvas.getContext('2d'), dpr = Math.min(2, window.devicePixelRatio || 1), BARS = 7, heights = [];
  canvas.width = 240 * dpr; canvas.height = 120 * dpr; g.scale(dpr, dpr);
  for (var b = 0; b < BARS; b++) heights.push(0.06);
  function level(an) { if (!an) return 0; an.getByteTimeDomainData(buf); var s = 0; for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; s += v * v; } return Math.min(1, Math.sqrt(s / buf.length) * 3.2); }
  function draw() {
    var t = performance.now() / 1000;
    var live = phase === 'live';
    agentLvl += ((live ? level(agentAn) : 0) - agentLvl) * 0.3;
    youLvl += ((live && !muted ? level(micAn) : 0) - youLvl) * 0.35;
    if (live && agentLvl > 0.05 && agentState !== 'thinking') { if (agentState !== 'speaking') setState('speaking'); lastAgentDelta = Date.now(); }
    else if (live && agentState === 'speaking' && Date.now() - lastAgentDelta > 900) setState('listening');
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    var accent2 = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim();
    var muted2 = getComputedStyle(document.documentElement).getPropertyValue('--line').trim();
    g.clearRect(0, 0, 240, 120);
    var w = 14, gap = 12, total = BARS * w + (BARS - 1) * gap, x0 = (240 - total) / 2, maxH = 84, minH = 5;
    for (var i = 0; i < BARS; i++) {
      var target;
      if (agentState === 'speaking') target = 0.18 + agentLvl * (0.55 + (reduced ? 0 : 0.45 * Math.abs(Math.sin(t * 7 + i * 1.1))));
      else if (agentState === 'thinking') target = reduced ? 0.3 : 0.24 + 0.22 * Math.sin(t * 3.2 + i * 0.85);
      else if (agentState === 'connecting') target = reduced ? 0.2 : 0.12 + 0.16 * Math.max(0, Math.sin(t * 2.6 - i * 0.55));
      else if (agentState === 'listening') target = reduced ? 0.14 : 0.13 + 0.03 * Math.sin(t * 1.6 + i);
      else target = 0.05;
      heights[i] += (target - heights[i]) * 0.22;
      var hgt = minH + heights[i] * (maxH - minH), x = x0 + i * (w + gap), y = 60 - hgt / 2;
      var grad = g.createLinearGradient(0, y, 0, y + hgt); grad.addColorStop(0, accent2); grad.addColorStop(1, accent);
      g.fillStyle = agentState === 'idle' || agentState === 'ended' || agentState === 'error' ? muted2 : grad;
      g.beginPath(); g.roundRect(x, y, w, hgt, 7); g.fill();
    }
    var lit = Math.round(youLvl * 6);
    for (var k = 0; k < meterBars.length; k++) { meterBars[k].className = k < lit ? 'on' : ''; meterBars[k].style.height = (30 + k * 17) + '%'; }
    requestAnimationFrame(draw);
  }
  draw();

  function waitForIce(pc) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      var done = false; function finish() { if (!done) { done = true; resolve(); } }
      pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') finish(); });
      setTimeout(finish, 1500);
    });
  }

  async function start() {
    phase = 'connecting'; callBtn.disabled = true; transcript.innerHTML = ''; lastWho = ''; lastBubble = null; timerEl.textContent = '';
    setState('connecting'); canvas.hidden = false; setStatus('Requesting the microphone\\u2026');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      actx = new (window.AudioContext || window.webkitAudioContext)();
      micAn = actx.createAnalyser(); micAn.fftSize = 512; actx.createMediaStreamSource(stream).connect(micAn);
      pc = new RTCPeerConnection();
      pc.ontrack = function (e) {
        remote.srcObject = e.streams[0];
        try { agentAn = actx.createAnalyser(); agentAn.fftSize = 512; actx.createMediaStreamSource(e.streams[0]).connect(agentAn); } catch (err) {}
      };
      stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
      dc = pc.createDataChannel('oai-events'); dc.onmessage = function (e) { onEvent(e.data); };
      pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'connected' && phase === 'connecting') {
          phase = 'live'; startedAt = Date.now(); tick(); timer = setInterval(tick, 1000);
          muteBtn.disabled = false; dot.className = 'dot live'; setState('listening'); setStatus('Say hello.');
        } else if (pc.connectionState === 'failed') end(true, 'The connection dropped.');
      };
      var offer = await pc.createOffer(); await pc.setLocalDescription(offer); await waitForIce(pc);
      setStatus('Connecting\\u2026');
      var res = await fetch(new URL('sdp?t=' + encodeURIComponent(token), location.href), { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
      var body = await res.text();
      if (!res.ok) throw new Error(errorText(res.status, body));
      var named = res.headers.get('x-gpt-live-agent'); if (named) { agentName = safe(named); agentLine.textContent = 'Calling ' + agentName; }
      await pc.setRemoteDescription({ type: 'answer', sdp: body });
      callBtn.textContent = 'Hang up'; callBtn.className = 'hang'; callBtn.disabled = false;
    } catch (err) {
      var msg = err && err.name === 'NotAllowedError' ? 'Microphone permission was refused.' : (err && err.message ? err.message : String(err));
      teardown(false); phase = 'error'; setState('error'); setStatus(msg, true); callBtn.disabled = false;
    }
  }
  function teardown(tellHost) {
    if (tellHost && token) fetch(new URL('hangup?t=' + encodeURIComponent(token), location.href), { method: 'POST', keepalive: true }).catch(function () {});
    if (timer) { clearInterval(timer); timer = null; }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (actx) { try { actx.close(); } catch (e) {} actx = null; }
    micAn = null; agentAn = null; remote.srcObject = null; muted = false; dot.className = 'dot';
    muteBtn.disabled = true; muteBtn.className = ''; muteText.textContent = 'Mute'; muteBtn.setAttribute('aria-pressed', 'false');
    callBtn.textContent = 'Call'; callBtn.className = ''; canvas.hidden = true;
  }
  function end(tellHost, text) {
    if (phase === 'idle' || phase === 'ended') return;
    teardown(tellHost); phase = 'ended'; setState('ended'); setStatus(text || 'Call ended.'); callBtn.disabled = false;
  }

  callBtn.addEventListener('click', function () { if (phase === 'live' || phase === 'connecting') end(true, 'Call ended.'); else start(); });
  muteBtn.addEventListener('click', function () {
    if (!stream) return; muted = !muted; stream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
    muteBtn.className = muted ? 'on' : ''; muteText.textContent = muted ? 'Unmute' : 'Mute'; muteBtn.setAttribute('aria-pressed', String(muted));
  });
  window.addEventListener('pagehide', function () { if (pc) teardown(true); });
})();
</script>
</body>
</html>
`;
}
