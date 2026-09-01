/** Shared validation for privacy-safe structural values at audit mapper seams. */

import {
  HOST_AUDIT_ACTION_RE,
  HOST_AUDIT_ARG_NAME_RE,
  HOST_AUDIT_OPAQUE_ID_RE,
  HOST_AUDIT_TOKEN_RE,
} from './types.js';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function structuralId(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 256 && HOST_AUDIT_OPAQUE_ID_RE.test(value) ? value : null;
}

export function structuralAction(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 128 && HOST_AUDIT_ACTION_RE.test(value) ? value : null;
}

export function structuralArgName(value: unknown): string | null {
  return typeof value === 'string' && HOST_AUDIT_ARG_NAME_RE.test(value) ? value : null;
}

export function structuralToken(value: unknown): string | null {
  return typeof value === 'string' && HOST_AUDIT_TOKEN_RE.test(value) ? value : null;
}

export function isSkillName(value: unknown): value is string {
  return typeof value === 'string' && SKILL_NAME_RE.test(value);
}
