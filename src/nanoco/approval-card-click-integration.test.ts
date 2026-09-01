import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, expect, it, vi } from 'vitest';

import { resolveSelectedOption } from '../channels/chat-sdk-bridge.js';
import { resolveQuestionRender } from '../channels/question-render-registry.js';
import { closeDb, initDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import type { ApprovalDecision, ApprovalSnapshot, GatewayApproval } from './approval-contract.js';
import { APPROVAL_CARD_TITLE_LIMIT, APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT } from './approval-card-render.js';
import { GatewayApprovalCards } from './approval-cards.js';
import './approval-question-render.js';
import { GatewayApprovalStore } from './approval-store.js';
import type { GatewayApprovalTransport } from './approval-transport.js';
import { GatewayApprovalAdapter } from './gateway-approval-adapter.js';

const roots: string[] = [];

afterEach(async () => {
  await closeDb();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each([
  ['0', 'approve', 'short'],
  ['1', 'reject', 'ascii'],
  ['0', 'approve', 'cjk'],
  ['1', 'reject', 'emoji'],
] as const)('resolves persisted card index %s to %s after restart with a %s title', async (index, expectedDecision, titleVariant) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-approval-card-'));
  roots.push(root);
  const dbPath = path.join(root, 'v2.db');
  const firstDb = await initDb(dbPath, { role: 'test' });
  await runMigrations(firstDb);
  await firstDb.run(
    'INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
    'slack:approver-1',
    'slack',
    'Approver',
    new Date().toISOString(),
  );
  const firstStore = new GatewayApprovalStore(firstDb, 'deployment-1');
  await firstStore.replaceApproverBinding('https://idp.example.com', 'stable-idp-subject', 'slack:approver-1');
  const row = (await firstStore.reconcileSnapshot(snapshot(titleVariant)))[0]!;
  await firstStore.recordCardAddress(key(row), 'slack:approver-1', {
    channelType: 'slack',
    platformId: 'D-approver-1',
  });
  await firstStore.markCardAttempted(key(row));
  await firstStore.recordCardDelivered(key(row), 'message-1');
  await closeDb();

  // A new host process reconstructs callback values from SQLite rather than
  // an in-memory card/options map.
  const restartedDb = await initDb(dbPath, { role: 'test' });
  await runMigrations(restartedDb);
  const render = await resolveQuestionRender(row.card_question_id);
  const renderedQuestion = render?.question ?? '';
  expect(graphemes(render?.title ?? '').length).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_LIMIT);
  expect(Buffer.byteLength(render?.title ?? '')).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT);
  expect(renderedQuestion).toContain('*To*\n• alice@example.com');
  if (titleVariant !== 'short') {
    const { appLabel, title } = approvalTitle(titleVariant);
    const fullTitle = `${appLabel} · ${title}`;
    expect(render?.title).toMatch(/…$/);
    expect(renderedQuestion).toContain(`*Full approval title*\n${fullTitle}`);
    expect(renderedQuestion.match(/\*Full approval title\*/g)).toHaveLength(1);
  } else {
    expect(render?.title).toBe('Gmail · Send email');
    expect(renderedQuestion).not.toContain('*Full approval title*');
  }
  expect(render?.options.map((option) => option.value)).toEqual(['approve', 'reject']);
  const resolved = resolveSelectedOption(render, index, index);
  expect(resolved).toBe(expectedDecision);
  expect(`ncq:${row.card_question_id}:${index}`.length).toBeLessThanOrEqual(64);

  const restartedStore = new GatewayApprovalStore(restartedDb, 'deployment-1');
  const submitted: ApprovalDecision[] = [];
  const transport: GatewayApprovalTransport = {
    snapshot: async () => snapshot(titleVariant),
    events: async () => 'closed',
    submit: async (command) => {
      submitted.push(command.decision);
      return {
        status: 'acknowledged',
        acknowledgement: {
          version: 'nanoco.approval.v2',
          gatewayEpoch: command.gatewayEpoch,
          approvalId: command.approvalId,
          status: 'applied',
          state: command.decision === 'approve' ? 'approved' : 'rejected',
        },
      };
    },
  };
  const cards = new GatewayApprovalCards(restartedStore, {
    resolveBinding: restartedStore,
    resolveDm: async () => null,
    deliveryAdapter: () => null,
    decisionReady: vi.fn(),
  });
  const adapter = new GatewayApprovalAdapter(restartedStore, cards, transport);
  await adapter.handleClick({
    questionId: row.card_question_id,
    value: resolved,
    userId: 'approver-1',
    channelType: 'slack',
    platformId: '',
    threadId: null,
  });
  await vi.waitFor(() => expect(submitted).toEqual([expectedDecision]));
  expect(await restartedStore.get(key(row))).toMatchObject({ state: 'delivered', decision: expectedDecision });
  expect(await resolveQuestionRender(row.card_question_id)).toBeUndefined();
  await adapter.stop();
});

type TitleVariant = 'short' | 'ascii' | 'cjk' | 'emoji';

function snapshot(titleVariant: TitleVariant = 'short'): ApprovalSnapshot {
  return {
    version: 'nanoco.approval.v2',
    gatewayEpoch: 'gw_0123456789abcdef0123456789abcdef',
    cursor: 0,
    approvals: [approval(titleVariant)],
  };
}

function approval(titleVariant: TitleVariant = 'short'): GatewayApproval {
  const { appLabel, title } = approvalTitle(titleVariant);
  return {
    approvalId: 'ask_0123456789abcdef0123456789abcdef',
    requestDigest: '01'.repeat(32),
    deadline: '2099-07-23T00:00:00.000Z',
    lineage: {
      requestId: 77,
      deploymentId: 'deployment-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      containerInstanceId: 'container-1',
      channelId: 'channel-1',
    },
    approver: { issuer: 'https://idp.example.com', subject: 'stable-idp-subject' },
    policy: { policyVersion: 'policy-v7', matchedPolicyIds: ['ask-production'] },
    summary: {
      method: 'POST',
      origin: 'https://api.example.com:443',
      path: '/v1/action',
    },
    presentation: {
      appId: 'gmail',
      appLabel,
      operationId: 'gmail:send-email',
      title,
      class: 'write',
      fields: [{ label: 'To', kind: 'list', value: ['alice@example.com'] }],
    },
  };
}

function approvalTitle(titleVariant: TitleVariant): { appLabel: string; title: string } {
  if (titleVariant === 'ascii') return { appLabel: 'A'.repeat(256), title: 'T'.repeat(256) };
  if (titleVariant === 'cjk') return { appLabel: '漢'.repeat(85), title: '語'.repeat(85) };
  if (titleVariant === 'emoji') return { appLabel: '👩🏽‍💻'.repeat(17), title: '👨‍👩‍👧‍👦'.repeat(10) };
  return { appLabel: 'Gmail', title: 'Send email' };
}

function graphemes(value: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), ({ segment }) => segment);
}

function key(row: { deployment_id: string; gateway_epoch: string; approval_id: string }) {
  return {
    deploymentId: row.deployment_id,
    gatewayEpoch: row.gateway_epoch,
    approvalId: row.approval_id,
  };
}
