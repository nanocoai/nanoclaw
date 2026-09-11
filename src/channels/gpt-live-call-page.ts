/**
 * The browser call page for the gpt-live channel, served by the adapter at
 * `/webhook/gpt-live/call?t=<link token>`.
 *
 * Plain WebRTC, no framework: capture the microphone, create an offer, post
 * it to the adapter's `sdp` route (same directory, so the link token in the
 * query string travels with it), apply the answer, play the remote track.
 * A data channel is opened as well: when the Live API mirrors events onto
 * it, the page shows live captions; when it doesn't, nothing breaks.
 *
 * Static HTML in a string so the skill ships one file and the page can't
 * drift from the routes it talks to.
 */
export function callPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NanoClaw voice</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f7f9; color: #1c1c1e; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } .card { background: #1b1b1d !important; } .log { background: #161618 !important; } }
  main { max-width: 560px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { opacity: .7; margin: 0 0 20px; }
  .card { background: #fff; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 999px; padding: 12px 22px; cursor: pointer; margin-right: 8px; }
  #call { background: #0b5fff; color: #fff; }
  #hangup { background: #b42318; color: #fff; }
  button:disabled { opacity: .45; cursor: default; }
  #status { margin: 14px 0 0; min-height: 24px; }
  .log { margin-top: 16px; padding: 12px; border-radius: 8px; background: #f0f1f3; font-size: 14px; max-height: 320px; overflow: auto; white-space: pre-wrap; }
  .log:empty { display: none; }
  .caller { color: #0b5fff; } .assistant { color: #1a7f37; } .err { color: #b42318; }
</style>
</head>
<body>
<main>
  <h1>NanoClaw voice</h1>
  <p class="sub">Talk to your agent. The voice model answers in real time and hands anything that needs memory or tools to the agent.</p>
  <div class="card">
    <button id="call" type="button">Call</button>
    <button id="hangup" type="button" disabled>Hang up</button>
    <p id="status">Ready. Allow the microphone when asked.</p>
    <div id="log" class="log" aria-live="polite"></div>
    <audio id="remote" autoplay playsinline></audio>
  </div>
</main>
<script>
(function () {
  var token = new URLSearchParams(location.search).get('t') || '';
  var callBtn = document.getElementById('call');
  var hangBtn = document.getElementById('hangup');
  var statusEl = document.getElementById('status');
  var logEl = document.getElementById('log');
  var remote = document.getElementById('remote');
  var pc = null, stream = null, lines = {};

  function status(text, isError) { statusEl.textContent = text; statusEl.className = isError ? 'err' : ''; }
  function caption(who, delta) {
    var el = lines[who];
    if (!el) { el = document.createElement('div'); el.className = who; el.textContent = (who === 'caller' ? 'You: ' : 'Agent: '); logEl.appendChild(el); lines[who] = el; lines[who === 'caller' ? 'assistant' : 'caller'] = null; }
    el.textContent += delta; logEl.scrollTop = logEl.scrollHeight;
  }
  function onEvent(raw) {
    var ev; try { ev = JSON.parse(raw); } catch (e) { return; }
    if (ev.type === 'session.input_transcript.delta') caption('caller', ev.delta || '');
    else if (ev.type === 'session.output_transcript.delta') caption('assistant', ev.delta || '');
    else if (ev.type === 'session.delegation.created') { var d = document.createElement('div'); d.textContent = '\\u2026 asking the agent'; d.style.opacity = '.6'; logEl.appendChild(d); lines = {}; }
  }
  function waitForIce(pc) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      var done = false; function finish() { if (!done) { done = true; resolve(); } }
      pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') finish(); });
      setTimeout(finish, 1500);
    });
  }
  async function call() {
    if (!token) { status('This link is missing its token. Ask for the full call link.', true); return; }
    callBtn.disabled = true;
    try {
      status('Requesting microphone\\u2026');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc = new RTCPeerConnection();
      pc.ontrack = function (e) { remote.srcObject = e.streams[0]; };
      stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
      var dc = pc.createDataChannel('oai-events');
      dc.onmessage = function (e) { onEvent(e.data); };
      pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'connected') status('On the call. Speak normally.');
        else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') { status('Connection lost.', true); hangup(false); }
      };
      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);
      status('Connecting\\u2026');
      var res = await fetch(new URL('sdp?t=' + encodeURIComponent(token), location.href), {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp
      });
      if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
      var answer = await res.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      hangBtn.disabled = false;
      status('Connected (session ' + (res.headers.get('x-gpt-live-session') || 'unknown') + '). Say hello.');
    } catch (err) {
      status('Could not start the call: ' + (err && err.message ? err.message : err), true);
      hangup(false);
    }
  }
  function hangup(tellHost) {
    if (tellHost !== false && token) {
      fetch(new URL('hangup?t=' + encodeURIComponent(token), location.href), { method: 'POST' }).catch(function () {});
    }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    remote.srcObject = null;
    callBtn.disabled = false; hangBtn.disabled = true;
    if (tellHost !== false) status('Call ended.');
  }
  callBtn.addEventListener('click', function () { call(); });
  hangBtn.addEventListener('click', function () { hangup(true); });
  window.addEventListener('pagehide', function () { if (pc) hangup(true); });
})();
</script>
</body>
</html>
`;
}
