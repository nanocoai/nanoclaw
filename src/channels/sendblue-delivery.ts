/** Sendblue has no idempotency key: an ambiguous POST must not be replayed. */
export class SendblueDeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SendblueDeliveryError';
  }
}

/** Called by the delivery catch boundary installed by /add-sendblue. */
export function isTerminalSendblueDeliveryError(error: unknown): boolean {
  return error instanceof SendblueDeliveryError;
}
