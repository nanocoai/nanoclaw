/** Browser-side conversation state and API client for the local-web page. */

/* global sessionStorage */

const selectedKey = 'nanoclaw-local-web-selected-conversation';
const transcriptPrefix = 'nanoclaw-local-web-history:';
const maxVisibleItems = 100;

function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; live chat still works for this page load.
  }
}

function validConversation(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.conversationId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.provider === 'string'
  );
}

function parseCatalog(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.conversations)) {
    throw new Error('The conversation list is unavailable.');
  }
  const conversations = value.conversations.filter(validConversation);
  const installedProviders = Array.isArray(value.installedProviders)
    ? value.installedProviders.filter((provider) => typeof provider === 'string')
    : [];
  if (conversations.length === 0) throw new Error('No local agents are available.');
  return {
    conversations,
    installedProviders,
    installationDefault: typeof value.installationDefault === 'string' ? value.installationDefault : 'claude',
    isInstallationDefaultInstalled: value.isInstallationDefaultInstalled === true,
  };
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status})`);
  }
  return body;
}

export function createConversationController({ token, tokenHeader, onCatalog, onSelected, onEvent, onConnection }) {
  let catalog = null;
  let selected = null;
  let streamAbort = null;

  function headers(extra = {}) {
    return { ...extra, [tokenHeader]: token };
  }

  function transcriptKey(conversationId) {
    return `${transcriptPrefix}${conversationId}`;
  }

  function loadTranscript(conversationId) {
    try {
      const parsed = JSON.parse(readSession(transcriptKey(conversationId)) || '[]');
      return Array.isArray(parsed) ? parsed.slice(-maxVisibleItems) : [];
    } catch {
      return [];
    }
  }

  function saveTranscript(items) {
    if (!selected) return;
    writeSession(transcriptKey(selected.conversationId), JSON.stringify(items.slice(-maxVisibleItems)));
  }

  async function loadCatalog() {
    const response = await fetch('/api/conversations', { headers: headers() });
    catalog = parseCatalog(await responseJson(response));
    onCatalog(catalog);
    return catalog;
  }

  async function stream(conversationId, signal) {
    let retryDelay = 1_000;
    for (;;) {
      if (signal.aborted) return;
      try {
        const response = await fetch(`/events?conversationId=${encodeURIComponent(conversationId)}`, {
          headers: headers(),
          signal,
        });
        if (response.status === 401) {
          onConnection('unauthorized');
          return;
        }
        if (!response.ok || !response.body) throw new Error(`Stream failed (${response.status})`);
        onConnection('ready');
        retryDelay = 1_000;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (!frame.startsWith('data: ')) continue;
            try {
              onEvent(JSON.parse(frame.slice(6)));
            } catch {
              // One malformed event never stops the selected conversation.
            }
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      onConnection('reconnecting');
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }

  async function select(conversationId) {
    const next = catalog?.conversations.find((conversation) => conversation.conversationId === conversationId);
    if (!next) throw new Error('Conversation not found.');
    streamAbort?.abort();
    selected = next;
    writeSession(selectedKey, conversationId);
    onSelected(next, loadTranscript(conversationId));
    streamAbort = new AbortController();
    void stream(conversationId, streamAbort.signal);
  }

  async function initialize() {
    const loaded = await loadCatalog();
    const stored = readSession(selectedKey);
    const initial =
      loaded.conversations.find((conversation) => conversation.conversationId === stored) ??
      loaded.conversations.find((conversation) => conversation.isLegacy) ??
      loaded.conversations[0];
    await select(initial.conversationId);
  }

  async function createAgent(input) {
    const body = { name: input.name, ...(selected && { sourceConversationId: selected.conversationId }) };
    if (input.provider) body.provider = input.provider;
    if (Object.hasOwn(input, 'model')) body.model = input.model;
    if (Object.hasOwn(input, 'effort')) body.effort = input.effort;
    const response = await fetch('/api/agents', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const result = await responseJson(response);
    const createdId = result?.conversation?.conversationId;
    if (typeof createdId !== 'string') throw new Error('Agent was created without a conversation. Retry to resume.');
    await loadCatalog();
    await select(createdId);
    return result;
  }

  function dispose() {
    streamAbort?.abort();
  }

  return {
    initialize,
    select,
    createAgent,
    saveTranscript,
    dispose,
    get catalog() {
      return catalog;
    },
    get selected() {
      return selected;
    },
  };
}
