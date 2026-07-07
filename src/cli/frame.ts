/**
 * Wire format shared between the socket transport (host caller) and — when
 * it lands — the DB transport (container agent caller).
 *
 * Same JSON whether it goes over a socket as a line or sits in a
 * `frame_json TEXT` column on a session DB. Caller identity is NOT carried
 * in the frame — it's filled in by whichever server-side adapter received
 * the bytes (see CallerContext).
 */

export type RequestFrame = {
  /** Correlation key set by the client. */
  id: string;
  /** Registry name, e.g. "groups-list". */
  command: string;
  /** Command-specific. Each command's parseArgs validates. */
  args: Record<string, unknown>;
};

export type ResponseFrame =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: ErrorCode; message: string } };

export type ErrorCode =
  | 'unknown-command'
  | 'invalid-args'
  | 'forbidden'
  | 'approval-pending'
  | 'handler-error'
  | 'transport-error';

/**
 * Filled in by the transport adapter on the server side. Handlers read
 * caller identity from here, never from the frame.
 */
export type CallerContext =
  | { caller: 'host' }
  | {
      caller: 'agent';
      sessionId: string;
      agentGroupId: string;
      messagingGroupId: string;
    };
