import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { adoptGovernanceAgentId, type GovernanceAgentIdCarrier } from './governance-agent-id.js';

const UUID = 'b8a1c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('adoptGovernanceAgentId', () => {
  it('adopts a bare crypto.randomUUID() verbatim as the group id', () => {
    const spec: GovernanceAgentIdCarrier = { agentId: UUID };
    adoptGovernanceAgentId(spec);
    expect(spec.id).toBe(UUID);
  });

  it('is a no-op when agentId is absent (host-minted path unchanged)', () => {
    const withId: GovernanceAgentIdCarrier = { id: 'ag-legacy' };
    adoptGovernanceAgentId(withId);
    expect(withId.id).toBe('ag-legacy');
    expect(withId.agentId).toBeUndefined();

    const empty: GovernanceAgentIdCarrier = {};
    adoptGovernanceAgentId(empty);
    expect(empty.id).toBeUndefined();
  });

  it('accepts agentId alongside an identical id', () => {
    const spec: GovernanceAgentIdCarrier = { id: UUID, agentId: UUID };
    adoptGovernanceAgentId(spec);
    expect(spec.id).toBe(UUID);
  });

  it('rejects a conflicting id + agentId pair', () => {
    const spec: GovernanceAgentIdCarrier = { id: 'ag-other', agentId: UUID };
    expect(() => adoptGovernanceAgentId(spec)).toThrow(/conflicts with --spec\.id/);
  });

  it('rejects empty, whitespace, and non-string agentIds', () => {
    for (const agentId of ['', '   ', ` ${UUID}`, `${UUID} `, 42, null] as unknown[]) {
      const spec = { agentId } as GovernanceAgentIdCarrier;
      expect(() => adoptGovernanceAgentId(spec), JSON.stringify(agentId)).toThrow(/--spec\.agentId/);
    }
  });

  it('rejects ids that are not a safe single path segment (they name session dirs)', () => {
    for (const agentId of ['../escape', 'a/b', 'a\\b', '.hidden', '-lead', 'a\nb', 'a b']) {
      const spec: GovernanceAgentIdCarrier = { agentId };
      expect(() => adoptGovernanceAgentId(spec), JSON.stringify(agentId)).toThrow(/safe single path segment/);
    }
  });

  it('rejects over-long ids', () => {
    const spec: GovernanceAgentIdCarrier = { agentId: 'a'.repeat(129) };
    expect(() => adoptGovernanceAgentId(spec)).toThrow(/exceeds 128/);
  });
});

// Structural guards over the two nc:edit reach-ins — red if either edit is
// removed or drifts (skill-guidelines: every functional reach-in gets a guard).
// Same precedent as template-provisioning's structural assert on the client's
// stdin call: the seam is not invocable hermetically, so assert the source.
describe('governance-agent-id wiring', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);

  it('createAgentFromSpec adopts the governance agent id BEFORE validating the spec', () => {
    const src = fs.readFileSync(path.join(here, 'create-from-spec.ts'), 'utf8');
    const adoptAt = src.indexOf('adoptGovernanceAgentId(spec);');
    const validateAt = src.indexOf('validateAgentCreateSpec(spec);');
    expect(adoptAt, 'adoptGovernanceAgentId call missing from create-from-spec.ts').toBeGreaterThan(-1);
    expect(validateAt).toBeGreaterThan(-1);
    expect(adoptAt, 'adoption must precede structural validation').toBeLessThan(validateAt);
  });

  it('AgentCreateSpec declares the optional agentId field', () => {
    const src = fs.readFileSync(path.join(here, 'create-spec.ts'), 'utf8');
    expect(src).toMatch(/agentId\?: string;/);
  });
});
