/** Audit configuration owned by add-audit-log. */
import { readEnvFile } from '../env.js';

const envConfig = readEnvFile([
  'AUDIT_ENABLED',
  'AUDIT_RETENTION_HOURS',
  'NANOCO_DEPLOYMENT_ID',
  'NANOCO_HOST_AUDIT_URL',
  'NANOCO_HOST_AUDIT_BEARER_TOKEN_FILE',
  'NANOCO_HOST_AUDIT_TLS_CERT',
  'NANOCO_HOST_AUDIT_TLS_KEY',
  'NANOCO_HOST_AUDIT_TLS_CA',
  'NANOCO_HOST_AUDIT_PSEUDONYM_KEY_FILE',
]);

export const AUDIT_ENABLED = (process.env.AUDIT_ENABLED || envConfig.AUDIT_ENABLED) === 'true';
const MAX_AUDIT_RETENTION_HOURS = 10_000_000;

export function parseRetentionHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 12;
  if (!/^(0|[1-9]\d*)$/.test(raw.trim())) return 12;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n <= MAX_AUDIT_RETENTION_HOURS ? n : 12;
}

/** Acknowledged operational-copy horizon. Unacknowledged rows are never pruned. */
export const AUDIT_RETENTION_HOURS = parseRetentionHours(
  process.env.AUDIT_RETENTION_HOURS || envConfig.AUDIT_RETENTION_HOURS,
);

/** Stable producer identity; deployment enrollment supplies this exact value. */
export const AUDIT_HOST_ID = process.env.NANOCO_DEPLOYMENT_ID || envConfig.NANOCO_DEPLOYMENT_ID || '';

/** Governance drain configuration. Empty URL keeps local-only evidence behavior. */
export const HOST_AUDIT_GOVERNANCE_URL =
  process.env.NANOCO_HOST_AUDIT_URL || envConfig.NANOCO_HOST_AUDIT_URL || '';
export const HOST_AUDIT_BEARER_TOKEN_FILE =
  process.env.NANOCO_HOST_AUDIT_BEARER_TOKEN_FILE || envConfig.NANOCO_HOST_AUDIT_BEARER_TOKEN_FILE || '';
export const HOST_AUDIT_TLS_CERT = process.env.NANOCO_HOST_AUDIT_TLS_CERT || envConfig.NANOCO_HOST_AUDIT_TLS_CERT || '';
export const HOST_AUDIT_TLS_KEY = process.env.NANOCO_HOST_AUDIT_TLS_KEY || envConfig.NANOCO_HOST_AUDIT_TLS_KEY || '';
export const HOST_AUDIT_TLS_CA = process.env.NANOCO_HOST_AUDIT_TLS_CA || envConfig.NANOCO_HOST_AUDIT_TLS_CA || '';
export const HOST_AUDIT_PSEUDONYM_KEY_FILE =
  process.env.NANOCO_HOST_AUDIT_PSEUDONYM_KEY_FILE || envConfig.NANOCO_HOST_AUDIT_PSEUDONYM_KEY_FILE || '';
