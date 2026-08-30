import assert from 'node:assert/strict';
import test from 'node:test';

import { withoutAppCeiling } from './nanoco-template-policy-overlay.mjs';

test('removes the whole app ceiling — including its scope-level approval markers — and nothing else', () => {
  // The apps block deliberately carries approval:"required" markers: the real
  // governed templates hold 31 of them, and removing the block removes the
  // markers with it. That loss is intended (retired contract; Governance's
  // ruleset rejects a `scopes` key) — this fixture makes it visible so a future
  // schema where scope approvals ARE parsed fails here instead of silently.
  const policy = {
    tools: { mcp_servers: [], cli_scope: 'group' },
    approvals: { capabilities: [{ action: 'install_packages' }] },
    apps: {
      connections: [
        {
          name: 'gmail',
          scopes: [{ name: 'email:read' }, { name: 'email:send', approval: 'required' }],
        },
        {
          name: 'github',
          scopes: [{ name: 'repo:push', approval: 'required' }],
        },
      ],
    },
    network: { egress: [{ domain: 'api.github.com' }] },
  };

  const rewritten = withoutAppCeiling(policy);
  assert.deepEqual(rewritten, {
    tools: policy.tools,
    approvals: policy.approvals,
    network: policy.network,
  });
  assert.equal(JSON.stringify(rewritten).includes('approval": "required'), false);
  assert.deepEqual(rewritten.approvals, { capabilities: [{ action: 'install_packages' }] });
  assert.equal(policy.apps.connections[0].scopes[1].approval, 'required');
});

test('is idempotent when the template already has no app ceiling', () => {
  const policy = { tools: {}, approvals: {}, network: { egress: [] } };
  assert.deepEqual(withoutAppCeiling(withoutAppCeiling(policy)), policy);
});
