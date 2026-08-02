(() => {
  const $ = (selector) => document.querySelector(selector);
  const messages = $('#messages');
  const participant = $('#participant');
  const input = $('#message');
  const attachments = $('#attachments');
  let replyToId;
  let lastPayload;
  let events;

  const participantName = (id) => ({ 'playbox:alice': 'Alice', 'playbox:bob': 'Bob', 'playbox:guest': 'Guest' })[id] || id;
  const messageId = (prefix = 'playbox') => `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  function setConnection(online, label) {
    $('#connection-dot').classList.toggle('online', online);
    $('#connection-label').textContent = label;
  }

  function bubble({ id, senderName, text, files = [], agent = false, state = 'sent' }) {
    $('#empty-state')?.remove();
    const node = document.createElement('article');
    node.className = `bubble${agent ? ' agent' : ''}`;
    node.dataset.id = id;
    const head = document.createElement('div');
    head.className = 'bubble-head';
    head.innerHTML = `<strong></strong><code></code>`;
    head.querySelector('strong').textContent = senderName;
    head.querySelector('code').textContent = id;
    const body = document.createElement('p');
    body.textContent = text || '(attachment)';
    const fileRow = document.createElement('div');
    for (const file of files) {
      const chip = document.createElement('span');
      chip.className = 'attachment-chip';
      chip.textContent = file.name;
      fileRow.append(chip);
    }
    const foot = document.createElement('div');
    foot.className = 'bubble-foot';
    foot.innerHTML = `<span></span><button type="button">Reply</button>`;
    foot.querySelector('span').textContent = state;
    foot.querySelector('button').addEventListener('click', () => setReply(id));
    node.append(head, body, fileRow, foot);
    messages.append(node);
    messages.scrollTop = messages.scrollHeight;
  }

  function setReply(id) {
    replyToId = id;
    $('#reply-id').textContent = id;
    $('#reply-banner').hidden = false;
    input.focus();
  }

  async function filePayload(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { name: file.name, type: file.type, dataBase64: btoa(binary) };
  }

  async function fixture(path, name, type) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Fixture unavailable: ${path}`);
    return filePayload(new File([await response.blob()], name, { type }));
  }

  async function send(overrides = {}) {
    const senderId = overrides.senderId || participant.value;
    const payload = {
      id: overrides.id || messageId('in'),
      senderId,
      senderName: participantName(senderId),
      text: overrides.text ?? input.value,
      timestamp: overrides.timestamp || new Date().toISOString(),
      attachments: overrides.attachments || await Promise.all([...attachments.files].map(filePayload)),
      ...(overrides.replyToId || replyToId ? { replyToId: overrides.replyToId || replyToId } : {}),
    };
    bubble({ ...payload, files: payload.attachments, state: 'sending' });
    const response = await fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const node = messages.querySelector(`[data-id="${CSS.escape(payload.id)}"]`);
    node?.querySelector('.bubble-foot span')?.replaceChildren(response.ok ? 'accepted' : `rejected ${response.status}`);
    $('#last-inbound').textContent = payload.id;
    lastPayload = payload;
    $('#resend').disabled = false;
    input.value = '';
    attachments.value = '';
    clearReply();
    return { payload, response };
  }

  function clearReply() {
    replyToId = undefined;
    $('#reply-banner').hidden = true;
  }

  function connect() {
    events?.close();
    setConnection(false, 'Connecting');
    events = new EventSource('/events');
    events.onopen = () => setConnection(true, 'Loopback connected');
    events.onerror = () => setConnection(false, 'Reconnecting');
    events.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.type === 'typing') $('#typing').hidden = !event.active;
      if (event.type === 'delivery') {
        const node = messages.querySelector(`[data-id="${CSS.escape(event.inboundId)}"]`);
        node?.querySelector('.bubble-foot span')?.replaceChildren(event.state);
      }
      if (event.type === 'outbound') {
        $('#typing').hidden = true;
        $('#last-outbound').textContent = event.id;
        bubble({ id: event.id, senderName: 'Expense agent', text: event.text, files: event.files, agent: true, state: 'delivered' });
      }
    };
  }

  async function scenario(name) {
    if (name === 'clear-image') await send({ text: '', attachments: [await fixture('/fixtures/receipt-coffee.png', 'receipt-coffee.png', 'image/png')] });
    if (name === 'incomplete-text') await send({ text: 'expense: taxi today' });
    if (name === 'two-receipt-batch') await send({ text: 'Two household receipts', attachments: [
      await fixture('/fixtures/receipt-coffee.png', 'receipt-coffee.png', 'image/png'),
      await fixture('/fixtures/receipt-grocery.pdf', 'receipt-grocery.pdf', 'application/pdf'),
    ] });
    if (name === 'duplicate') {
      if (!lastPayload) await send({ text: 'expense: tram 13 today' });
      await send(lastPayload);
    }
    if (name === 'out-of-order') {
      const first = await send({ text: 'expense: lunch 72', timestamp: new Date(Date.now() + 1000).toISOString() });
      await send({ text: 'total is 72', replyToId: first.payload.id, timestamp: new Date().toISOString() });
    }
    if (name === 'simultaneous') await Promise.all([
      send({ senderId: 'playbox:alice', text: 'expense: coffee 35' }),
      send({ senderId: 'playbox:bob', text: 'expense: ferry 28' }),
    ]);
    if (name === 'reconnect') {
      events?.close();
      setConnection(false, 'Forced reconnect');
      await send({ text: 'expense: market 118' });
      setTimeout(connect, 300);
    }
  }

  $('#composer').addEventListener('submit', (event) => { event.preventDefault(); void send().catch(showError); });
  $('#clear-reply').addEventListener('click', clearReply);
  $('#resend').addEventListener('click', () => { if (lastPayload) void send(lastPayload).catch(showError); });
  $('#scenarios').addEventListener('click', (event) => {
    const name = event.target.closest('button')?.dataset.scenario;
    if (name) void scenario(name).catch(showError);
  });
  document.querySelector('.fault-grid').addEventListener('click', (event) => {
    const kind = event.target.closest('button')?.dataset.fault;
    if (kind) void fetch('/api/faults', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, count: 1 }) }).catch(showError);
  });
  $('#reset').addEventListener('click', async () => {
    await fetch('/api/reset', { method: 'POST' });
    messages.replaceChildren();
    location.reload();
  });

  function showError(error) {
    bubble({ id: messageId('ui-error'), senderName: 'Playbox', text: error.message, agent: true, state: 'local error' });
  }

  connect();
})();
