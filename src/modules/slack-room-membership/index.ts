/**
 * slack-room-membership module — registers THE bridge membership handler
 * (generic membership seam: setMembershipHandler('slack', …) in
 * src/channels/chat-sdk-bridge.ts) and THE Slack channel-card interceptor
 * (permissions seam: registerChannelCardInterceptor). All behavior lives in
 * ./membership.ts: join-time adopt via the existing channel-approval card,
 * MPIM-fork carry-over, own-left detachment (migration 021), membership
 * notes into wired room sessions, and — via the interceptor, consulted by
 * requestChannelApproval on both the router mention path and the join-time
 * adopt path — the B2/D24 owner-presence access rule (owner present →
 * auto-wire, no card; stranger 1:1 DM → decline-and-notify; Slackbot shadow
 * channels → silently ignored).
 *
 * Registered by a skill-appended barrel import at install time (the Slack
 * channel skill appends this module to src/modules/index.ts).
 *
 * No guard registration: this module adds no ncl commands and no delivery
 * actions — the only privileged surface it touches is the channel-approval
 * card, whose click path is already guarded (channels.register).
 */
import { setMembershipHandler } from '../../channels/chat-sdk-bridge.js';
import { registerChannelCardInterceptor } from '../permissions/channel-approval.js';
import { handleSlackMembershipEvent, slackChannelCardInterceptor } from './membership.js';

setMembershipHandler('slack', (event) => handleSlackMembershipEvent(event));
registerChannelCardInterceptor('slack', (mg, event) => slackChannelCardInterceptor(mg, event));
