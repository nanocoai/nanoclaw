import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isResyncRequired,
  parseApprovalEvent,
  parseApprovalSnapshot,
  parseDecisionAcknowledgement,
} from './approval-contract.js';

const FIXTURE_DIR = path.resolve('fixtures/nanoco-approval-protocol/v2');
const SOURCE_REF = 'nanoco.approval.v2';
const FIXTURE_HASHES: Record<string, string> = {
  'approval-requested.json': 'd17da61ebb1b478c81b8816e1d08313028c90ac81f02d24799b833f45444f5ee',
  'approval-terminal.json': '1bcc73ddf8db7094cd979f76c31fd5ec84a130b8bfc672cea917aeb2c98ceb16',
  'decision-applied.json': '0c55006acb262640d4d4b5732a534965ddf7ad2541fdb43e73cc5d116a6de64f',
  'decision-approve.json': '1ca9b6385d057a5907028884ddb01bf9edf2734e44d0a1d549cf3ed69a05fdca',
  'decision-duplicate.json': '2a63bdf3c9a6b40b06be857adb3dfeda5e72f4c7b9c5fc6a6dd49f9468b53dcc',
  'decision-unavailable-applied.json': '444ef7262d9866987220d00fa0d4a87c0a3d511e0d34bc45e9e5333c2edb09d0',
  'decision-unavailable.json': '69096ddd644cc3f658f950642604179cad2a787dafec421457522947ba8c2c87',
  'resync-required.json': '9eef4ad5de505d87d4591589d89d58b1d675bb2f48c4d291577ce9b6d1c7362d',
  'snapshot.json': 'b484c8de93b38c57fe358b192df367be1541d0658b37f7f3f2d7dae50b786426',
};

describe(`Gateway approval fixtures for ${SOURCE_REF}`, () => {
  it('pins all nine frozen fixture bytes', () => {
    const files = fs.readdirSync(FIXTURE_DIR).sort();
    expect(files).toEqual(Object.keys(FIXTURE_HASHES).sort());
    for (const file of files) {
      const digest = createHash('sha256')
        .update(fs.readFileSync(path.join(FIXTURE_DIR, file)))
        .digest('hex');
      expect(digest, file).toBe(FIXTURE_HASHES[file]);
    }
  });

  it('parses the snapshot, both events, acknowledgements, and resync error', () => {
    expect(parseApprovalSnapshot(fixture('snapshot.json'), 'deployment-1').approvals).toHaveLength(1);
    expect(parseApprovalEvent(fixture('approval-requested.json'), 'deployment-1').type).toBe('approval_requested');
    expect(parseApprovalEvent(fixture('approval-terminal.json'), 'deployment-1').type).toBe('approval_terminal');
    expect(parseDecisionAcknowledgement(fixture('decision-applied.json')).state).toBe('approved');
    expect(parseDecisionAcknowledgement(fixture('decision-duplicate.json')).status).toBe('duplicate');
    expect(parseDecisionAcknowledgement(fixture('decision-unavailable-applied.json')).state).toBe('cancelled');
    expect(isResyncRequired(fixture('resync-required.json'))).toBe(true);
  });

  it('treats an explicit null presentation description as absent (network-class asks)', () => {
    // The Gateway spells Option::None as an explicit null on the wire. The
    // first network-class Ask this adapter ever received carried
    // "description": null, where every frozen fixture (operation-class)
    // carries a string — present-and-null was unrepresented, the strict parse
    // threw, and the adapter wedged in a code="contract" retry loop against a
    // healthy gateway. Null must parse as no-description.
    const event = structuredClone(fixture('approval-requested.json')) as {
      approval: { presentation: Record<string, unknown> };
    };
    event.approval.presentation.description = null;
    const parsed = parseApprovalEvent(event, 'deployment-1') as unknown as {
      type: string;
      approval: { presentation: Record<string, unknown> };
    };
    expect(parsed.type).toBe('approval_requested');
    expect('description' in parsed.approval.presentation).toBe(false);

    // Any other non-string value stays rejected — null is the one wire
    // spelling of "absent", not a general loosening.
    event.approval.presentation.description = 5;
    expect(() => parseApprovalEvent(event, 'deployment-1')).toThrow(/description is invalid/);
  });

  it('fails closed on another deployment, non-canonical UTC, or unknown fields', () => {
    const snapshot = fixture('snapshot.json') as Record<string, unknown>;
    expect(() => parseApprovalSnapshot(snapshot, 'deployment-2')).toThrow(/another deployment/);

    const badTime = structuredClone(snapshot) as { approvals: Array<{ deadline: string }> };
    badTime.approvals[0]!.deadline = '2026-07-23T00:00:00Z';
    expect(() => parseApprovalSnapshot(badTime, 'deployment-1')).toThrow(/canonical UTC/);

    const extra = { ...snapshot, callbackUrl: 'https://agent.invalid' };
    expect(() => parseApprovalSnapshot(extra, 'deployment-1')).toThrow(/fields are invalid/);
  });

  it('fails closed on presentation controls and unknown field shapes', () => {
    const snapshot = fixture('snapshot.json') as {
      approvals: Array<{
        presentation: {
          class: string;
          fields: Array<{ label: string; kind: string; value: string | string[]; extra?: boolean }>;
        };
      }>;
    };
    snapshot.approvals[0]!.presentation.fields[3]!.value = 'Visible\nmessage\u0085spoofed';
    expect(() => parseApprovalSnapshot(snapshot, 'deployment-1')).toThrow(/presentation field 3 value is invalid/);

    const unknown = fixture('snapshot.json') as typeof snapshot;
    unknown.approvals[0]!.presentation.fields[0]!.extra = true;
    expect(() => parseApprovalSnapshot(unknown, 'deployment-1')).toThrow(/fields are invalid/);

    const badClass = fixture('snapshot.json') as typeof snapshot;
    badClass.approvals[0]!.presentation.class = 'write\nspoofed';
    expect(() => parseApprovalSnapshot(badClass, 'deployment-1')).toThrow(/presentation class is invalid/);
  });

  it('accepts 50 projected list values plus one disclosure and rejects anything larger', () => {
    const withDisclosure = fixture('snapshot.json') as {
      approvals: Array<{ presentation: { fields: Array<{ label: string; kind: string; value: string[] }> } }>;
    };
    withDisclosure.approvals[0]!.presentation.fields[0] = {
      label: 'Messages',
      kind: 'list',
      value: [...Array.from({ length: 50 }, (_, index) => `message-${index + 1}`), '… and 950 more'],
    };
    expect(parseApprovalSnapshot(withDisclosure, 'deployment-1').approvals[0]!.presentation.fields[0]).toMatchObject({
      kind: 'list',
      value: expect.arrayContaining(['message-1', '… and 950 more']),
    });

    const missingDisclosure = structuredClone(withDisclosure);
    missingDisclosure.approvals[0]!.presentation.fields[0]!.value[50] = 'message-51';
    expect(() => parseApprovalSnapshot(missingDisclosure, 'deployment-1')).toThrow(
      /presentation field 0 kind is invalid/,
    );

    const oversized = structuredClone(withDisclosure);
    oversized.approvals[0]!.presentation.fields[0]!.value.splice(50, 0, 'message-51');
    expect(() => parseApprovalSnapshot(oversized, 'deployment-1')).toThrow(/presentation field 0 kind is invalid/);
  });

  it.each([
    ['origin user information', { origin: 'https://user:secret@api.example.com' }],
    ['origin path', { origin: 'https://api.example.com/private' }],
    ['origin query', { origin: 'https://api.example.com?token=secret' }],
    ['origin fragment', { origin: 'https://api.example.com#secret' }],
    ['origin control character', { origin: 'https://api.example.com\n.example.net' }],
    ['origin non-ASCII', { origin: 'https://idé.example.com' }],
    ['relative path', { path: 'v1/action' }],
    ['path query', { path: '/v1/action?token=secret' }],
    ['path fragment', { path: '/v1/action#secret' }],
    ['path control character', { path: '/v1/action\rspoofed' }],
    ['path space', { path: '/v1/private action' }],
    ['path non-ASCII', { path: '/v1/café' }],
    ['method separator', { method: 'POST /admin' }],
    ['method control character', { method: 'POST\nGET' }],
  ])('fails closed on unsafe summary %s', (_name, replacement) => {
    const snapshot = fixture('snapshot.json') as {
      approvals: Array<{ summary: { method: string; origin: string; path: string } }>;
    };
    Object.assign(snapshot.approvals[0]!.summary, replacement);
    expect(() => parseApprovalSnapshot(snapshot, 'deployment-1')).toThrow(/summary .* is invalid/);
  });

  it('accepts extension method tokens and preserves an explicit default port', () => {
    const snapshot = fixture('snapshot.json') as {
      approvals: Array<{ summary: { method: string; origin: string } }>;
    };
    snapshot.approvals[0]!.summary.method = 'CUSTOM-METHOD';
    snapshot.approvals[0]!.summary.origin = 'https://api.example.com:443';

    expect(parseApprovalSnapshot(snapshot, 'deployment-1').approvals[0]!.summary).toMatchObject({
      method: 'CUSTOM-METHOD',
      origin: 'https://api.example.com:443',
    });
  });

  it('matches the immutable approver principal boundaries', () => {
    const snapshot = fixture('snapshot.json') as {
      approvals: Array<{ approver: { issuer: string; subject: string } }>;
    };
    snapshot.approvals[0]!.approver.issuer = `https://${'a'.repeat(504)}`;
    snapshot.approvals[0]!.approver.subject = 'é'.repeat(128);
    expect(parseApprovalSnapshot(snapshot, 'deployment-1').approvals[0]!.approver).toEqual({
      issuer: `https://${'a'.repeat(504)}`,
      subject: 'é'.repeat(128),
    });

    snapshot.approvals[0]!.approver.issuer = `https://${'a'.repeat(505)}`;
    expect(() => parseApprovalSnapshot(snapshot, 'deployment-1')).toThrow(/approver issuer is invalid/);

    snapshot.approvals[0]!.approver.issuer = 'https://idp.example.com';
    snapshot.approvals[0]!.approver.subject = 'é'.repeat(129);
    expect(() => parseApprovalSnapshot(snapshot, 'deployment-1')).toThrow(/approver subject is invalid/);
  });

  it.each([
    ['insecure issuer', { issuer: 'http://idp.example.com' }],
    ['issuer space', { issuer: 'https://idp.example.com tenant' }],
    ['issuer control', { issuer: 'https://idp.example.com\nspoofed' }],
    ['issuer non-ASCII', { issuer: 'https://idé.example.com' }],
    ['subject control', { subject: 'subject\u0085spoofed' }],
  ])('rejects an invalid immutable approver %s', (_name, replacement) => {
    const snapshot = fixture('snapshot.json') as {
      approvals: Array<{ approver: { issuer: string; subject: string } }>;
    };
    Object.assign(snapshot.approvals[0]!.approver, replacement);
    expect(() => parseApprovalSnapshot(snapshot, 'deployment-1')).toThrow(/approver .* is invalid/);
  });

  it('matches the narrow approval, epoch, and lineage identifier formats', () => {
    const snapshot = fixture('snapshot.json') as {
      gatewayEpoch: string;
      approvals: Array<{
        approvalId: string;
        lineage: { agentId: string };
      }>;
    };
    snapshot.gatewayEpoch = 'E'.repeat(64);
    snapshot.approvals[0]!.approvalId = `ask_${'A'.repeat(32)}`;
    snapshot.approvals[0]!.lineage.agentId = 'a'.repeat(128);
    expect(parseApprovalSnapshot(snapshot, 'deployment-1')).toMatchObject({
      gatewayEpoch: 'E'.repeat(64),
      approvals: [{ approvalId: `ask_${'A'.repeat(32)}`, lineage: { agentId: 'a'.repeat(128) } }],
    });
  });

  it.each([
    ['approval ID length', { approvalId: 'ask_deadbeef' }],
    ['approval ID non-hex', { approvalId: `ask_${'g'.repeat(32)}` }],
    ['lineage length', { agentId: 'a'.repeat(129) }],
    ['lineage control', { agentId: 'agent\nspoofed' }],
    ['lineage separator', { agentId: 'agent/user' }],
  ])('rejects an invalid %s', (_name, replacement) => {
    const snapshot = fixture('snapshot.json') as {
      approvals: Array<{ approvalId: string; lineage: { agentId: string } }>;
    };
    if ('approvalId' in replacement) snapshot.approvals[0]!.approvalId = replacement.approvalId;
    if ('agentId' in replacement) snapshot.approvals[0]!.lineage.agentId = replacement.agentId;
    expect(() => parseApprovalSnapshot(snapshot, 'deployment-1')).toThrow(/is invalid/);
  });

  it.each(['E'.repeat(65), 'gw-epoch', 'gw_epoch\nspoofed'])('rejects an invalid Gateway epoch', (gatewayEpoch) => {
    const snapshot = fixture('snapshot.json') as { gatewayEpoch: string };
    snapshot.gatewayEpoch = gatewayEpoch;
    expect(() => parseApprovalSnapshot(snapshot, 'deployment-1')).toThrow(/gatewayEpoch is invalid/);
  });
});

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}
