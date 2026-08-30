import { sanitizeParams } from './params.js';

export interface RewrittenSql {
  text: string;
  values: Array<string | number | null>;
}

function isNamedParams(params: readonly unknown[]): params is [Record<string, unknown>] {
  if (params.length !== 1 || typeof params[0] !== 'object' || params[0] === null) return false;
  const prototype = Object.getPrototypeOf(params[0]);
  return prototype === Object.prototype || prototype === null;
}

function quotedEnd(sql: string, start: number, quote: "'" | '"'): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index++;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}

function dollarQuote(sql: string, start: number): string | null {
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(start));
  return match?.[0] ?? null;
}

/** Rewrite NanoClaw's portable ? / @name placeholders without touching SQL literals. */
export function rewriteSql(sql: string, params: readonly unknown[]): RewrittenSql {
  const named = isNamedParams(params) ? params[0] : null;
  const namedIndexes = new Map<string, number>();
  const values: unknown[] = [];
  let text = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      const end = quotedEnd(sql, index, char);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index + 2);
      const next = end === -1 ? sql.length : end + 1;
      text += sql.slice(index, next);
      index = next;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      const next = end === -1 ? sql.length : end + 2;
      text += sql.slice(index, next);
      index = next;
      continue;
    }
    if (char === '$') {
      const delimiter = dollarQuote(sql, index);
      if (delimiter) {
        const end = sql.indexOf(delimiter, index + delimiter.length);
        const next = end === -1 ? sql.length : end + delimiter.length;
        text += sql.slice(index, next);
        index = next;
        continue;
      }
    }
    if (char === '?') {
      if (named) throw new Error('Cannot use positional ? placeholders with a named parameter object');
      if (values.length >= params.length) throw new Error(`Missing positional parameter ${values.length + 1}`);
      values.push(params[values.length]);
      text += `$${values.length}`;
      index++;
      continue;
    }
    if (char === '@' && /[A-Za-z_]/.test(sql[index + 1] ?? '')) {
      if (!named) throw new Error('Named @param placeholders require one parameter object');
      let end = index + 2;
      while (/[A-Za-z0-9_]/.test(sql[end] ?? '')) end++;
      const name = sql.slice(index + 1, end);
      if (!Object.hasOwn(named, name)) throw new Error(`Missing named parameter "${name}"`);
      let position = namedIndexes.get(name);
      if (position === undefined) {
        values.push(named[name]);
        position = values.length;
        namedIndexes.set(name, position);
      }
      text += `$${position}`;
      index = end;
      continue;
    }
    text += char;
    index++;
  }

  if (!named && values.length !== params.length) {
    throw new Error(`Expected ${values.length} positional parameters, received ${params.length}`);
  }
  return { text, values: sanitizeParams(values) };
}
