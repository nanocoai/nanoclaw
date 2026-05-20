/** Split a migration-style script into individual statements (SeekDB runs one statement per execute). */
export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Convert better-sqlite3 @name placeholders to ? and ordered values for SeekdbClient.execute(). */
export function bindExecuteParams(sql: string, params: unknown[]): { sql: string; values: unknown[] } {
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const obj = params[0] as Record<string, unknown>;
    const names: string[] = [];
    const bound = sql.replace(/@(\w+)/g, (_match, name: string) => {
      names.push(name);
      return '?';
    });
    return { sql: bound, values: names.map((n) => obj[n]) };
  }
  return { sql, values: params };
}
