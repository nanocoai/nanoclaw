import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import '../index.js';
import { getAgentMailbox } from '../../mailbox/index.js';
import { loadS3MailboxConfig } from './config.js';
import { S3AgentMailbox } from './store.js';

const env = {
  HTTPS_PROXY: 'http://127.0.0.1:15001',
  NANOCLAW_MAILBOX_S3_BUCKET: 'agent-mailbox',
  NANOCLAW_MAILBOX_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
  NANOCLAW_MAILBOX_S3_PREFIX: 'nanoclaw',
  NANOCLAW_MAILBOX_S3_REGION: 'us-east-1',
};
let previous: Record<string, string | undefined>;

beforeEach(() => {
  previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
});

afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('s3 agent mailbox registration', () => {
  test('is installed by the real mailbox composition', () => {
    expect(getAgentMailbox()).toBeInstanceOf(S3AgentMailbox);
  });

  test('reads the projected mailbox coordinates', () => {
    expect(loadS3MailboxConfig()).toEqual({
      endpoint: env.NANOCLAW_MAILBOX_S3_ENDPOINT,
      bucket: env.NANOCLAW_MAILBOX_S3_BUCKET,
      prefix: env.NANOCLAW_MAILBOX_S3_PREFIX,
      region: env.NANOCLAW_MAILBOX_S3_REGION,
    });

    delete process.env.NANOCLAW_MAILBOX_S3_BUCKET;
    expect(() => loadS3MailboxConfig()).toThrow('missing NANOCLAW_MAILBOX_S3_BUCKET');
  });

});
