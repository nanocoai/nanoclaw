export function sanitizeParam(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.replaceAll('\0', '');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('PostgreSQL parameters must be finite numbers');
    return value;
  }
  if (value instanceof Date) throw new TypeError('PostgreSQL parameters must use ISO timestamp strings, not Date');
  if (typeof value === 'boolean') throw new TypeError('PostgreSQL parameters must encode booleans as domain integers');
  throw new TypeError(`Unsupported PostgreSQL parameter type: ${typeof value}`);
}

export function sanitizeParams(values: readonly unknown[]): Array<string | number | null> {
  return values.map(sanitizeParam);
}
