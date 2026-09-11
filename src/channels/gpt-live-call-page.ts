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
    padding: 26px 22px 20px; display: flex; flex-direction: column; gap: 16px;
  }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .who h1 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.015em; }
  .who .line { font-size: 13px; color: var(--muted); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--line); flex: none; box-shadow: 0 0 0 4px transparent; transition: background .25s, box-shadow .25s; }
  .dot.live { background: var(--ok); box-shadow: 0 0 0 4px rgba(34, 163, 90, 0.18); }
  .dot.err { background: var(--danger); }
  .stage { display: grid; place-items: center; gap: 12px; padding: 6px 0 2px; }
  canvas { width: 240px; height: 120px; display: block; }
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
  <header>
    <div class="who"><h1 id="title">Call your agent</h1><div class="line">Voice line &middot; NanoClaw</div></div>
    <span class="dot" id="dot" aria-hidden="true"></span>
  </header>
  <div class="stage">
    <canvas id="viz" aria-hidden="true"></canvas>
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
      title = $('title'), foot = $('foot'), dot = $('dot'), timerEl = $('timer'), meterBars = $('meter').children;
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
      .then(function (j) { if (j && j.agent) { agentName = safe(j.agent); title.textContent = 'Call ' + agentName; foot.innerHTML = 'Voice by GPT-Live-1 &middot; answers by ' + agentName; } })
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
  for (var b = 0; b < BARS; b++) heights.push(0.12);
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
    var w = 14, gap = 12, total = BARS * w + (BARS - 1) * gap, x0 = (240 - total) / 2, maxH = 104, minH = 12;
    for (var i = 0; i < BARS; i++) {
      var target;
      if (agentState === 'speaking') target = 0.18 + agentLvl * (0.55 + (reduced ? 0 : 0.45 * Math.abs(Math.sin(t * 7 + i * 1.1))));
      else if (agentState === 'thinking') target = reduced ? 0.3 : 0.24 + 0.22 * Math.sin(t * 3.2 + i * 0.85);
      else if (agentState === 'connecting') target = reduced ? 0.2 : 0.12 + 0.16 * Math.max(0, Math.sin(t * 2.6 - i * 0.55));
      else if (agentState === 'listening') target = reduced ? 0.14 : 0.13 + 0.03 * Math.sin(t * 1.6 + i);
      else target = 0.12;
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
    setState('connecting'); setStatus('Requesting the microphone\\u2026');
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
      var named = res.headers.get('x-gpt-live-agent'); if (named) { agentName = safe(named); title.textContent = 'Call ' + agentName; }
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
    callBtn.textContent = 'Call'; callBtn.className = '';
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
