/**
 * Host-side reasons a message cannot reach its destination, as opposed to an
 * error the channel adapter or platform raised. Thrown by the delivery path so
 * the failure notice can name a fixed category instead of remote error text.
 */
export type DeliveryTargetReason = 'not_connected' | 'not_authorised';

export class DeliveryTargetError extends Error {
  constructor(
    readonly reason: DeliveryTargetReason,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryTargetError';
  }
}
