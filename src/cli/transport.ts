/**
 * Client-side transport interface. The `ncl` binary picks one of these and
 * calls sendFrame; the caller doesn't know whether bytes traveled over a
 * Unix socket (host) or through outbound.db / inbound.db rows (container).
 */
import type { RequestFrame, ResponseFrame } from './frame.js';

export interface Transport {
  sendFrame(req: RequestFrame): Promise<ResponseFrame>;
}
