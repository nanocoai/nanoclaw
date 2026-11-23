/** Errors raised by the portal client carry the portal's error code and HTTP status when known. */
export interface PortalError extends Error {
  code?: string;
  status?: number;
}

export function portalError(message: string, code?: string, status?: number): PortalError {
  return Object.assign(new Error(message), { ...(code ? { code } : {}), ...(status ? { status } : {}) });
}

export function errorCode(error: unknown, fallback = 'unavailable'): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : fallback;
}

export function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function isErrno(error: unknown, code: string): boolean {
  return errorCode(error, '') === code;
}
