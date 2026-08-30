/** Per-installation keyed pseudonyms for accountable human identities. */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';

import { isHostAuditResourceRef, type AuditEventInput, type HostAuditResourceRef } from './types.js';

const KEY_BYTES = 32;
// One person domain intentionally makes actor and user-resource observations
// joinable without retaining the source identity. The wire prefixes remain
// distinct so actor IDs and structural resource refs stay unambiguous.
const PERSON_DOMAIN = 'nanoco.host-audit.pseudonym.human.v1';
let activeKey: Buffer | null = null;

function framed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  return Buffer.concat([length, bytes]);
}

function pseudonym(key: Buffer, domain: string, value: string): string {
  if (key.byteLength !== KEY_BYTES) throw new Error('Host audit pseudonym key must be exactly 32 bytes');
  return createHmac('sha256', key)
    .update(framed(domain))
    .update(framed(value))
    .digest('hex');
}

export function pseudonymizeAuditInputWithKey(input: AuditEventInput, key: Buffer): AuditEventInput {
  if (key.byteLength !== KEY_BYTES) throw new Error('Host audit pseudonym key must be exactly 32 bytes');
  let actor = input.actor;
  if (actor?.type === 'human') {
    if (actor.id.length < 1 || actor.id.length > 256 || /[\u0000-\u001f\u007f]/.test(actor.id)) {
      throw new Error('invalid structural actor.id');
    }
    actor = { ...actor, id: `hmac:${pseudonym(key, PERSON_DOMAIN, actor.id)}` };
  }
  const refs = input.dimensions?.resource_refs?.map((ref): HostAuditResourceRef => {
    if (!ref.startsWith('user:') || !isHostAuditResourceRef(ref)) return ref;
    return `user:hmac:${pseudonym(key, PERSON_DOMAIN, ref.slice('user:'.length))}`;
  });
  return {
    ...input,
    actor,
    ...(input.dimensions
      ? { dimensions: { ...input.dimensions, ...(refs ? { resource_refs: refs } : {}) } }
      : {}),
  };
}

export function loadAuditPseudonymKey(file: string): Buffer {
  if (!file) throw new Error('NANOCO_HOST_AUDIT_PSEUDONYM_KEY_FILE is required when Host audit is enabled');
  let stat: fs.Stats;
  let value: string;
  try {
    stat = fs.statSync(file);
    value = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new Error('unable to read Host audit pseudonym key file', { cause: error });
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error('Host audit pseudonym key file must be a regular mode-0600 file');
  }
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Host audit pseudonym key file must contain exactly 32 lowercase-hex bytes');
  }
  return Buffer.from(value, 'hex');
}

export function initializeAuditPseudonymizer(file: string): void {
  activeKey = loadAuditPseudonymKey(file);
}

export function pseudonymizeAuditInput(input: AuditEventInput): AuditEventInput {
  if (!activeKey) throw new Error('Host audit pseudonymizer is not initialized');
  return pseudonymizeAuditInputWithKey(input, activeKey);
}
