import type { S3MailboxOptions } from './store.js';
import { readEnvFile } from '../../env.js';

const KEYS = [
  'NANOCLAW_MAILBOX_S3_ENDPOINT',
  'NANOCLAW_MAILBOX_S3_BUCKET',
  'NANOCLAW_MAILBOX_S3_PREFIX',
  'NANOCLAW_MAILBOX_S3_REGION',
] as const;

export function loadS3MailboxConfig(
  env: Record<string, string | undefined> = process.env,
  file: Record<string, string | undefined> = readEnvFile([...KEYS]),
): S3MailboxOptions {
  const endpoint = required(env, file, 'NANOCLAW_MAILBOX_S3_ENDPOINT');
  return {
    endpoint,
    runnerEndpoint: endpoint,
    bucket: required(env, file, 'NANOCLAW_MAILBOX_S3_BUCKET'),
    prefix: required(env, file, 'NANOCLAW_MAILBOX_S3_PREFIX'),
    region: required(env, file, 'NANOCLAW_MAILBOX_S3_REGION'),
  };
}

function required(
  env: Record<string, string | undefined>,
  file: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim() || file[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
