/** Shared privacy-safe actor and origin vocabulary. */
import os from 'os';

import { getMessagingGroup } from '../db/messaging-groups.js';
import type { HostAuditDimensions } from './types.js';
import { structuralId, structuralToken } from './structural-validation.js';

export function hostUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || 'unknown';
  }
}

export async function containerDimensions(messagingGroupId: string | null): Promise<HostAuditDimensions> {
  const dimensions: HostAuditDimensions = { transport: 'container' };
  if (messagingGroupId) {
    const channel = (await getMessagingGroup(messagingGroupId))?.channel_type;
    const safeMessagingGroupId = structuralId(messagingGroupId);
    const safeChannel = structuralToken(channel);
    if (safeMessagingGroupId && safeChannel) {
      dimensions.messaging_group_id = safeMessagingGroupId;
      dimensions.channel_type = safeChannel;
    }
  }
  return dimensions;
}
