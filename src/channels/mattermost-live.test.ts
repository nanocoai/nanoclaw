/**
 * LIVE round-trip proof for the mattermost channel against a real Mattermost
 * server. Skipped unless the `MATTERMOST_LAB_*` env is present, so a normal
 * `vitest run` is unaffected.
 *
 * Run it with the lab credentials sourced into the environment (see
 * .claude/skills/add-mattermost/VERIFY.md for the lab setup):
 *
 *   set -a; . ./.env.mattermost-lab; set +a
 *   pnpm run test:mattermost-live
 *
 * What it proves, end to end and with no mocks below the HTTP/WS boundary:
 *   1. adapter + bridge initialize (REST auth resolves the bot, WS connects)
 *   2. a channel message that @-mentions the bot reaches `onInbound` with the
 *      right platform id, thread id, text and mention flag
 *   3. a reply pushed through `bridge.deliver` exists in Mattermost
 *   4. the same round trip inside a DM
 *   5. (P1) an ask_question card renders as real message-attachment actions,
 *      and a server-mediated click on one reaches `onAction` and drives the
 *      card to its terminal state
 *   6. (P2) identity: the author id `onInbound` carries and the user id
 *      `onAction` carries are the same string for the same human
 *   7. (P2) threads: a reply under a root post arrives rooted, and a reply
 *      pushed back through that thread id lands as a real threaded reply
 *   8. (P2) attachments, both ways: an outbound file is uploaded and bound to
 *      the post that carries the text, and an inbound file arrives with its
 *      bytes already downloaded
 *   9. (P2) a select renders as a real dropdown and a server-mediated
 *      selection reaches `onAction` carrying the chosen value
 *
 * No click is simulated: they go through `POST
 * /posts/{id}/actions/{action_id}` (DoPostAction) as the human test user,
 * which is the same server path a browser click takes. Mattermost then POSTs
 * the callback back to us, from inside its container, over the webhook server
 * this test starts — so the lab's compose needs `host.docker.internal` mapped
 * and allowed as an untrusted internal connection (see the lab README).
 *
 * It stands in for `mattermost.ts`'s factory rather than calling it: that
 * factory reads credentials from a `.env` file in the process CWD, and the lab
 * credentials must never be written to disk. It builds the adapter through
 * the same `buildMattermostAdapter` the factory uses, so there is no copy to
 * drift.
 *
 * Against the vendored Mattermost adapter. Under the unscoped npm
 * `chat-adapter-mattermost@1.1.3` the id, attachment and DM-classification
 * assertions below fail — that package encodes ids differently and cannot
 * deliver through the bridge. Keeping this suite runnable is what stops a
 * dependency swap from passing unnoticed.
 */
import net from 'node:net';

import { Actions, Card, CardText, Select, SelectOption } from 'chat';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createPendingApproval } from '../db/sessions.js';
import { stopWebhookServer } from '../webhook-server.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { MATTERMOST_DEFAULTS, buildMattermostAdapter } from './mattermost.js';

const LAB_URL = process.env.MATTERMOST_LAB_URL || 'http://localhost:8065';
const BOT_TOKEN = process.env.MATTERMOST_LAB_BOT_TOKEN;
const BOT_ID = process.env.MATTERMOST_LAB_BOT_ID;
const BOT_USERNAME = process.env.MATTERMOST_LAB_BOT_USERNAME;
const CHANNEL_ID = process.env.MATTERMOST_LAB_CHANNEL_ID;
const USER_LOGIN = process.env.MATTERMOST_LAB_TESTUSER_USERNAME;
const USER_PASSWORD = process.env.MATTERMOST_LAB_TESTUSER_PASSWORD;

const LAB_VARS = {
  MATTERMOST_LAB_BOT_TOKEN: BOT_TOKEN,
  MATTERMOST_LAB_BOT_ID: BOT_ID,
  MATTERMOST_LAB_BOT_USERNAME: BOT_USERNAME,
  MATTERMOST_LAB_CHANNEL_ID: CHANNEL_ID,
  MATTERMOST_LAB_TESTUSER_USERNAME: USER_LOGIN,
  MATTERMOST_LAB_TESTUSER_PASSWORD: USER_PASSWORD,
};
const MISSING = Object.entries(LAB_VARS)
  .filter(([, v]) => !v)
  .map(([k]) => k);
const HAS_LAB = MISSING.length === 0;

// The original suite's one real weakness was `skipIf` alone: a suite that
// skips by default cannot defend against a dependency swapping its wire
// format underneath a stable-looking API (the unscoped npm
// `chat-adapter-mattermost@1.1.3` previously looked the same from the import line).
// Two guards fix that:
//   - a PARTIALLY configured lab is a misconfiguration, not a reason to skip;
//   - MATTERMOST_LAB_REQUIRED=1 (what `pnpm test:mattermost-live` sets) turns
//     "no lab" into a failure, so CI/scripted runs can never silently pass.
if (!HAS_LAB && MISSING.length < Object.keys(LAB_VARS).length) {
  throw new Error(`Mattermost lab is partially configured; missing: ${MISSING.join(', ')}`);
}
if (!HAS_LAB && process.env.MATTERMOST_LAB_REQUIRED === '1') {
  throw new Error(`MATTERMOST_LAB_REQUIRED=1 but the lab env is absent; missing: ${MISSING.join(', ')}`);
}

/**
 * Thread id: `mattermost:<channelId>[:<rootPostId>]` — raw Mattermost ids,
 * which are `[a-z0-9]{26}` and so never collide with the `:` separator. An
 * adapter that encodes these differently fails every id assertion below,
 * which is the point.
 */
function tid(channelId: string | undefined, rootPostId?: string): string {
  const base = `mattermost:${channelId ?? ''}`;
  return rootPostId ? `${base}:${rootPostId}` : base;
}

/** Secret every button carries back; a click without it must be refused. */
const CALLBACK_SECRET = `lab-secret-${Date.now()}`;

interface Recorded {
  platformId: string;
  threadId: string | null;
  message: InboundMessage;
}

const inbound: Recorded[] = [];

interface RecordedAction {
  questionId: string;
  selectedOption: string;
  userId: string;
}

const actions: RecordedAction[] = [];

/** Fake host: records what the bridge forwards, ignores the rest. */
const fakeSetup: ChannelSetup = {
  onInbound: (platformId, threadId, message) => {
    inbound.push({ platformId, threadId, message });
  },
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: (questionId, selectedOption, userId) => {
    actions.push({ questionId, selectedOption, userId });
  },
};

/** Grab a free TCP port, so the callback URL can be built before setup(). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Poll `predicate` until it returns a value, or give up. */
async function waitFor<T>(
  what: string,
  predicate: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await predicate();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function textOf(message: InboundMessage): string {
  return String((message.content as Record<string, unknown>).text ?? '');
}

/** Poll `inbound` until a message whose text contains `marker` shows up. */
async function waitForInbound(marker: string, timeoutMs = 20_000): Promise<Recorded> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = inbound.find((entry) => textOf(entry.message).includes(marker));
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(
        `no inbound message containing ${JSON.stringify(marker)} after ${timeoutMs}ms; ` +
          `saw ${inbound.length} inbound message(s)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** REST call as the human test user (session token from /users/login). */
let userToken = '';
let userId = '';

async function asUser<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${LAB_URL}/api/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${userToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** REST read-back as the bot — the independent check that a post really landed. */
async function asBot<T>(path: string): Promise<T> {
  const response = await fetch(`${LAB_URL}/api/v4${path}`, {
    headers: { authorization: `Bearer ${BOT_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Download a file as the bot. Mattermost file URLs need the token. */
async function botFileBytes(fileId: string): Promise<string> {
  const response = await fetch(`${LAB_URL}/api/v4/files/${fileId}`, {
    headers: { authorization: `Bearer ${BOT_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`file ${fileId} download failed: ${response.status}`);
  }
  return await response.text();
}

/**
 * Upload a file to a channel as the human test user (multipart).
 *
 * `channelId` is widened to match the env-sourced constants above, which are
 * `string | undefined` until `HAS_LAB` gates the suite in.
 */
async function uploadAsUser(channelId: string | undefined, filename: string, body: string): Promise<string> {
  const form = new FormData();
  form.append('channel_id', channelId ?? '');
  form.append('files', new Blob([body], { type: 'text/plain' }), filename);
  const response = await fetch(`${LAB_URL}/api/v4/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${userToken}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`upload failed: ${response.status} ${await response.text()}`);
  }
  const result = (await response.json()) as { file_infos: { id: string }[] };
  return result.file_infos[0].id;
}

interface PostAction {
  default_option?: string;
  id: string;
  name: string;
  options?: { text: string; value: string }[];
  style?: string;
  type?: string;
}

interface Post {
  channel_id: string;
  file_ids?: string[];
  id: string;
  message: string;
  metadata?: { files?: { id: string; mime_type?: string; name: string; size?: number }[] };
  props?: { attachments?: { actions?: PostAction[]; text?: string; title?: string }[] };
  root_id?: string;
  user_id: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bridge: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adapter: any;
let dmChannelId = '';
let webhookPort = 0;
const stamp = Date.now();

describe.skipIf(!HAS_LAB)('mattermost live round trip', () => {
  beforeAll(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    // The callback URL has to be known before the adapter is built (it is
    // baked into every button), so the port is reserved up front rather than
    // letting the shared webhook server take an ephemeral one.
    webhookPort = await freePort();
    process.env.WEBHOOK_PORT = String(webhookPort);

    // The real builder the factory ships — not a copy of it.
    adapter = buildMattermostAdapter({
      baseUrl: LAB_URL,
      botToken: BOT_TOKEN as string,
      // Mattermost POSTs clicks from inside its own container, so the host is
      // addressed as host.docker.internal, not localhost. The adapter accepts
      // the base URL or the full route; the full route is used here so the
      // exact string Mattermost will call is visible in this file.
      callbackUrl: `http://host.docker.internal:${webhookPort}/webhook/mattermost`,
      callbackSecret: CALLBACK_SECRET,
    });
    bridge = createChatSdkBridge({
      adapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: MATTERMOST_DEFAULTS,
    });
    await bridge.setup(fakeSetup);

    // --- a human user session, used to send the inbound messages ---
    const login = await fetch(`${LAB_URL}/api/v4/users/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login_id: USER_LOGIN, password: USER_PASSWORD }),
    });
    if (!login.ok) throw new Error(`test-user login failed: ${login.status}`);
    userToken = login.headers.get('token') ?? '';
    userId = ((await login.json()) as { id: string }).id;
    if (!userToken || !userId) throw new Error('test-user login returned no session');

    const dm = await asUser<{ id: string }>('POST', '/channels/direct', [userId, BOT_ID]);
    dmChannelId = dm.id;
  }, 60_000);

  afterAll(async () => {
    await bridge?.teardown().catch(() => {});
    await stopWebhookServer();
    closeDb();
  }, 30_000);

  it('a. initializes: bot resolved over REST, WebSocket connected', () => {
    expect(adapter.botUserId).toBe(BOT_ID);
    expect(adapter.userName).toBe(BOT_USERNAME);
    expect(bridge.channelType).toBe('mattermost');
    expect(bridge.name).toBe('mattermost');
  });

  it('b. a channel @mention reaches onInbound with the right ids, text and mention flag', async () => {
    const marker = `p0-channel-in-${stamp}`;
    const sent = await asUser<Post>('POST', '/posts', {
      channel_id: CHANNEL_ID,
      message: `@${BOT_USERNAME} ${marker}`,
    });

    const received = await waitForInbound(marker);
    expect(received.platformId).toBe(tid(CHANNEL_ID));
    // A top-level channel post belongs to the channel's thread, not to a
    // thread of its own: with group defaults threads:true, rooting every
    // message on itself would give the agent no context between two
    // consecutive posts in a channel.
    expect(received.threadId).toBe(tid(CHANNEL_ID));
    expect(received.message.id).toBe(sent.id);
    expect(received.message.kind).toBe('chat-sdk');
    expect(received.message.isMention).toBe(true);
    expect(received.message.isGroup).toBe(true);
    expect(textOf(received.message)).toContain(marker);
    const content = received.message.content as Record<string, unknown>;
    expect(content.senderId).toBe(userId);
    expect(content.sender).toBe(USER_LOGIN);
  }, 60_000);

  it('c. an outbound reply through bridge.deliver lands in the channel', async () => {
    const marker = `p0-channel-out-${stamp}`;
    const postId = await bridge.deliver(tid(CHANNEL_ID), tid(CHANNEL_ID), {
      kind: 'text',
      content: { text: `channel reply ${marker}` },
    });
    expect(postId).toBeTruthy();

    const post = await asBot<Post>(`/posts/${postId}`);
    expect(post.channel_id).toBe(CHANNEL_ID);
    expect(post.user_id).toBe(BOT_ID);
    expect(post.message).toBe(`channel reply ${marker}`);
  }, 60_000);

  it('d. isDM is false for a DM channel the adapter has never observed (cold cache)', () => {
    // Documents the known P0 caveat: isDM is synchronous and answers from a
    // cache primed by inbound frames, fetchThread and openDM. This DM channel
    // was created out of band by the test user, so nothing has primed it yet.
    expect(adapter.isDM(tid(dmChannelId))).toBe(false);
  });

  it('e. a DM reaches onInbound over the DM path, and primes the isDM cache', async () => {
    const marker = `p0-dm-in-${stamp}`;
    const sent = await asUser<Post>('POST', '/posts', {
      channel_id: dmChannelId,
      message: `dm ${marker}`,
    });

    const received = await waitForInbound(marker);
    expect(received.platformId).toBe(tid(dmChannelId));
    expect(received.threadId).toBe(tid(dmChannelId));
    expect(received.message.id).toBe(sent.id);
    // The DM branch of the bridge: DMs count as addressed to the bot, and are
    // not group messages — so the host applies DM defaults, not mention-sticky.
    // This must hold on a COLD channel (d) proved nothing had primed it): the
    // adapter reads channel_type 'D' off the posted frame and caches it before
    // dispatching, so even the very first DM takes the DM branch.
    expect(received.message.isMention).toBe(true);
    expect(received.message.isGroup).toBe(false);
    expect(textOf(received.message)).toContain(marker);
    expect(adapter.isDM(tid(dmChannelId))).toBe(true);
  }, 60_000);

  it('f. an outbound reply through bridge.deliver lands in the DM', async () => {
    const marker = `p0-dm-out-${stamp}`;
    const postId = await bridge.deliver(tid(dmChannelId), tid(dmChannelId), {
      kind: 'text',
      content: { markdown: `dm reply ${marker}` },
    });
    expect(postId).toBeTruthy();

    const post = await asBot<Post>(`/posts/${postId}`);
    expect(post.channel_id).toBe(dmChannelId);
    expect(post.user_id).toBe(BOT_ID);
    expect(post.message).toBe(`dm reply ${marker}`);
  }, 60_000);

  // --- P1: interactive cards ------------------------------------------------

  const questionId = `qlive-${stamp}`;
  const options = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
  ];
  let cardPostId = '';
  let approveActionId = '';

  it('g. an ask_question card lands as a message attachment with real actions', async () => {
    // The render row is what the bridge resolves the clicked index back
    // through; the host writes it when it delivers the question.
    // `pending_approvals` rather than `pending_questions` only because the
    // latter's session_id is a foreign key and this test has no session —
    // getAskQuestionRender reads either.
    createPendingApproval({
      approval_id: questionId,
      request_id: `req-${stamp}`,
      action: 'ask_question',
      payload: '{}',
      channel_type: 'mattermost',
      platform_id: tid(CHANNEL_ID),
      title: '❓ Deploy?',
      options_json: JSON.stringify(options),
      created_at: new Date().toISOString(),
    });

    cardPostId = await bridge.deliver(tid(CHANNEL_ID), tid(CHANNEL_ID), {
      kind: 'text',
      content: {
        type: 'ask_question',
        questionId,
        title: '❓ Deploy?',
        question: `Ship p1-card-${stamp}?`,
        options,
      },
    });
    expect(cardPostId).toBeTruthy();

    const post = await asBot<Post>(`/posts/${cardPostId}`);
    const attachment = post.props?.attachments?.[0];
    expect(attachment?.title).toBe('❓ Deploy?');
    expect(attachment?.text).toContain(`Ship p1-card-${stamp}?`);
    expect(attachment?.actions?.map((action) => action.name)).toEqual(['Approve', 'Reject']);
    for (const action of attachment?.actions ?? []) {
      expect(action.type).toBe('button');
      // Mattermost generated these: the SDK's own `ncq:<qid>:<idx>` is not
      // route-safe. It also strips `integration` from client-facing copies,
      // which is why the action id is the only handle a click has.
      expect(action.id).toMatch(/^[A-Za-z0-9]+$/);
      expect(action).not.toHaveProperty('integration');
    }
    approveActionId = attachment?.actions?.[0]?.id ?? '';
    expect(approveActionId).toBeTruthy();
  }, 60_000);

  it('h. a server-mediated click reaches onAction and resolves the card', async () => {
    // DoPostAction — the same endpoint the webapp calls on a real click. The
    // server then POSTs the callback to our webhook, from inside its container.
    const response = await fetch(`${LAB_URL}/api/v4/posts/${cardPostId}/actions/${approveActionId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(response.status).toBe(200);

    const recorded = await waitFor('onAction to fire', () =>
      actions.find((action) => action.questionId === questionId),
    );
    // The index encoded in the button resolved back to the real option value.
    expect(recorded.selectedOption).toBe('approve');
    // Same identity shape parseMessage projects for an inbound author: the
    // raw Mattermost user id, unprefixed.
    expect(recorded.userId).toBe(userId);

    const terminal = await waitFor('the card to reach its terminal state', async () => {
      const post = await asBot<Post>(`/posts/${cardPostId}`);
      return post.message.includes('Approved') ? post : undefined;
    });
    expect(terminal.message).toContain('❓ Deploy?');
    expect(terminal.message).toContain('✅ Approved');
    // The buttons are gone — otherwise the question stays clickable forever.
    expect(terminal.props?.attachments ?? []).toHaveLength(0);
  }, 60_000);

  it('h2. a forged click that does not carry the callback secret is refused', async () => {
    // What an attacker who learned the callback URL can do: POST a plausible
    // PostActionIntegrationRequest straight at the webhook server. The server
    // never sees this (it is not a DoPostAction), so the only defence is the
    // secret every real click carries in its server-only context.
    const forged = await fetch(`http://127.0.0.1:${webhookPort}/webhook/mattermost`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        post_id: cardPostId,
        channel_id: CHANNEL_ID,
        context: { action_id: `ncq:${questionId}:1`, value: '1' },
      }),
    });
    expect(forged.status).toBe(401);
    // And nothing was dispatched: the only recorded answer is still the real one.
    expect(actions.filter((action) => action.questionId === questionId)).toHaveLength(1);
  }, 30_000);

  // --- P2: identity, threads, attachments, selects --------------------------

  it('i. the click identity and the inbound author identity are the same string', async () => {
    // The invariant the host depends on: modules/permissions keys a sender as
    // `mattermost:<author.userId>` on the way in, and re-derives the same
    // string from `ActionEvent.user.userId` to authorize a card click. If the
    // two ever disagreed, approval clicks would be dropped as unauthorized.
    const inboundAuthor = inbound
      .map((entry) => (entry.message.content as Record<string, unknown>).author as { userId?: string } | undefined)
      .find((author) => author?.userId);
    const clicked = actions.find((action) => action.questionId === questionId);

    expect(inboundAuthor?.userId).toBe(userId);
    expect(clicked?.userId).toBe(userId);
    expect(clicked?.userId).toBe(inboundAuthor?.userId);
    // And it is the opaque id, not the handle — the handle is display only.
    expect(userId).not.toBe(USER_LOGIN);
    const flat = inbound.find((entry) => (entry.message.content as Record<string, unknown>).senderId)?.message
      .content as Record<string, unknown>;
    expect(flat.senderId).toBe(userId);
    expect(flat.sender).toBe(USER_LOGIN);
  });

  let threadRootId = '';

  it('j. a threaded reply arrives rooted on its root post', async () => {
    const marker = `p2-thread-in-${stamp}`;
    const root = await asUser<Post>('POST', '/posts', {
      channel_id: CHANNEL_ID,
      message: `@${BOT_USERNAME} thread root ${stamp}`,
    });
    threadRootId = root.id;
    const reply = await asUser<Post>('POST', '/posts', {
      channel_id: CHANNEL_ID,
      message: `@${BOT_USERNAME} ${marker}`,
      root_id: root.id,
    });
    expect(reply.root_id).toBe(root.id);

    const received = await waitForInbound(marker);
    // The thread id carries the root; the platform id stays the channel, so
    // the host still resolves one messaging group for the whole channel.
    expect(received.threadId).toBe(tid(CHANNEL_ID, root.id));
    expect(received.platformId).toBe(tid(CHANNEL_ID));
    expect(received.message.id).toBe(reply.id);
  }, 60_000);

  it('k. an outbound reply through that thread id lands as a real threaded reply', async () => {
    const marker = `p2-thread-out-${stamp}`;
    const postId = await bridge.deliver(tid(CHANNEL_ID), tid(CHANNEL_ID, threadRootId), {
      kind: 'text',
      content: { text: `threaded reply ${marker}` },
    });
    expect(postId).toBeTruthy();

    const post = await asBot<Post>(`/posts/${postId}`);
    expect(post.root_id).toBe(threadRootId);
    expect(post.channel_id).toBe(CHANNEL_ID);
    expect(post.message).toBe(`threaded reply ${marker}`);
    // Independent proof it is in the thread and not merely tagged as such.
    const thread = await asBot<{ order: string[] }>(`/posts/${threadRootId}/thread`);
    expect(thread.order).toContain(postId);
  }, 60_000);

  it('l. an outbound file is uploaded and bound to the post carrying the text', async () => {
    const marker = `p2-file-out-${stamp}`;
    const body = `outbound attachment ${stamp}\n`;
    const postId = await bridge.deliver(tid(CHANNEL_ID), tid(CHANNEL_ID), {
      kind: 'text',
      content: { text: `with attachment ${marker}` },
      files: [{ filename: `outbound-${stamp}.txt`, data: Buffer.from(body) }],
    });
    expect(postId).toBeTruthy();

    const post = await asBot<Post>(`/posts/${postId}`);
    // One post, both payloads — Mattermost binds files at post creation, so
    // unlike Slack there is no second file-only message.
    expect(post.message).toBe(`with attachment ${marker}`);
    expect(post.file_ids).toHaveLength(1);
    const info = post.metadata?.files?.[0];
    expect(info?.name).toBe(`outbound-${stamp}.txt`);
    expect(info?.size).toBe(Buffer.byteLength(body));
    // And it is really downloadable, not just referenced.
    const uploadedId = post.file_ids?.[0] ?? '';
    expect(await botFileBytes(uploadedId)).toBe(body);
  }, 60_000);

  it('m. an inbound file reaches onInbound with its bytes already downloaded', async () => {
    const marker = `p2-file-in-${stamp}`;
    const body = `inbound attachment ${stamp}\n`;
    const fileId = await uploadAsUser(CHANNEL_ID, `inbound-${stamp}.txt`, body);
    const sent = await asUser<Post>('POST', '/posts', {
      channel_id: CHANNEL_ID,
      message: `@${BOT_USERNAME} ${marker}`,
      file_ids: [fileId],
    });

    const received = await waitForInbound(marker);
    expect(received.message.id).toBe(sent.id);
    const content = received.message.content as Record<string, unknown>;
    const attachments = content.attachments as
      | { data?: string; mimeType?: string; name?: string; size?: number; type?: string }[]
      | undefined;
    expect(attachments).toHaveLength(1);
    const attachment = attachments![0];
    expect(attachment.name).toBe(`inbound-${stamp}.txt`);
    expect(attachment.type).toBe('file');
    expect(attachment.mimeType).toContain('text/plain');
    expect(attachment.size).toBe(Buffer.byteLength(body));
    // The bridge calls fetchData() before serializing, so the bytes are here
    // as base64 — the whole point of the adapter's fetchData closure.
    expect(Buffer.from(attachment.data!, 'base64').toString()).toBe(body);
  }, 60_000);

  it('n. a select renders as a real dropdown and a selection reaches onAction', async () => {
    // Selects are not on the bridge's ask_question path (that one builds
    // buttons), so the card is posted through the adapter directly. The click
    // still travels the full host route: DoPostAction → Mattermost → our
    // webhook → chat.processAction → the bridge's onAction.
    const selectQuestionId = `qsel-${stamp}`;
    const selectOptions = [
      { label: 'Staging', selectedLabel: '🟡 Staging', value: 'staging' },
      { label: 'Production', selectedLabel: '🔴 Production', value: 'prod' },
    ];
    createPendingApproval({
      approval_id: selectQuestionId,
      request_id: `reqsel-${stamp}`,
      action: 'ask_question',
      payload: '{}',
      channel_type: 'mattermost',
      platform_id: tid(CHANNEL_ID),
      title: '🚀 Where to?',
      options_json: JSON.stringify(selectOptions),
      created_at: new Date().toISOString(),
    });

    const posted = await adapter.postMessage(tid(CHANNEL_ID), {
      card: Card({
        title: '🚀 Where to?',
        children: [
          CardText(`Deploy p2-select-${stamp} where?`),
          Actions([
            Select({
              id: `ncq:${selectQuestionId}:sel`,
              label: 'Environment',
              placeholder: 'Pick an environment…',
              options: selectOptions.map((option) => SelectOption({ label: option.label, value: option.value })),
            }),
          ]),
        ],
      }),
    });

    const post = await asBot<Post>(`/posts/${posted.id}`);
    const action = post.props?.attachments?.[0]?.actions?.[0];
    expect(action?.type).toBe('select');
    expect(action?.name).toBe('Pick an environment…');
    expect(action?.options).toEqual([
      { text: 'Staging', value: 'staging' },
      { text: 'Production', value: 'prod' },
    ]);

    // DoPostAction carries the chosen option in the body; Mattermost merges it
    // into the callback's `context.selected_option`.
    const response = await fetch(`${LAB_URL}/api/v4/posts/${posted.id}/actions/${action!.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ selected_option: 'prod' }),
    });
    expect(response.status).toBe(200);

    const recorded = await waitFor('the select answer to reach onAction', () =>
      actions.find((entry) => entry.questionId === selectQuestionId),
    );
    expect(recorded.selectedOption).toBe('prod');
    expect(recorded.userId).toBe(userId);
  }, 60_000);
});
