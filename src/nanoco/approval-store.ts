import { createHash } from 'crypto';

import type { DbDriver } from '../db/driver.js';

import {
  APPROVAL_PROTOCOL_VERSION,
  type ApprovalDecision,
  type ApprovalEvent,
  type ApprovalSnapshot,
  type ApprovalTerminalState,
  type DecisionAcknowledgement,
  type DecisionCommand,
  type GatewayApproval,
} from './approval-contract.js';
import { GATEWAY_APPROVAL_CARD_OPTIONS, approvalCardTitle } from './approval-card-render.js';

export type LocalApprovalState = 'pending' | 'decided' | 'delivered' | 'expired' | 'cancelled';

export interface StoredGatewayApproval {
  deployment_id: string;
  gateway_epoch: string;
  event_id: number | null;
  source_cursor: number;
  approval_id: string;
  request_digest: string;
  request_id: number;
  agent_id: string;
  session_id: string;
  container_instance_id: string;
  channel_id: string;
  deadline: string;
  approver_issuer: string;
  approver_subject: string;
  policy_version: string;
  matched_policy_ids_json: string;
  summary_method: string;
  summary_origin: string;
  summary_path: string;
  presentation_json: string;
  state: LocalApprovalState;
  decision: ApprovalDecision | null;
  approver_user_id: string | null;
  card_question_id: string;
  card_title: string;
  card_options_json: string;
  card_channel_type: string | null;
  card_platform_id: string | null;
  card_instance: string | null;
  card_attempted_at: string | null;
  card_delivered_at: string | null;
  card_platform_message_id: string | null;
  decision_at: string | null;
  acknowledged_at: string | null;
  gateway_state: ApprovalTerminalState | null;
  created_at: string;
  updated_at: string;
}

export type BindingResolution = { status: 'unique'; userId: string } | { status: 'missing' } | { status: 'ambiguous' };

export type ClickResult =
  | { status: 'decided'; approval: StoredGatewayApproval }
  | { status: 'unauthorized' | 'already_terminal' | 'not_found' };

interface ApprovalKey {
  deploymentId: string;
  gatewayEpoch: string;
  approvalId: string;
}

export class GatewayApprovalStore {
  constructor(
    private readonly db: DbDriver,
    readonly deploymentId: string,
  ) {}

  /** Replace every delivery binding for a principal with one explicit user. */
  async replaceApproverBinding(issuer: string, subject: string, userId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM nanoco_approver_bindings WHERE issuer = ? AND subject = ?', issuer, subject);
      await this.db.run(
        `INSERT INTO nanoco_approver_bindings (issuer, subject, user_id, created_at)
         VALUES (?, ?, ?, ?)`,
        issuer,
        subject,
        userId,
        now,
      );
    });
  }

  async resolveApprover(issuer: string, subject: string): Promise<BindingResolution> {
    const rows = await this.db.all<{ user_id: string }>(
      `SELECT b.user_id
         FROM nanoco_approver_bindings b
         JOIN users u ON u.id = b.user_id
        WHERE b.issuer = ? AND b.subject = ?
        ORDER BY b.user_id
        LIMIT 2`,
      issuer,
      subject,
    );
    if (rows.length === 0) return { status: 'missing' };
    if (rows.length !== 1) return { status: 'ambiguous' };
    return { status: 'unique', userId: rows[0]!.user_id };
  }

  async reconcileSnapshot(snapshot: ApprovalSnapshot): Promise<StoredGatewayApproval[]> {
    const now = new Date().toISOString();
    return this.db.transaction(async () => {
      const previous = await this.cursor();
      if (previous?.gateway_epoch === snapshot.gatewayEpoch && snapshot.cursor < previous.cursor) {
        throw new Error('Gateway approval snapshot cursor regressed within one epoch');
      }
      if (previous && previous.gateway_epoch !== snapshot.gatewayEpoch) {
        await this.db.run(
          `UPDATE nanoco_gateway_approvals
              SET state = 'expired', updated_at = ?
            WHERE deployment_id = ? AND gateway_epoch <> ? AND state IN ('pending', 'decided')`,
          now,
          this.deploymentId,
          snapshot.gatewayEpoch,
        );
      }

      const activeIds = new Set<string>();
      for (const approval of snapshot.approvals) {
        activeIds.add(approval.approvalId);
        await this.upsertApproval(snapshot.gatewayEpoch, snapshot.cursor, null, approval, now);
      }

      const pending = await this.db.all<{ approval_id: string }>(
        `SELECT approval_id
           FROM nanoco_gateway_approvals
          WHERE deployment_id = ? AND gateway_epoch = ? AND state = 'pending'`,
        this.deploymentId,
        snapshot.gatewayEpoch,
      );
      const expireSql =
        `UPDATE nanoco_gateway_approvals
            SET state = 'expired', updated_at = ?
          WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'pending'`;
      for (const row of pending) {
        if (!activeIds.has(row.approval_id)) {
          await this.db.run(expireSql, now, this.deploymentId, snapshot.gatewayEpoch, row.approval_id);
        }
      }
      await this.setCursor(snapshot.gatewayEpoch, snapshot.cursor, now);
      return this.cardsToDeliver(snapshot.gatewayEpoch);
    });
  }

  async recordEvent(event: ApprovalEvent): Promise<StoredGatewayApproval | null> {
    const now = new Date().toISOString();
    return this.db.transaction(async () => {
      const cursor = await this.cursor();
      if (!cursor || cursor.gateway_epoch !== event.gatewayEpoch) {
        throw new Error('Gateway approval event does not match the reconciled epoch');
      }
      if (event.eventId <= cursor.cursor) return null;
      if (event.eventId !== cursor.cursor + 1) {
        throw new Error('Gateway approval event cursor is not contiguous');
      }

      await this.upsertApproval(event.gatewayEpoch, event.eventId, event.eventId, event.approval, now);
      if (event.type === 'approval_terminal') {
        await this.applyTerminal(event.gatewayEpoch, event.approval.approvalId, event.state, now);
      }
      await this.setCursor(event.gatewayEpoch, event.eventId, now);
      if (event.type !== 'approval_requested') return null;
      return this.get({
        deploymentId: this.deploymentId,
        gatewayEpoch: event.gatewayEpoch,
        approvalId: event.approval.approvalId,
      });
    });
  }

  async recordCardAddress(
    key: ApprovalKey,
    userId: string,
    address: { channelType: string; platformId: string; instance?: string },
  ): Promise<StoredGatewayApproval | null> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE nanoco_gateway_approvals
          SET approver_user_id = ?, card_channel_type = ?, card_platform_id = ?, card_instance = ?, updated_at = ?
        WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'pending'
          AND card_attempted_at IS NULL`,
      userId,
      address.channelType,
      address.platformId,
      address.instance ?? address.channelType,
      now,
      key.deploymentId,
      key.gatewayEpoch,
      key.approvalId,
    );
    return this.get(key);
  }

  async markCardAttempted(key: ApprovalKey): Promise<StoredGatewayApproval | null> {
    const now = new Date().toISOString();
    const changed = await this.db.run(
      `UPDATE nanoco_gateway_approvals
          SET card_attempted_at = ?, updated_at = ?
        WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'pending'
          AND card_attempted_at IS NULL`,
      now,
      now,
      key.deploymentId,
      key.gatewayEpoch,
      key.approvalId,
    );
    if (changed.changes !== 1) return null;
    return this.get(key);
  }

  async recordCardDelivered(key: ApprovalKey, platformMessageId: string | null): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE nanoco_gateway_approvals
          SET card_platform_message_id = ?, card_delivered_at = ?, updated_at = ?
        WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'pending'`,
      platformMessageId,
      now,
      now,
      key.deploymentId,
      key.gatewayEpoch,
      key.approvalId,
    );
  }

  uncertainCardAttempts(gatewayEpoch: string): Promise<StoredGatewayApproval[]> {
    return this.db.all<StoredGatewayApproval>(
      `SELECT * FROM nanoco_gateway_approvals
        WHERE deployment_id = ? AND gateway_epoch = ? AND state = 'pending'
          AND card_attempted_at IS NOT NULL AND card_delivered_at IS NULL
        ORDER BY card_attempted_at, approval_id`,
      this.deploymentId,
      gatewayEpoch,
    );
  }

  async recordUnavailable(key: ApprovalKey): Promise<StoredGatewayApproval | null> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE nanoco_gateway_approvals
          SET state = 'decided', decision = 'unavailable', decision_at = ?, updated_at = ?
        WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'pending'`,
      now,
      now,
      key.deploymentId,
      key.gatewayEpoch,
      key.approvalId,
    );
    return this.get(key);
  }

  async recordHumanDecision(
    questionId: string,
    userId: string | null,
    decision: 'approve' | 'reject',
  ): Promise<ClickResult> {
    const row = await this.getByQuestionId(questionId);
    if (!row) return { status: 'not_found' };
    if (row.state !== 'pending') return { status: 'already_terminal' };
    if (!userId || row.approver_user_id !== userId) return { status: 'unauthorized' };
    const binding = await this.resolveApprover(row.approver_issuer, row.approver_subject);
    if (binding.status !== 'unique' || binding.userId !== userId) return { status: 'unauthorized' };

    const now = new Date().toISOString();
    const changed = await this.db.run(
      `UPDATE nanoco_gateway_approvals
          SET state = 'decided', decision = ?, decision_at = ?, updated_at = ?
        WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'pending'
          AND approver_user_id = ?`,
      decision,
      now,
      now,
      row.deployment_id,
      row.gateway_epoch,
      row.approval_id,
      userId,
    );
    if (changed.changes !== 1) return { status: 'already_terminal' };
    return { status: 'decided', approval: (await this.get(this.key(row)))! };
  }

  decisionsToSubmit(gatewayEpoch: string): Promise<StoredGatewayApproval[]> {
    return this.db.all<StoredGatewayApproval>(
      `SELECT * FROM nanoco_gateway_approvals
        WHERE deployment_id = ? AND gateway_epoch = ? AND state = 'decided'
        ORDER BY decision_at, approval_id`,
      this.deploymentId,
      gatewayEpoch,
    );
  }

  async acknowledge(row: StoredGatewayApproval, acknowledgement: DecisionAcknowledgement): Promise<void> {
    if (
      acknowledgement.gatewayEpoch !== row.gateway_epoch ||
      acknowledgement.approvalId !== row.approval_id ||
      acknowledgement.state !== expectedGatewayState(row.decision)
    ) {
      throw new Error('Gateway decision acknowledgement does not match the durable decision');
    }
    const now = new Date().toISOString();
    const changed = await this.db.run(
      `UPDATE nanoco_gateway_approvals
          SET state = 'delivered', acknowledged_at = ?, gateway_state = ?, updated_at = ?
        WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'decided'
          AND decision = ?`,
      now,
      acknowledgement.state,
      now,
      row.deployment_id,
      row.gateway_epoch,
      row.approval_id,
      row.decision,
    );
    if (changed.changes === 1) return;
    const current = await this.get(this.key(row));
    if (
      current?.state === 'delivered' &&
      current.decision === row.decision &&
      current.gateway_state === acknowledgement.state &&
      current.acknowledged_at
    ) {
      return;
    }
    throw new Error('Gateway decision acknowledgement could not advance durable state');
  }

  async markDecisionGone(row: StoredGatewayApproval): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE nanoco_gateway_approvals
          SET state = 'expired', updated_at = ?
        WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'decided'`,
      now,
      row.deployment_id,
      row.gateway_epoch,
      row.approval_id,
    );
  }

  decisionCommand(row: StoredGatewayApproval): DecisionCommand {
    if (!row.decision) throw new Error('Gateway approval has no durable decision');
    return {
      version: APPROVAL_PROTOCOL_VERSION,
      gatewayEpoch: row.gateway_epoch,
      approvalId: row.approval_id,
      requestDigest: row.request_digest,
      lineage: {
        requestId: row.request_id,
        deploymentId: row.deployment_id,
        agentId: row.agent_id,
        sessionId: row.session_id,
        containerInstanceId: row.container_instance_id,
        channelId: row.channel_id,
      },
      approver: { issuer: row.approver_issuer, subject: row.approver_subject },
      decision: row.decision,
    };
  }

  async getByQuestionId(questionId: string): Promise<StoredGatewayApproval | null> {
    return (
      (await this.db.get<StoredGatewayApproval>(
        'SELECT * FROM nanoco_gateway_approvals WHERE card_question_id = ?',
        questionId,
      )) ?? null
    );
  }

  async get(key: ApprovalKey): Promise<StoredGatewayApproval | null> {
    return (
      (await this.db.get<StoredGatewayApproval>(
        `SELECT * FROM nanoco_gateway_approvals
          WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ?`,
        key.deploymentId,
        key.gatewayEpoch,
        key.approvalId,
      )) ?? null
    );
  }

  async cursor(): Promise<{ gateway_epoch: string; cursor: number } | null> {
    return (
      (await this.db.get<{ gateway_epoch: string; cursor: number }>(
        'SELECT gateway_epoch, cursor FROM nanoco_gateway_approval_cursors WHERE deployment_id = ?',
        this.deploymentId,
      )) ?? null
    );
  }

  private cardsToDeliver(gatewayEpoch: string): Promise<StoredGatewayApproval[]> {
    return this.db.all<StoredGatewayApproval>(
      `SELECT * FROM nanoco_gateway_approvals
        WHERE deployment_id = ? AND gateway_epoch = ? AND state = 'pending' AND card_attempted_at IS NULL
        ORDER BY created_at, approval_id`,
      this.deploymentId,
      gatewayEpoch,
    );
  }

  private async upsertApproval(
    gatewayEpoch: string,
    sourceCursor: number,
    eventId: number | null,
    approval: GatewayApproval,
    now: string,
  ): Promise<void> {
    const key = { deploymentId: this.deploymentId, gatewayEpoch, approvalId: approval.approvalId };
    const existing = await this.get(key);
    if (existing) {
      requireSameEvidence(existing, approval);
      await this.db.run(
        `UPDATE nanoco_gateway_approvals
            SET event_id = COALESCE(event_id, ?),
                source_cursor = CASE WHEN source_cursor > ? THEN source_cursor ELSE ? END,
                updated_at = ?
          WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ?`,
        eventId,
        sourceCursor,
        sourceCursor,
        now,
        this.deploymentId,
        gatewayEpoch,
        approval.approvalId,
      );
      return;
    }

    const state: LocalApprovalState = Date.parse(approval.deadline) <= Date.parse(now) ? 'expired' : 'pending';
    await this.db.run(
      `INSERT INTO nanoco_gateway_approvals (
          deployment_id, gateway_epoch, event_id, source_cursor, approval_id, request_digest,
          request_id, agent_id, session_id, container_instance_id, channel_id, deadline,
          approver_issuer, approver_subject, policy_version, matched_policy_ids_json,
          summary_method, summary_origin, summary_path, presentation_json, state,
          card_question_id, card_title, card_options_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.deploymentId,
      gatewayEpoch,
      eventId,
      sourceCursor,
      approval.approvalId,
      approval.requestDigest,
      approval.lineage.requestId,
      approval.lineage.agentId,
      approval.lineage.sessionId,
      approval.lineage.containerInstanceId,
      approval.lineage.channelId,
      approval.deadline,
      approval.approver.issuer,
      approval.approver.subject,
      approval.policy.policyVersion,
      JSON.stringify(approval.policy.matchedPolicyIds),
      approval.summary.method,
      approval.summary.origin,
      approval.summary.path,
      JSON.stringify(approval.presentation),
      state,
      cardQuestionId(gatewayEpoch, approval.approvalId),
      approvalCardTitle(approval.presentation),
      JSON.stringify(GATEWAY_APPROVAL_CARD_OPTIONS),
      now,
      now,
    );
  }

  private async applyTerminal(
    gatewayEpoch: string,
    approvalId: string,
    terminal: ApprovalTerminalState,
    now: string,
  ): Promise<void> {
    const row = await this.get({ deploymentId: this.deploymentId, gatewayEpoch, approvalId });
    if (!row) throw new Error('Gateway terminal event has no durable approval');

    if (row.state === 'decided' && terminal === expectedGatewayState(row.decision)) {
      await this.db.run(
        `UPDATE nanoco_gateway_approvals
            SET state = 'delivered', acknowledged_at = ?, gateway_state = ?, updated_at = ?
          WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'decided'`,
        now,
        terminal,
        now,
        this.deploymentId,
        gatewayEpoch,
        approvalId,
      );
      return;
    }

    if (terminal === 'timed_out' || terminal === 'cancelled') {
      const localState = terminal === 'timed_out' ? 'expired' : 'cancelled';
      await this.db.run(
        `UPDATE nanoco_gateway_approvals
            SET state = ?, gateway_state = ?, updated_at = ?
          WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ?
            AND state IN ('pending', 'decided')`,
        localState,
        terminal,
        now,
        this.deploymentId,
        gatewayEpoch,
        approvalId,
      );
      return;
    }

    if (row.state === 'pending') {
      // A replacement host connection may observe the terminal event produced
      // by another instance. It is evidence that this local card is no longer
      // actionable, never evidence that this host may continue an operation.
      await this.db.run(
        `UPDATE nanoco_gateway_approvals
            SET state = 'cancelled', gateway_state = ?, updated_at = ?
          WHERE deployment_id = ? AND gateway_epoch = ? AND approval_id = ? AND state = 'pending'`,
        terminal,
        now,
        this.deploymentId,
        gatewayEpoch,
        approvalId,
      );
    }
  }

  private async setCursor(gatewayEpoch: string, cursor: number, now: string): Promise<void> {
    await this.db.run(
      `INSERT INTO nanoco_gateway_approval_cursors (deployment_id, gateway_epoch, cursor, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(deployment_id) DO UPDATE SET
           gateway_epoch = excluded.gateway_epoch,
           cursor = excluded.cursor,
           updated_at = excluded.updated_at`,
      this.deploymentId,
      gatewayEpoch,
      cursor,
      now,
    );
  }

  private key(row: StoredGatewayApproval): ApprovalKey {
    return {
      deploymentId: row.deployment_id,
      gatewayEpoch: row.gateway_epoch,
      approvalId: row.approval_id,
    };
  }
}

function cardQuestionId(gatewayEpoch: string, approvalId: string): string {
  const digest = createHash('sha256').update(gatewayEpoch).update('\0').update(approvalId).digest('hex').slice(0, 32);
  return `nanoco-ask-${digest}`;
}

function requireSameEvidence(row: StoredGatewayApproval, approval: GatewayApproval): void {
  const same =
    row.request_digest === approval.requestDigest &&
    row.request_id === approval.lineage.requestId &&
    row.deployment_id === approval.lineage.deploymentId &&
    row.agent_id === approval.lineage.agentId &&
    row.session_id === approval.lineage.sessionId &&
    row.container_instance_id === approval.lineage.containerInstanceId &&
    row.channel_id === approval.lineage.channelId &&
    row.deadline === approval.deadline &&
    row.approver_issuer === approval.approver.issuer &&
    row.approver_subject === approval.approver.subject &&
    row.policy_version === approval.policy.policyVersion &&
    row.matched_policy_ids_json === JSON.stringify(approval.policy.matchedPolicyIds) &&
    row.summary_method === approval.summary.method &&
    row.summary_origin === approval.summary.origin &&
    row.summary_path === approval.summary.path &&
    row.presentation_json === JSON.stringify(approval.presentation);
  if (!same) throw new Error('Gateway changed immutable approval evidence');
}

function expectedGatewayState(decision: ApprovalDecision | null): ApprovalTerminalState {
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  if (decision === 'unavailable') return 'cancelled';
  throw new Error('Gateway approval acknowledgement has no local decision');
}
