/**
 * Browser asset for the local-web chat page. Served to the browser at
 * /local-web-page.js; never imported by the host process.
 */
import { createConversationController } from './local-web-conversation-ui.js';

/* global document, history, location, localStorage, matchMedia, window */
/* eslint-disable no-catch-all/no-catch-all -- every catch here degrades the page
   instead of failing it: storage denied, a torn frame, an aborted stream. */

(() => {
  const tokenKey = 'nanoclaw-local-web-token';
  const themeKey = 'nanoclaw-local-web-theme';
  const tokenHeader = 'x-nanoclaw-local-web-token';
  const maxVisibleItems = 100;
  const maxLength = 8000;
  const counterThreshold = 400;
  const stickyBottomPx = 96;
  const activityIdleMs = 10_000;

  const root = document.documentElement;
  const messages = document.querySelector('#messages');
  const form = document.querySelector('#composer');
  const input = document.querySelector('#message');
  const send = document.querySelector('#send');
  const status = document.querySelector('#status');
  const statusLabel = status.querySelector('span');
  const themeButton = document.querySelector('#theme');
  const jump = document.querySelector('#jump');
  const counter = document.querySelector('#counter');
  const shell = document.querySelector('.shell');
  const header = document.querySelector('header');
  const dock = document.querySelector('.dock');
  const activity = document.querySelector('#activity');
  const activityLabel = document.querySelector('#activity-label');
  const appShell = document.querySelector('.app-shell');
  const agentSidebar = document.querySelector('#agent-sidebar');
  const agentList = document.querySelector('#agent-list');
  const agentTitle = document.querySelector('#agent-title');
  const agentRuntime = document.querySelector('#agent-runtime');
  const agentsToggle = document.querySelector('#agents-toggle');
  const sidebarScrim = document.querySelector('#sidebar-scrim');
  const createAgentButton = document.querySelector('#create-agent');
  const createDialog = document.querySelector('#create-agent-dialog');
  const createForm = document.querySelector('#create-agent-form');
  const closeCreateAgent = document.querySelector('#close-create-agent');
  const cancelCreateAgent = document.querySelector('#cancel-create-agent');
  const submitCreateAgent = document.querySelector('#submit-create-agent');
  const createError = document.querySelector('#create-agent-error');
  const agentName = document.querySelector('#agent-name');
  const inheritAgent = document.querySelector('#inherit-agent');
  const inheritRuntime = document.querySelector('#inherit-runtime');
  const providerField = document.querySelector('#provider-field');
  const providerSelect = document.querySelector('#agent-provider');
  const singleProvider = document.querySelector('#single-provider');
  const modelInput = document.querySelector('#agent-model');
  const effortSelect = document.querySelector('#agent-effort');
  const advancedOptions = document.querySelector('#advanced-options');
  const mobileSidebar = window.matchMedia('(max-width: 780px)');
  let activityTimer = null;
  let conversationController = null;
  let providerWasChanged = false;

  // ---- theme ------------------------------------------------------------
  // No stored choice means follow the OS; the button writes an explicit one.
  try {
    const stored = localStorage.getItem(themeKey);
    if (stored === 'light' || stored === 'dark') root.dataset.theme = stored;
  } catch {
    // a browser with site data blocked simply follows the OS every load
  }
  function prefersDark() {
    return root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function syncThemeLabel() {
    const next = prefersDark() ? 'light' : 'dark';
    themeButton.setAttribute('aria-label', `Switch to ${next} theme`);
    themeButton.setAttribute('title', `Switch to ${next} theme`);
  }
  themeButton.addEventListener('click', () => {
    const next = prefersDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem(themeKey, next);
    } catch {
      // the choice still applies to this page load
    }
    syncThemeLabel();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeLabel);
  syncThemeLabel();

  // ---- token ------------------------------------------------------------
  // The launcher hands the token over in the fragment, which never reaches
  // the server. Strip it immediately: the address bar is the one place it
  // could leave this machine, since browsers sync history and bookmarks.
  let token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (token) {
    try {
      localStorage.setItem(tokenKey, token);
    } catch {
      // a browser with site data blocked keeps the token for this page load only
    }
    history.replaceState(null, '', location.pathname);
  } else {
    try {
      token = localStorage.getItem(tokenKey);
    } catch {
      // no stored token reads the same as never having had one
    }
  }

  // ---- transcript -------------------------------------------------------
  let transcript = [];
  function trimConversation() {
    if (transcript.length > maxVisibleItems) transcript.splice(0, transcript.length - maxVisibleItems);
    while (messages.children.length > maxVisibleItems) messages.firstElementChild?.remove();
  }
  function persist() {
    trimConversation();
    conversationController?.saveTranscript(transcript);
  }

  // ---- scroll -----------------------------------------------------------
  // Only follow new content when the reader is already at the bottom.
  // Yanking someone out of scrollback to show a message they can see the
  // arrival of is the single most irritating thing a chat log can do.
  function isAtBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < stickyBottomPx;
  }
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // 'instant', never 'auto': 'auto' defers to CSS scroll-behavior, and an
  // animated follow leaves isAtBottom() reading false while it runs, so a burst
  // of appends would stop following after the first one. A scrollTo behavior
  // also outranks the stylesheet, so reduced motion has to be checked here.
  function scrollToLatest(smooth = false) {
    const animate = smooth && !reducedMotion.matches;
    messages.scrollTo({ top: messages.scrollHeight, behavior: animate ? 'smooth' : 'instant' });
    jump.hidden = true;
  }
  function settleScroll(wasAtBottom) {
    if (wasAtBottom) scrollToLatest();
    else jump.hidden = false;
  }
  messages.addEventListener('scroll', () => {
    if (isAtBottom()) jump.hidden = true;
  });
  jump.addEventListener('click', () => {
    scrollToLatest(true);
    input.focus();
  });

  // The transcript scrolls the full height of the window, under chrome that
  // floats on top of it, so its padding has to track the real chrome heights:
  // the composer alone grows from 46px to 200px as you type. Called from the
  // two things that change those heights rather than from a ResizeObserver,
  // which only delivers while the tab is actually rendering.
  function syncChrome() {
    const pinned = isAtBottom();
    shell.style.setProperty('--header-h', `${header.offsetHeight}px`);
    shell.style.setProperty('--dock-h', `${dock.offsetHeight}px`);
    if (pinned) scrollToLatest();
  }
  window.addEventListener('resize', syncChrome);

  // ---- rendering --------------------------------------------------------
  function labelFor(role) {
    if (role === 'user') return 'You';
    return role === 'agent' ? 'NanoClaw' : '';
  }
  /** Copy buttons and horizontal table scrollers over server-rendered Markdown. */
  function enhanceMarkdown(node) {
    for (const table of node.querySelectorAll('table')) {
      const wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      table.replaceWith(wrap);
      wrap.append(table);
    }
    for (const pre of node.querySelectorAll('pre')) {
      const source = (pre.querySelector('code') || pre).textContent;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy';
      button.textContent = 'Copy';
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(source);
          button.textContent = 'Copied';
        } catch {
          button.textContent = 'Copy failed';
        }
        setTimeout(() => (button.textContent = 'Copy'), 1600);
      });
      pre.append(button);
    }
  }
  function addMessage(role, text, save = true, html = null) {
    const wasAtBottom = isAtBottom();
    if (role !== 'system') clearEmptyState();

    const turn = document.createElement('div');
    turn.className = `turn ${role}${save ? ' enter' : ''}`;

    const label = labelFor(role);
    if (label) {
      const roleTag = document.createElement('p');
      roleTag.className = 'role';
      roleTag.textContent = label;
      turn.append(roleTag);
    }

    const node = document.createElement('div');
    node.className = `message ${role}`;
    // Agent HTML is produced by the server's raw-HTML-disabled Markdown renderer.
    if (role === 'agent' && typeof html === 'string') {
      node.innerHTML = html;
      enhanceMarkdown(node);
    } else {
      node.textContent = text;
    }
    turn.append(node);
    messages.append(turn);

    if (save) {
      transcript.push({ role, text, ...(typeof html === 'string' && { html }) });
      persist();
    }
    settleScroll(wasAtBottom || !save);
  }
  function addQuestion(card, save = true) {
    const wasAtBottom = isAtBottom();
    clearEmptyState();
    const node = document.createElement('article');
    node.className = `question-card${save ? ' enter' : ''}`;
    node.dataset.questionId = card.questionId;

    const kicker = document.createElement('p');
    kicker.className = 'question-kicker';
    kicker.textContent = 'Action required';
    node.append(kicker);

    const title = document.createElement('h2');
    title.className = 'question-title';
    title.textContent = card.title;
    node.append(title);

    if (card.question) {
      const body = document.createElement('p');
      body.className = 'question-body';
      body.textContent = card.question;
      node.append(body);
    }

    const actions = document.createElement('div');
    actions.className = 'question-actions';
    const buttons = card.options.map((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `question-option ${option.style || ''}`;
      button.textContent = option.label;
      button.disabled = Boolean(card.resolution);
      button.addEventListener('click', async () => {
        buttons.forEach((item) => (item.disabled = true));
        try {
          const response = await fetch('/api/actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', [tokenHeader]: token },
            body: JSON.stringify({
              conversationId: conversationController?.selected?.conversationId,
              questionId: card.questionId,
              option: index,
            }),
          });
          if (!response.ok) {
            const responseBody = await response.json().catch(() => ({}));
            throw new Error(responseBody.error || `Action failed (${response.status})`);
          }
          resolveQuestion(card.questionId, option.selectedLabel || option.label);
          setState('Ready', 'ready');
        } catch (error) {
          resolution.textContent = error instanceof Error ? error.message : 'Action could not be sent.';
          resolution.hidden = false;
          resolution.classList.add('question-error');
          buttons.forEach((item) => (item.disabled = false));
        }
      });
      actions.append(button);
      return button;
    });
    node.append(actions);

    const resolution = document.createElement('p');
    resolution.className = 'question-resolution';
    resolution.textContent = card.resolution || '';
    resolution.hidden = !card.resolution;
    node.append(resolution);

    messages.append(node);
    if (save) {
      transcript.push(card);
      persist();
    }
    settleScroll(wasAtBottom || !save);
  }
  function resolveQuestion(questionId, value) {
    const card = transcript.find((item) => item.type === 'question' && item.questionId === questionId);
    if (card) card.resolution = value;
    const node = [...messages.querySelectorAll('.question-card')].find(
      (item) => item.dataset.questionId === questionId,
    );
    if (!node) return;
    node.querySelectorAll('.question-option').forEach((button) => (button.disabled = true));
    const resolution = node.querySelector('.question-resolution');
    resolution.textContent = value;
    resolution.hidden = false;
    resolution.classList.remove('question-error');
    persist();
  }

  // Header status is connection state; turn activity lives in the pill.
  function setState(label, state) {
    statusLabel.textContent = label;
    status.dataset.state = state;
  }
  function setActivity(label, isTool = false) {
    clearTimeout(activityTimer);
    activityTimer = null;
    activity.hidden = !label;
    activity.classList.toggle('tool', isTool);
    activity.classList.remove('stalled');
    if (!label) return;
    activityLabel.textContent = label;
    // The backend stops emitting thinking/tool events roughly 15s into a turn
    // while the turn itself runs on. Hiding the pill there reads as "finished",
    // so it degrades to the only thing the page still honestly knows.
    activityTimer = setTimeout(() => {
      activityLabel.textContent = 'Still working';
      activity.classList.add('stalled');
      activity.classList.remove('tool');
    }, activityIdleMs);
  }
  /** The full-height state the log shows when it holds no conversation. */
  function renderEmptyState({ heading, body, note, locked = false }) {
    clearEmptyState();
    const node = document.createElement('div');
    node.className = `empty${locked ? ' locked' : ''}`;

    const mark = document.createElement('div');
    mark.className = 'empty-mark';
    mark.setAttribute('aria-hidden', 'true');
    node.append(mark);

    const title = document.createElement('h2');
    title.textContent = heading;
    node.append(title);

    const text = document.createElement('p');
    text.textContent = body;
    node.append(text);

    if (note) {
      const code = document.createElement('code');
      code.textContent = note;
      node.append(code);
    }
    messages.append(node);
  }
  function showEmptyState() {
    if (messages.querySelector('.empty')) return;
    renderEmptyState({
      heading: 'Nothing here yet',
      body: 'This page is local to this machine. Your agent may use configured models, tools, and connected services.',
    });
  }
  function clearEmptyState() {
    messages.querySelector('.empty')?.remove();
  }
  function renderTranscript(items) {
    messages.replaceChildren();
    transcript = items.slice(-maxVisibleItems);
    for (const item of transcript) {
      if (item.type === 'question') addQuestion(item, false);
      else addMessage(item.role === 'user' ? 'user' : 'agent', item.text, false, item.html);
    }
    if (transcript.length === 0) showEmptyState();
    else scrollToLatest();
    syncChrome();
  }

  function showNotAuthorized() {
    send.disabled = true;
    input.disabled = true;
    setActivity(null);
    setState('Not connected', 'down');
    // This screen is the recovery path when a browser opened the bare address,
    // so it has to name the token rather than any one installer's command.
    renderEmptyState({
      heading: 'This browser has no access token',
      body: 'Run this command in the NanoClaw folder, then open the authenticated link it prints:',
      note: 'pnpm local-web',
      locked: true,
    });
  }

  function handleEvent(data) {
    try {
      if (data.type === 'ready') {
        setState('Ready', 'ready');
        setActivity(null);
        send.disabled = false;
      }
      if (data.type === 'thinking') {
        setState('Working', 'busy');
        setActivity('Thinking…');
      }
      if (data.type === 'tool' && typeof data.name === 'string') {
        setState('Working', 'busy');
        setActivity(`Using ${data.name}`, true);
      }
      if (data.type === 'reply' && typeof data.text === 'string') {
        clearEmptyState();
        addMessage('agent', data.text, true, typeof data.html === 'string' ? data.html : null);
        send.disabled = false;
        input.focus();
        setState('Ready', 'ready');
        setActivity(null);
      }
      if (
        data.type === 'question' &&
        typeof data.questionId === 'string' &&
        typeof data.title === 'string' &&
        Array.isArray(data.options)
      ) {
        clearEmptyState();
        addQuestion({
          type: 'question',
          questionId: data.questionId,
          title: data.title,
          question: typeof data.question === 'string' ? data.question : '',
          options: data.options.filter(
            (option) => option && typeof option.label === 'string' && typeof option.selectedLabel === 'string',
          ),
        });
        send.disabled = false;
        setState('Action required', 'attention');
        setActivity(null);
      }
      if (
        data.type === 'question-resolution' &&
        typeof data.questionId === 'string' &&
        typeof data.resolution === 'string'
      ) {
        resolveQuestion(data.questionId, data.resolution);
        setState('Ready', 'ready');
      }
    } catch {
      // same: one bad frame never stops the page
    }
  }

  // ---- conversations ---------------------------------------------------
  function runtimeLabel(conversation) {
    const details = [conversation.provider];
    if (conversation.model) details.push(conversation.model);
    if (conversation.effort) details.push(conversation.effort);
    return details.join(' · ');
  }

  function initials(name) {
    return (
      name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase())
        .join('') || 'A'
    );
  }

  function setSidebarOpen(open, { focusDrawer = false, restoreFocus = false } = {}) {
    const drawerOpen = mobileSidebar.matches && open;
    const drawerIsClosed = mobileSidebar.matches && !drawerOpen;
    appShell.classList.toggle('sidebar-open', drawerOpen);
    agentsToggle.setAttribute('aria-expanded', String(drawerOpen));
    if (drawerIsClosed && (restoreFocus || agentSidebar.contains(document.activeElement))) agentsToggle.focus();
    agentSidebar.inert = drawerIsClosed;
    if (drawerIsClosed) agentSidebar.setAttribute('aria-hidden', 'true');
    else agentSidebar.removeAttribute('aria-hidden');
    sidebarScrim.hidden = !drawerOpen;
    if (drawerOpen && focusDrawer) createAgentButton.focus();
  }

  agentsToggle.addEventListener('click', () => {
    const open = !appShell.classList.contains('sidebar-open');
    setSidebarOpen(open, { focusDrawer: open });
  });
  sidebarScrim.addEventListener('click', () => setSidebarOpen(false, { restoreFocus: true }));
  mobileSidebar.addEventListener('change', () => setSidebarOpen(false));
  setSidebarOpen(false);
  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      mobileSidebar.matches &&
      appShell.classList.contains('sidebar-open') &&
      !createDialog.open
    ) {
      event.preventDefault();
      setSidebarOpen(false, { restoreFocus: true });
    }
  });

  function renderCatalog(catalog) {
    agentList.replaceChildren();
    for (const conversation of catalog.conversations) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'agent-row';
      button.dataset.conversationId = conversation.conversationId;
      button.setAttribute(
        'aria-current',
        String(conversationController?.selected?.conversationId === conversation.conversationId),
      );

      const avatar = document.createElement('span');
      avatar.className = 'agent-avatar';
      avatar.textContent = initials(conversation.agentName);
      button.append(avatar);

      const copy = document.createElement('span');
      copy.className = 'agent-row-copy';
      const name = document.createElement('span');
      name.className = 'agent-row-name';
      name.textContent = conversation.agentName;
      const runtime = document.createElement('span');
      runtime.className = 'agent-row-runtime';
      runtime.textContent = runtimeLabel(conversation);
      copy.append(name, runtime);
      button.append(copy);

      const state = document.createElement('span');
      state.className = 'agent-row-state';
      state.setAttribute('aria-hidden', 'true');
      button.append(state);
      button.addEventListener('click', async () => {
        try {
          await conversationController.select(conversation.conversationId);
          setSidebarOpen(false);
          input.focus();
        } catch (error) {
          addMessage('system', error instanceof Error ? error.message : 'Conversation could not be selected.', false);
        }
      });
      agentList.append(button);
    }
  }

  function selectConversation(conversation, items) {
    agentTitle.textContent = conversation.agentName;
    agentRuntime.textContent = runtimeLabel(conversation);
    input.placeholder = `Message ${conversation.agentName}…`;
    setActivity(null);
    setState('Connecting…', 'down');
    renderTranscript(items);
    if (conversationController?.catalog) renderCatalog(conversationController.catalog);
  }

  function handleConnection(state) {
    if (state === 'unauthorized') {
      showNotAuthorized();
      return;
    }
    if (state === 'reconnecting') {
      send.disabled = true;
      setState('Reconnecting…', 'down');
      return;
    }
    setState('Ready', 'ready');
    setActivity(null);
    send.disabled = false;
  }

  function showCreateError(message) {
    createError.textContent = message;
    createError.hidden = !message;
  }

  function setCreating(creating) {
    submitCreateAgent.disabled = creating;
    submitCreateAgent.textContent = creating ? 'Creating…' : 'Create agent';
  }

  function openCreateDialog() {
    const selected = conversationController?.selected;
    const catalog = conversationController?.catalog;
    if (!selected || !catalog) return;
    createForm.reset();
    advancedOptions.open = false;
    showCreateError('');
    setCreating(false);
    inheritAgent.textContent = selected.agentName;
    inheritRuntime.textContent = runtimeLabel(selected);

    providerSelect.replaceChildren();
    for (const provider of catalog.installedProviders) {
      const option = document.createElement('option');
      option.value = provider;
      option.textContent = provider;
      providerSelect.append(option);
    }
    const selectedProviderInstalled = catalog.installedProviders.includes(selected.provider);
    const fallbackProvider = catalog.isInstallationDefaultInstalled
      ? catalog.installationDefault
      : catalog.installedProviders[0];
    providerSelect.value = selectedProviderInstalled ? selected.provider : fallbackProvider;
    providerWasChanged = providerSelect.value !== selected.provider;
    providerField.hidden = catalog.installedProviders.length <= 1;
    singleProvider.hidden = catalog.installedProviders.length > 1;
    singleProvider.textContent = `Provider: ${providerSelect.value}`;
    modelInput.value = providerWasChanged ? '' : selected.model || '';
    effortSelect.value = providerWasChanged ? '' : selected.effort || '';
    if (!selectedProviderInstalled) {
      showCreateError(
        `The selected agent uses ${selected.provider}, which is not installed. Choose an installed provider.`,
      );
    }
    createDialog.showModal();
    agentName.focus();
  }

  function closeCreateDialog() {
    createDialog.close();
    createAgentButton.focus();
  }

  providerSelect.addEventListener('change', () => {
    const selected = conversationController?.selected;
    providerWasChanged = providerSelect.value !== selected?.provider;
    modelInput.value = providerWasChanged ? '' : selected?.model || '';
    effortSelect.value = providerWasChanged ? '' : selected?.effort || '';
    showCreateError('');
  });
  createAgentButton.addEventListener('click', openCreateDialog);
  closeCreateAgent.addEventListener('click', closeCreateDialog);
  cancelCreateAgent.addEventListener('click', closeCreateDialog);
  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showCreateError('');
    setCreating(true);
    try {
      await conversationController.createAgent({
        name: agentName.value,
        ...(providerWasChanged && { provider: providerSelect.value }),
        model: modelInput.value.trim(),
        effort: effortSelect.value,
      });
      createDialog.close();
      setSidebarOpen(false);
      input.focus();
    } catch (error) {
      showCreateError(error instanceof Error ? error.message : 'Agent could not be created.');
    } finally {
      setCreating(false);
    }
  });

  // ---- composer ---------------------------------------------------------
  function resize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    syncChrome();
  }
  function updateCounter() {
    const remaining = maxLength - input.value.length;
    counter.hidden = remaining > counterThreshold;
    counter.textContent = `${remaining} left`;
    counter.classList.toggle('over', remaining <= 0);
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    addMessage('user', text);
    input.value = '';
    resize();
    updateCounter();
    send.disabled = true;
    setState('Working', 'busy');
    setActivity('Thinking…');
    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [tokenHeader]: token },
        body: JSON.stringify({ conversationId: conversationController?.selected?.conversationId, text }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${response.status})`);
      }
      send.disabled = false;
      input.focus();
    } catch (error) {
      addMessage('system', error instanceof Error ? error.message : 'Message could not be sent.', false);
      send.disabled = false;
      setState('Ready', 'ready');
      setActivity(null);
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    resize();
    updateCounter();
  });

  async function bootstrap() {
    if (!token) {
      showNotAuthorized();
      return;
    }
    conversationController = createConversationController({
      token,
      tokenHeader,
      onCatalog: renderCatalog,
      onSelected: selectConversation,
      onEvent: handleEvent,
      onConnection: handleConnection,
    });
    try {
      await conversationController.initialize();
      input.focus();
    } catch (error) {
      send.disabled = true;
      setState('Not connected', 'down');
      renderEmptyState({
        heading: 'Agents could not be loaded',
        body: error instanceof Error ? error.message : 'Reload the page to try again.',
        locked: true,
      });
    }
    syncChrome();
  }

  window.addEventListener('beforeunload', () => conversationController?.dispose());
  void bootstrap();
})();
