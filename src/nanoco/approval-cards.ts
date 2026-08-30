import type { ChannelDeliveryAdapter } from '../delivery.js';
import type { MessagingGroup } from '../types.js';
import {
  APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT,
  approvalCardQuestion,
  persistedApprovalCardOptions,
} from './approval-card-render.js';
import type { BindingResolution, GatewayApprovalStore, StoredGatewayApproval } from './approval-store.js';

export interface ApproverBindingResolver {
  resolveApprover(issuer: string, subject: string): Promise<BindingResolution>;
}

export interface ApprovalCardDependencies {
  resolveBinding: ApproverBindingResolver;
  resolveDm: (userId: string) => Promise<MessagingGroup | null>;
  deliveryAdapter: () => ChannelDeliveryAdapter | null;
  decisionReady: () => void;
}

/**
 * Delivers one Gateway Ask to the exact policy-selected platform user.
 * The store is updated before every platform side effect; there is no
 * approver picker and no role/admin fallback in this path.
 */
export class GatewayApprovalCards {
  constructor(
    private readonly store: GatewayApprovalStore,
    private readonly dependencies: ApprovalCardDependencies,
  ) {}

  async deliver(row: StoredGatewayApproval): Promise<void> {
    if (row.state !== 'pending' || row.card_attempted_at) return;
    const key = approvalKey(row);
    const binding = await this.dependencies.resolveBinding.resolveApprover(row.approver_issuer, row.approver_subject);
    if (binding.status !== 'unique') {
      await this.unavailable(row);
      return;
    }

    const destination = await this.dependencies.resolveDm(binding.userId);
    if (!destination) {
      await this.unavailable(row);
      return;
    }

    const addressed = await this.store.recordCardAddress(key, binding.userId, {
      channelType: destination.channel_type,
      platformId: destination.platform_id,
      instance: destination.instance,
    });
    if (!addressed || addressed.state !== 'pending') return;

    const adapter = this.dependencies.deliveryAdapter();
    if (!adapter) {
      await this.unavailable(addressed);
      return;
    }

    // Persist the attempt before calling the platform. If the process dies in
    // the uncertainty window, restart submits unavailable instead of risking
    // a second card for the same live request.
    const attempted = await this.store.markCardAttempted(key);
    if (!attempted || attempted.state !== 'pending') return;
    try {
      const options = persistedApprovalCardOptions(attempted.card_options_json);
      if (!attempted.card_title || Buffer.byteLength(attempted.card_title) > APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT) {
        throw new Error('invalid persisted approval card title');
      }
      const platformMessageId = await adapter.deliver(
        destination.channel_type,
        destination.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: attempted.card_question_id,
          title: attempted.card_title,
          question: approvalCardQuestion(attempted),
          options,
        }),
        undefined,
        destination.instance,
      );
      await this.store.recordCardDelivered(key, platformMessageId ?? null);
    } catch {
      // Platform errors may contain handles, tokens, or response bodies. The
      // public outcome is intentionally only the authenticated wire value.
      await this.unavailable(attempted);
    }
  }

  private async unavailable(row: StoredGatewayApproval): Promise<void> {
    const decided = await this.store.recordUnavailable(approvalKey(row));
    if (decided?.state === 'decided') this.dependencies.decisionReady();
  }
}

function approvalKey(row: StoredGatewayApproval): {
  deploymentId: string;
  gatewayEpoch: string;
  approvalId: string;
} {
  return {
    deploymentId: row.deployment_id,
    gatewayEpoch: row.gateway_epoch,
    approvalId: row.approval_id,
  };
}
