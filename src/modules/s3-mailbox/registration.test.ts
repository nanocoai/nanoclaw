import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import '../../mailbox/compose.js';
import { getAgentMailbox } from '../../mailbox/index.js';
import { loadS3MailboxConfig } from './config.js';
import { S3AgentMailbox } from './store.js';

const ENV = {
  NANOCLAW_MAILBOX_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
  NANOCLAW_MAILBOX_S3_BUCKET: 'nanoco-preview-mailbox',
  NANOCLAW_MAILBOX_S3_PREFIX: 'nanoco-k8s-kata/nanoclaw',
  NANOCLAW_MAILBOX_S3_REGION: 'us-east-1',
} as const;

describe('role-backed S3 mailbox Host registration', () => {
  beforeAll(() => {
    for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
  });

  afterAll(() => {
    for (const name of Object.keys(ENV)) delete process.env[name];
  });

  it('installs the real mailbox and projects only coordinates to the runner', async () => {
    const mailbox = getAgentMailbox();
    expect(mailbox).toBeInstanceOf(S3AgentMailbox);
    await expect(
      mailbox.runnerEnvironment({ agentGroupId: 'agent', sessionId: 'session' }),
    ).resolves.toEqual({
      NANOCLAW_MAILBOX_S3_ENDPOINT: ENV.NANOCLAW_MAILBOX_S3_ENDPOINT,
      NANOCLAW_MAILBOX_S3_BUCKET: ENV.NANOCLAW_MAILBOX_S3_BUCKET,
      NANOCLAW_MAILBOX_S3_PREFIX: ENV.NANOCLAW_MAILBOX_S3_PREFIX,
      NANOCLAW_MAILBOX_S3_REGION: ENV.NANOCLAW_MAILBOX_S3_REGION,
    });
  });

  it('reads Host coordinates from .env while process env wins', () => {
    expect(loadS3MailboxConfig({}, ENV)).toMatchObject({
      endpoint: ENV.NANOCLAW_MAILBOX_S3_ENDPOINT,
      bucket: ENV.NANOCLAW_MAILBOX_S3_BUCKET,
      prefix: ENV.NANOCLAW_MAILBOX_S3_PREFIX,
      region: ENV.NANOCLAW_MAILBOX_S3_REGION,
    });
    expect(loadS3MailboxConfig({ NANOCLAW_MAILBOX_S3_PREFIX: 'override' }, ENV).prefix).toBe('override');
  });
});
