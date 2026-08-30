import { describe, expect, it } from 'vitest';

import { roleBackedS3Fetch } from './role-fetch.js';

describe('role-backed S3 mailbox Host transport', () => {
  it('resolves the workload identity lazily and signs through the owned client', async () => {
    const credentials = {
      accessKeyId: 'temporary-access',
      secretAccessKey: 'temporary-secret',
      sessionToken: 'temporary-session',
    };
    let resolved = 0;
    let received: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    } | undefined;
    const response = new Response(null, { status: 204 });
    const transport = roleBackedS3Fetch(
      'us-east-1',
      async () => {
        resolved += 1;
        return credentials;
      },
      (value) => {
        received = value;
        return { fetch: async () => response };
      },
    );

    expect(resolved).toBe(0);
    await expect(transport.fetch('https://example-bucket.s3.us-east-1.amazonaws.com/key')).resolves.toBe(response);
    expect(resolved).toBe(1);
    expect(received).toEqual(credentials);
  });
});
