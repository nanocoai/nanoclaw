/**
 * Destination-name → routing, shared by every outbound tool that takes `to`
 * (send_message, send_file, send_card). Agents reference destinations by name;
 * the local destination map (destinations.ts, written by the host) translates
 * the name into the routing tuple. Permission enforcement stays host-side in
 * delivery.ts via agent_destinations.
 */
import { findByName, getAllDestinations } from '../destinations.js';
import { getCurrentReplyRoute } from '../db/session-state.js';
import { resolveDestinationThread } from '../db/session-routing.js';

export type ResolvedRouting = {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  resolvedName: string;
};

export function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * A channel destination is threaded like the poll loop's explicit deliveries:
 * the thread of the message being answered (the published reply stamp) when it
 * came from that channel, else that channel's latest inbound thread. An agent
 * destination never carries a thread.
 */
export function resolveRouting(to: string): ResolvedRouting | { error: string } {
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id:
        resolveDestinationThread(dest.channelType!, dest.platformId!, getCurrentReplyRoute())?.threadId ?? null,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}
