import { getAgentMailbox } from '../mailbox/index.js';

export function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  getAgentMailbox().operations.setContainerToolInFlight(tool, declaredTimeoutMs);
}

export function clearContainerToolInFlight(): void {
  getAgentMailbox().operations.clearContainerToolInFlight();
}

export function markContainerTurn(turn: 'working' | 'idle'): void {
  getAgentMailbox().operations.markContainerTurn(turn);
}

export function clearStaleProcessingAcks(): void {
  getAgentMailbox().operations.clearStaleProcessingAcks();
}
