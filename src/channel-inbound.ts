import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { log } from './log.js';
import { routeInbound } from './router.js';

/** Preserve host acceptance for adapters that await delivery. Attach logging
 * separately so fire-and-forget adapters also have a rejection observer. */
export function channelInboundHandler(
  adapter: Pick<ChannelAdapter, 'channelType' | 'instance'>,
): ChannelSetup['onInbound'] {
  return (platformId, threadId, message) => {
    const routed = (async () =>
      routeInbound({
        channelType: adapter.channelType,
        instance: adapter.instance ?? adapter.channelType,
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: JSON.stringify(message.content),
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
        },
      }))();
    void routed.catch((err) => {
      log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
    });
    return routed;
  };
}
