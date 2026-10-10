/** True when a statement failed because a unique/primary-key constraint won. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  if (
    code === '23505' ||
    code.startsWith('SQLITE_CONSTRAINT_UNIQUE') ||
    code.startsWith('SQLITE_CONSTRAINT_PRIMARYKEY')
  ) {
    return true;
  }
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
