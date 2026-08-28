/** lease_fs_move -- thin wrapper over ./write-ops.ts, kind='move'. */
import type { Session } from '../../types.js';
import { applyWriteOp, requestWriteOpHold, validateWriteOp } from './write-ops.js';

export function validateLeaseFsMove(content: Record<string, unknown>, session: Session): Promise<boolean> {
  return validateWriteOp('move', content, session);
}
export function requestLeaseFsMoveHold(content: Record<string, unknown>, session: Session): Promise<void> {
  return requestWriteOpHold('move', content, session);
}
export function applyLeaseFsMove(payload: Record<string, unknown>, session: Session): Promise<void> {
  return applyWriteOp('move', payload, session);
}
