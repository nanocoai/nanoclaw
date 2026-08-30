import { getDb } from '../../db/index.js';
import { register } from '../registry.js';

const MAX_ISSUER_LENGTH = 512;
const MAX_SUBJECT_LENGTH = 256;
const MAX_USER_ID_LENGTH = 512;
const CONTROL_CHARACTER = /\p{Cc}/u;

interface BindingArgs {
  issuer: string;
  subject: string;
  userId: string;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

register<BindingArgs, { bound: true; user_id: string }>({
  name: 'nanoco-approver-bindings-set',
  description:
    'Bind one immutable IdP approver principal to one existing local delivery user.',
  access: 'hidden',
  hostOnly: true,
  parseArgs: (raw) => {
    if (typeof raw.spec !== 'string') {
      throw new Error('--binding-stdin is required');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.spec);
    } catch {
      throw new Error('approver binding spec is invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('approver binding spec must be an object');
    }
    const object = parsed as Record<string, unknown>;
    if (
      Object.keys(object).some(
        (key) => !['issuer', 'subject', 'user_id'].includes(key),
      )
    ) {
      throw new Error('approver binding spec contains unknown fields');
    }

    const issuer = requiredString(object.issuer, 'issuer', MAX_ISSUER_LENGTH);
    if (!/^https:\/\/[\x21-\x7e]+$/.test(issuer)) {
      throw new Error('issuer must be a canonical HTTPS issuer');
    }
    return {
      issuer,
      subject: requiredString(object.subject, 'subject', MAX_SUBJECT_LENGTH),
      userId: requiredString(object.user_id, 'user_id', MAX_USER_ID_LENGTH),
    };
  },
  handler: async ({ issuer, subject, userId }) => {
    const db = getDb();
    const user = await db.get('SELECT id FROM users WHERE id = ?', userId);
    if (!user) throw new Error('approver delivery user does not exist');

    await db.transaction(async () => {
      await db.run('DELETE FROM nanoco_approver_bindings WHERE issuer = ? AND subject = ?', issuer, subject);
      await db.run(
        `INSERT INTO nanoco_approver_bindings (issuer, subject, user_id, created_at)
         VALUES (?, ?, ?, ?)`,
        issuer,
        subject,
        userId,
        new Date().toISOString(),
      );
    });

    return { bound: true, user_id: userId };
  },
});
