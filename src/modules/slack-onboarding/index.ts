/**
 * Slack DM onboarding + thread auto-title (agent-view DM surface).
 *
 * Channel-layer module owning the platform knowledge that used to sit inline
 * in trunk's delivery.ts/router.ts. Registers exclusively through generic
 * trunk hooks — trunk carries no Slack literals for any of this:
 *
 *   - `registerPostDeliveryHook` (delivery): the FIRST delivery of an
 *     empty-thread DM session (the welcome) pins the get-started suggested
 *     prompts at the top of the Messages tab.
 *   - `setAgentDmOpenedHandler` (Chat SDK bridge): (re)asserts or retires
 *     the prompts when the user opens the agent DM.
 *   - `registerSessionCreatedHook` (router): a brand-new per-thread DM
 *     session names its thread after the first user message (D15) and
 *     retires the onboarding prompts.
 *
 * Everything here is decoration: fire-and-forget, capability-gated inside
 * the registry passthroughs (adapters without the APIs no-op), and never
 * allowed to affect delivery or routing.
 *
 * Installed with the Slack channel payload; registered via a barrel-appended
 * import at install time.
 */
import { setSuggestedPrompts, setThreadTitle } from '../../channels/channel-registry.js';
import { setAgentDmOpenedHandler } from '../../channels/chat-sdk-bridge.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { registerPostDeliveryHook } from '../../delivery.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { registerSessionCreatedHook } from '../../router.js';

/**
 * Auto-title timing. The initial delay lets the first typing
 * assistant.threads.setStatus materialize the assistant thread before the
 * title lands (Slack rejects titles on not-yet-assistant threads with
 * channel_not_found). Mutable as a test seam only.
 */
export const titleDelays = { initialMs: 3000, retryMs: 7000 };
export function setTitleDelaysForTest(initialMs: number, retryMs: number): void {
  titleDelays.initialMs = initialMs;
  titleDelays.retryMs = retryMs;
}

/**
 * Welcome-notification follow-through (agent-view DMs). The welcome is a
 * NOTIFICATION — informational, never a question the user replies to
 * (product decision after the focus-hack dead end: no Slack API can navigate
 * a user into a thread; conversations are user-rooted by design). The tour
 * offer lives in SUGGESTED PROMPTS pinned at the top of the Messages tab:
 * clicking one sends that text as the user's own message, rooting a
 * conversation thread whose opener carries the intent by itself.
 * Fire-and-forget; silent no-op on non-agent-view channels via the
 * capability gates. Scoped by the post-delivery hook's firstDelivery flag
 * to the FIRST delivery of an empty-thread DM session — i.e. the welcome.
 */
const WELCOME_PROMPTS: Array<{ title: string; message: string }> = [
  { title: 'Give me the tour', message: 'Give me a quick tour of what you can do.' },
  {
    title: 'What should I try first?',
    message: 'What should I try first? Suggest something useful we could do right now.',
  },
  { title: 'Help me with something', message: 'I have something specific I want help with.' },
];

/** True when this DM already has a real conversation (a per-thread session
 *  with a ts segment) — the get-started prompts are then stale. */
async function dmHasConversation(mgId: string): Promise<boolean> {
  return (await getActiveSessions()).some((s) => {
    if (s.messaging_group_id !== mgId || !s.thread_id) return false;
    const parts = s.thread_id.split(':');
    return parts.length >= 3 && parts[parts.length - 1] !== '';
  });
}

/** Clear the onboarding prompts once the first conversation starts. Fired
 *  where the auto-title trigger runs (session-created consumer below). */
export function clearWelcomePrompts(instanceKey: string, platformId: string): void {
  void setSuggestedPrompts(instanceKey, platformId, [])
    .then(() => log.info('Welcome prompts cleared', { platformId }))
    .catch(() => {});
}

// (Re)assert or retire the onboarding prompts when the user OPENS the agent
// DM — prompt sets made before the DM was ever opened may not render
// (live-hit), and stale get-started buttons should retire once a real
// conversation exists.
setAgentDmOpenedHandler(async ({ channelId }) => {
  const platformId = `slack:${channelId}`;
  const mg = await getMessagingGroupByPlatform('slack', platformId);
  if (!mg || mg.is_group !== 0) return;
  if (await dmHasConversation(mg.id)) {
    clearWelcomePrompts(mg.instance ?? mg.channel_type, platformId);
    return;
  }
  void setSuggestedPrompts(mg.instance ?? mg.channel_type, platformId, WELCOME_PROMPTS, 'Get started')
    .then(() => log.info('Welcome prompts re-asserted on DM open', { platformId }))
    .catch(() => {});
});

async function offerWelcomePrompts(msg: OutboundMessage): Promise<void> {
  try {
    const channelType = msg.channelType;
    const platformId = msg.platformId;
    if (!channelType || !platformId) return;
    const tidParts = (msg.threadId ?? '').split(':');
    if (tidParts.length >= 3 && tidParts[tidParts.length - 1] !== '') return; // threaded → not the welcome
    const mg = await getMessagingGroupByPlatform(channelType, platformId);
    if (!mg || mg.is_group !== 0) return;
    void setSuggestedPrompts(mg.instance ?? channelType, platformId, WELCOME_PROMPTS, 'Get started')
      .then(() => log.info('Welcome prompts set', { platformId }))
      .catch((err) => log.warn('Welcome prompts failed', { platformId, err }));
  } catch {
    // Decoration only — never let it affect delivery.
  }
}

// Welcome notification follow-through: the FIRST delivery of an empty-thread
// DM session (the welcome) pins the get-started suggested prompts. The hook
// already scopes to user-facing rows (non-system, non-agent, non-task_log).
registerPostDeliveryHook(async (msg, _session, { firstDelivery }) => {
  if (firstDelivery) await offerWelcomePrompts(msg);
});

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

registerSessionCreatedHook(({ session, mg, platformId, threadId, sessionMode, message }) => {
  if (mg.is_group !== 0 || sessionMode !== 'per-thread' || threadId === null) return;
  // Agent-mode auto-title (D15): a brand-new per-thread DM session names
  // its thread after the first user message. Fire-and-forget, capability-
  // gated inside setThreadTitle (adapters without the API no-op) — zero
  // behavior change for non-Slack and for shared-session DM wirings.
  //
  // Timing: the assistant thread only materializes once the first
  // assistant.threads.setStatus (the typing fire) lands on it — a
  // title set before that fails with channel_not_found. Delay past the
  // initial typing fire and retry once for slow paths.
  const title = (safeParseContent(message.content).text ?? '').trim().slice(0, 45);
  if (title) {
    const trySetTitle = (attempt: number): void => {
      void setThreadTitle(mg.instance ?? mg.channel_type, platformId, threadId, title).catch((err) => {
        if (attempt < 1) {
          setTimeout(() => trySetTitle(attempt + 1), titleDelays.retryMs);
        } else {
          log.warn('setThreadTitle failed', { sessionId: session.id, threadId, err });
        }
      });
    };
    setTimeout(() => trySetTitle(0), titleDelays.initialMs);
  }
  // The first real conversation retires the get-started prompts (they
  // point at starting a conversation, which just happened).
  clearWelcomePrompts(mg.instance ?? mg.channel_type, platformId);
});
