import { describe, expect, test } from 'vitest';

import { S3AgentMailbox, type SignedFetch } from './store.js';

describe('parent-bound Host request capability', () => {
  test('writes the parent-minted capability into a new child session control object', async () => {
    const capability = 'd'.repeat(64);
    let created = '';
    const client: SignedFetch = {
      async fetch(_input, init = {}) {
        if (!init.method || init.method === 'GET') return new Response('', { status: 404 });
        if (init.method === 'PUT') {
          created = String(init.body);
          return new Response('', { status: 200, headers: { etag: '"v1"' } });
        }
        throw new Error(`unexpected method ${init.method}`);
      },
    };
    const mailbox = new S3AgentMailbox({
      endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'mailbox', prefix: 'install/nanoclaw/children/env',
      region: 'us-east-1', initialCapability: capability,
    }, client);
    const context = await mailbox.runnerContext({ agentGroupId: 'child-agent', sessionId: 'child-session' });
    expect(context).toEqual({ capability });
    expect(JSON.parse(created)).toEqual({ capability });
  });

  test('lists through the parent-authorized child root and keeps only the requested session', async () => {
    const capability = 'e'.repeat(64);
    const requested = { agentGroupId: 'child-agent', sessionId: 'child-session' };
    const listPrefixes: string[] = [];
    const client: SignedFetch = {
      async fetch(input, init = {}) {
        const url = new URL(input);
        if (url.searchParams.get('list-type') === '2') {
          listPrefixes.push(url.searchParams.get('prefix') ?? '');
          const sibling = [
            'install/nanoclaw/children/devenv-env/v2/agent-groups/sibling-agent',
            'sessions/sibling-session/capabilities', capability,
            'inbound/messages/foreign.json',
          ].join('/');
          return new Response(
            `<ListBucketResult><Contents><Key>${sibling}</Key><ETag>&quot;v1&quot;</ETag></Contents></ListBucketResult>`,
            { status: 200 },
          );
        }
        if (!init.method || init.method === 'GET') return new Response('', { status: 404 });
        if (init.method === 'PUT') return new Response('', { status: 200, headers: { etag: '"v1"' } });
        throw new Error(`unexpected method ${init.method}`);
      },
    };
    const mailbox = new S3AgentMailbox({
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      bucket: 'mailbox',
      prefix: 'install/nanoclaw/children/devenv-env',
      region: 'us-east-1',
      initialCapability: capability,
      delegatedListPrefix: 'install/nanoclaw/children/devenv-env/v2/agent-groups',
    }, client);

    await mailbox.runnerContext(requested);
    await mailbox.session(requested, async () => {});

    expect(listPrefixes).toEqual([
      'install/nanoclaw/children/devenv-env/v2/agent-groups/',
      'install/nanoclaw/children/devenv-env/v2/agent-groups/',
    ]);
  });
});
