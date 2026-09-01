/** Validate the opaque capability minted by the registered Host mailbox. */
export function validateRequestCapability(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('request capability is not a 256-bit lowercase hex value');
  }
  return value;
}

/** SQLite has no capability; S3 returns one under its runner-context seam. */
export function requestCapabilityFromContext(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const capability = (value as { capability?: unknown }).capability;
  return capability === undefined ? undefined : validateRequestCapability(capability);
}
