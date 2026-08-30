import { getMessagingGroup } from './db/messaging-groups.js';
import { log } from './log.js';
import { getUserDmByMessagingGroup } from './modules/permissions/db/user-dms.js';
import { getUser } from './modules/permissions/db/users.js';

/**
 * The welcome payload is a SYSTEM INSTRUCTION, not a literal greeting: it tells
 * the agent to run `/welcome`, which composes and sends the greeting the user
 * actually sees. See {@link sendWelcome}.
 */
export const DEFAULT_WELCOME =
  'System instruction: run /welcome to introduce yourself to the user on this new channel.';

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Send the welcome into a provisioned DM. Deliberately separate from
 * provisioning: an admin triggers it — e.g. an admin UI calls
 * `ncl messaging-groups send-welcome --id <mg>` on a button tap.
 *
 * The welcome is a `/welcome` SYSTEM INSTRUCTION injected as an inbound message
 * into the DM session (via `routeInbound`); the agent then runs `/welcome` and
 * composes the greeting the user sees. The message is attributed to the DM's own
 * member (resolved from `user_dms`) — a `system` sender would be dropped by the
 * access gate as an unknown sender (the DM group is `strict`). That `user_dms`
 * row is created by the generic `user-dms ensure` provisioning step.
 *
 * Throws when the messaging group is unknown, or when no user maps to it (the DM
 * wasn't provisioned for a user). Assumes the central DB is open.
 */
export async function sendWelcome(input: { messagingGroupId: string; text?: string }): Promise<{ messageId: string }> {
  const { messagingGroupId, text } = input;

  const mg = await getMessagingGroup(messagingGroupId);
  if (!mg) throw new Error(`sendWelcome: messaging group not found: ${messagingGroupId}`);

  const dm = await getUserDmByMessagingGroup(messagingGroupId);
  if (!dm) {
    throw new Error(
      `sendWelcome: no user maps to messaging group ${messagingGroupId} — was this DM provisioned for a user?`,
    );
  }
  const user = await getUser(dm.user_id);

  // Governance home surface on? Tell the agent to direct the user to its App
  // Home tab as part of the greeting — the governance service publishes the
  // policy-scoped connect buttons there before the welcome is sent (its
  // provision job orders publish → welcome). Slack DMs only; best-effort.
  let welcomeText = text?.trim() || DEFAULT_WELCOME;
  if (!text && mg.channel_type === 'slack') {
    try {
      const { homeForwardingEnabled } = await import('./channels/home-events-forward.js');
      const { slackAppHomeDeepLink } = await import('./templates/app-home.js');
      if (homeForwardingEnabled()) {
        const link = await slackAppHomeDeepLink();
        // App details → Home uses Slack's stable labels across mobile, desktop,
        // and web; the deep link is a clickable alternative.
        welcomeText +=
          ` As part of your introduction, explain that connecting their accounts lets you act on their behalf.` +
          ` Point them to your Slack App Home, where the connect buttons are.` +
          ` They can open this app's details and select "Home"` +
          (link ? `, or use this link: [Open my Home tab](${link})` : '') +
          '.';
      }
    } catch {
      /* welcome must never fail on presentation extras */
    }
  }

  const messageId = `welcome-${Date.now()}-${randomSuffix()}`;
  // Lazy import keeps the heavy router/channel graph out of this module's static
  // dependencies. The send is a direct in-host routeInbound.
  const { routeInbound } = await import('./router.js');
  await routeInbound({
    channelType: mg.channel_type,
    platformId: mg.platform_id,
    threadId: mg.platform_id,
    message: {
      id: messageId,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        text: welcomeText,
        sender: user?.display_name ?? dm.user_id,
        senderId: dm.user_id,
      }),
      isGroup: false,
    },
  });

  log.info('Welcome sent', { messagingGroupId, senderId: dm.user_id, messageId });
  return { messageId };
}
