import type { S3MailboxOptions } from './store.js';

export function loadS3MailboxConfig(env: Record<string, string | undefined> = process.env): S3MailboxOptions {
  return {
    endpoint: required(env, 'NANOCLAW_MAILBOX_S3_ENDPOINT'),
    bucket: required(env, 'NANOCLAW_MAILBOX_S3_BUCKET'),
    prefix: required(env, 'NANOCLAW_MAILBOX_S3_PREFIX'),
    region: required(env, 'NANOCLAW_MAILBOX_S3_REGION'),
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
