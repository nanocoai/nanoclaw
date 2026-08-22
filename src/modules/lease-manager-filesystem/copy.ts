/** lease_fs_copy -- thin wrapper over ./write-ops.ts, kind='copy'. */
import type { Session } from '../../types.js';
import { applyWriteOp, requestWriteOpHold, validateWriteOp } from './write-ops.js';

export function validateLeaseFsCopy(content: Record<string, unknown>, session: Session): Promise<boolean> {
  return validateWriteOp('copy', content, session);
}
export function requestLeaseFsCopyHold(content: Record<string, unknown>, session: Session): Promise<void> {
  return requestWriteOpHold('copy', content, session);
}
export function applyLeaseFsCopy(payload: Record<string, unknown>, session: Session): Promise<void> {
  return applyWriteOp('copy', payload, session);
}
