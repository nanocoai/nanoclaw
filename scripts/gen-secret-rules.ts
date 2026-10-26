// Builds src/secret-rules.generated.ts from gitleaks' default rule list
// (config/gitleaks.toml) at a pinned commit, plus the sample fixture the tests
// replay from the true- and false-positive examples in gitleaks' rule sources.
// Downloads go to a new temp folder, must match the pinned sha256s, and are
// only parsed as data. Bumping gitleaks: change the commit and both hashes.
//
//   pnpm run secret-rules:generate   rewrite both files
//   pnpm run secret-rules:check      fail when they differ from a fresh build

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as prettier from 'prettier';

export const GITLEAKS_TAG = 'v8.30.1';
const GITLEAKS_COMMIT = '83d9cd684c87d95d656c1458ef04895a7f1cbd8e';
const CONFIG_PATH = 'config/gitleaks.toml';
const CONFIG_SHA256 = 'e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf';
const RULES_DIR = 'cmd/generate/config/rules/';
const SAMPLE_HELPER = 'cmd/generate/config/utils/generate.go';
// Over LICENSE, the sample helper and every rule source, sorted by path: path NUL content NUL.
const SOURCES_SHA256 = 'f1729e44d22b38ea40bafacf29d1dc9d5e1980d34b4665ff6b12494ec763d183';

export const RULES_OUT = 'src/secret-rules.generated.ts';
export const SAMPLES_OUT = 'src/secret-rules.samples.generated.json';

/** Rules left out, and why. Rules scoped to a file path are left out too: a log line has no path. */
export const SKIPPED: Record<string, string> = {
  'generic-api-key': 'generic: any long value after a word like key, token or secret',
};
const SKIPPED_SUFFIX: Array<[string, string]> = [['-client-id', 'a public client id, not a secret']];

export function skipReason(rule: { id: string; path?: string; regex?: string }): string | undefined {
  if (SKIPPED[rule.id]) return SKIPPED[rule.id];
  for (const [suffix, why] of SKIPPED_SUFFIX) if (rule.id.endsWith(suffix)) return why;
  if (rule.path !== undefined || rule.regex === undefined) return 'matches on a file path';
  return undefined;
}

// ---------------------------------------------------------------- TOML subset

type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

/** The TOML gitleaks.toml uses: tables, arrays of tables, strings, numbers, booleans and arrays. */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  let i = 0;
  const fail = (msg: string): Error => new Error(`TOML line ${text.slice(0, i).split('\n').length}: ${msg}`);
  const skip = (newlines: boolean): void => {
    for (;;) {
      while (i < text.length && (text[i] === ' ' || text[i] === '\t' || (newlines && /[\r\n]/.test(text[i])))) i++;
      if (text[i] !== '#') return;
      while (i < text.length && text[i] !== '\n') i++;
    }
  };
  const key = (): string => {
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
    if (m) {
      i += m[0].length;
      return m[0];
    }
    if (text[i] === '"' || text[i] === "'") return value() as string;
    throw fail('expected a key');
  };
  const value = (): TomlValue => {
    if (text.startsWith("'''", i)) {
      const end = text.indexOf("'''", i + 3);
      if (end === -1) throw fail('unterminated literal string');
      const raw = text.slice(i + 3, end);
      i = end + 3;
      return raw.replace(/^\r?\n/, '');
    }
    if (text.startsWith('"""', i)) throw fail('multi-line basic strings are not supported');
    if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      const raw = text.slice(i + 1, end);
      if (end === -1 || raw.includes('\n')) throw fail('unterminated literal string');
      i = end + 1;
      return raw;
    }
    if (text[i] === '"') {
      let out = '';
      for (i++; text[i] !== '"'; ) {
        if (i >= text.length || text[i] === '\n') throw fail('unterminated string');
        if (text[i] !== '\\') {
          out += text[i++];
          continue;
        }
        const e = text[i + 1];
        const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (e in simple) {
          out += simple[e];
          i += 2;
        } else if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8;
          out += String.fromCodePoint(parseInt(text.slice(i + 2, i + 2 + len), 16));
          i += 2 + len;
        } else throw fail(`bad escape \\${e}`);
      }
      i++;
      return out;
    }
    if (text[i] === '[') {
      const items: TomlValue[] = [];
      i++;
      for (;;) {
        skip(true);
        if (text[i] === ']') break;
        items.push(value());
        skip(true);
        if (text[i] === ',') i++;
        else if (text[i] !== ']') throw fail('expected , or ]');
      }
      i++;
      return items;
    }
    const m = /^(?:true|false|[+-]?\d+(?:\.\d+)?)/.exec(text.slice(i));
    if (!m) throw fail('unsupported value');
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : Number(m[0]);
  };

  for (skip(true); i < text.length; skip(true)) {
    if (text[i] === '[') {
      const many = text.startsWith('[[', i);
      const close = text.indexOf(many ? ']]' : ']', i);
      const path = text
        .slice(i + (many ? 2 : 1), close)
        .trim()
        .split('.');
      i = close + (many ? 2 : 1);
      let parent: TomlTable = root;
      for (const seg of path.slice(0, -1)) {
        const next = parent[seg];
        parent = (Array.isArray(next) ? next[next.length - 1] : next) as TomlTable;
        if (!parent || typeof parent !== 'object') throw fail(`no parent table for ${path.join('.')}`);
      }
      const last = path[path.length - 1];
      if (many) {
        const list = (parent[last] ??= []) as TomlValue[];
        table = {};
        list.push(table);
      } else table = (parent[last] ??= {}) as TomlTable;
      continue;
    }
    const k = key();
    skip(false);
    if (text[i] !== '=') throw fail('expected =');
    i++;
    skip(false);
    table[k] = value();
  }
  return root;
}

// ---------------------------------------------------------------- RE2 -> JS

const POSIX: Record<string, string> = {
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  digit: '0-9',
  xdigit: '0-9A-Fa-f',
  word: '\\w',
  space: '\\s',
};
const isLetter = (ch: string): boolean => /^[A-Za-z]$/.test(ch);
const both = (ch: string): string => `[${ch.toLowerCase()}${ch.toUpperCase()}]`;

/** The other-case letters of a class range, as class items. */
function foldRange(lo: number, hi: number): string[] {
  const out: string[] = [];
  for (const [from, to, shift] of [
    [97, 122, -32],
    [65, 90, 32],
  ]) {
    const a = Math.max(lo, from);
    const b = Math.min(hi, to);
    if (a <= b)
      out.push(
        a === b
          ? String.fromCharCode(a + shift)
          : `${String.fromCharCode(a + shift)}-${String.fromCharCode(b + shift)}`,
      );
  }
  return out;
}

/** One escape outside a class: its JS text and length. */
function escapeAt(src: string, i: number, fold: boolean): [string, number] {
  const n = src[i + 1];
  if (n === 'x') {
    const hex = src.slice(i + 2, i + 4);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error(`unsupported escape ${src.slice(i, i + 4)}`);
    const ch = String.fromCharCode(parseInt(hex, 16));
    return [fold && isLetter(ch) ? both(ch) : `\\x${hex}`, 4];
  }
  if (n === 'z') return ['$', 2]; // end of text: the JS pattern never gets the m flag
  if (n === 'A') return ['^', 2];
  if ('bBdDsSwWtnrfv'.includes(n)) return [`\\${n}`, 2];
  if (/[A-Za-z0-9]/.test(n ?? '0')) throw new Error(`unsupported escape \\${n}`);
  return [`\\${n}`, 2];
}

/** One class item (a character or escape): its JS text, char code (null for \w-style sets) and length. */
function classAtom(src: string, j: number, first: boolean): [string, number | null, number] {
  const c = src[j];
  if (c !== '\\') return [c === ']' && first ? '\\]' : c, c.charCodeAt(0), 1];
  const n = src[j + 1];
  if (n === 'x') {
    const hex = src.slice(j + 2, j + 4);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error(`unsupported escape ${src.slice(j, j + 4)}`);
    return [`\\x${hex}`, parseInt(hex, 16), 4];
  }
  const controls: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
  if (n in controls) return [`\\${n}`, controls[n], 2];
  if ('dDsSwW'.includes(n)) return [`\\${n}`, null, 2];
  if (/[A-Za-z0-9]/.test(n)) throw new Error(`unsupported class escape \\${n}`);
  return [`\\${n}`, n.charCodeAt(0), 2];
}

function charClassAt(src: string, i: number, fold: boolean): [string, number] {
  let j = i + 1;
  let out = '[';
  const extra: string[] = [];
  if (src[j] === '^') {
    out += '^';
    j++;
  }
  for (let first = true; ; first = false) {
    if (j >= src.length) throw new Error('unterminated class');
    if (src[j] === ']' && !first) return [out + extra.join('') + ']', j + 1 - i];
    if (src.startsWith('[:', j)) {
      const end = src.indexOf(':]', j);
      const set = POSIX[src.slice(j + 2, end)];
      if (end === -1 || !set) throw new Error(`unsupported class ${src.slice(j, end + 2)}`);
      out += set;
      j = end + 2;
      continue;
    }
    const [loText, lo, len] = classAtom(src, j, first);
    j += len;
    if (src[j] === '-' && src[j + 1] !== ']' && lo !== null) {
      const [hiText, hi, len2] = classAtom(src, j + 1, false);
      if (hi === null || hi < lo) throw new Error('bad class range');
      out += `${loText}-${hiText}`;
      j += 1 + len2;
      if (fold) extra.push(...foldRange(lo, hi));
    } else {
      out += loText;
      if (fold && lo !== null) extra.push(...foldRange(lo, lo));
    }
  }
}

// RE2 runs in linear time; a backtracking engine retries `.*` from every start,
// so a line full of `curl` costs seconds. Capping the run keeps it linear. `.`
// also stops at \r: where RE2 lets `.` and `[\r\n]` share a run of \r, JS tries
// every split of it.
const DOT_RUN_LIMIT = 1000;

/**
 * Go RE2 syntax to a JS RegExp source and flags, same matches (bar `.*` runs
 * past DOT_RUN_LIMIT, and `.` at \r). A pattern that is case-insensitive throughout gets the i
 * flag; one that switches case sensitivity part-way gets its letters folded by
 * hand, as `(?i)` inside a pattern has no JS equivalent on Node 22. Throws on
 * anything else it can't map.
 */
export function re2ToJs(re2: string): { source: string; flags: string } {
  let src = re2;
  let flags = '';
  if (src.startsWith('(?i)') && !src.includes('(?-i')) {
    src = src.slice(4);
    flags = 'i';
  }
  const fold = flags === '';
  let out = '';
  let ci = false;
  let dotAll = false;
  const saved: Array<{ ci: boolean; dotAll: boolean }> = [];
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '\\') {
      const [js, len] = escapeAt(src, i, fold && ci);
      out += js;
      i += len;
    } else if (c === '[') {
      const [js, len] = charClassAt(src, i, fold && ci);
      out += js;
      i += len;
    } else if (c === '(') {
      const m = /^\(\?(?:P?<(\w+)>|([a-z]*)(?:-([a-z]*))?([:)]))/.exec(src.slice(i));
      if (!m) {
        if (src[i + 1] === '?') throw new Error(`unsupported group ${src.slice(i, i + 5)}`);
        saved.push({ ci, dotAll });
        out += '(';
        i++;
        continue;
      }
      i += m[0].length;
      if (m[1]) {
        saved.push({ ci, dotAll });
        out += `(?<${m[1]}>`;
        continue;
      }
      const on = m[2] ?? '';
      const off = m[3] ?? '';
      if (/[^is]/.test(on + off)) throw new Error(`unsupported flags (?${on}-${off})`);
      const next = {
        ci: on.includes('i') || (ci && !off.includes('i')),
        dotAll: on.includes('s') || (dotAll && !off.includes('s')),
      };
      if (m[4] === ')') {
        ({ ci, dotAll } = next);
        continue;
      }
      saved.push({ ci, dotAll });
      ({ ci, dotAll } = next);
      out += '(?:';
    } else if (c === ')') {
      const s = saved.pop();
      if (!s) throw new Error('unbalanced )');
      ({ ci, dotAll } = s);
      out += ')';
      i++;
    } else if (c === '.') {
      out += dotAll ? '[\\s\\S]' : '[^\\r\\n]';
      i++;
      if (src[i] === '*' || src[i] === '+') out += `{${src[i++] === '*' ? 0 : 1},${DOT_RUN_LIMIT}}`;
    } else {
      out += fold && ci && isLetter(c) ? both(c) : c;
      i++;
    }
  }
  if (saved.length) throw new Error('unbalanced (');
  new RegExp(out, flags);
  return { source: out, flags };
}

// Many rules start with up to 50 lazy "context" characters before the keyword.
// They never hold the secret, and in a backtracking engine they make every
// position cost up to 50 tries, so the generated pattern starts at the keyword.
const LEADING_CONTEXT = '[\\w.-]{0,50}?';
// Most rules end a token only at a quote, space, ; or escaped line end, as in
// source code. In a log a key also ends at URL, bracket and escape punctuation
// (`?key=…&`, `…/getMe`, `(…)`, `…|`, `…\`, `…@host`), or at . : ! closing a sentence. Not
// at `(` or a `.` inside a word: gitleaks' false-positive samples (`GLC_Name(`,
// `ico-<hash>.png`).
const TOKEN_END_RE2 = String.raw`(?:[\x60'"\s;]|\\[nr]|$)`;
const TOKEN_END_JS = String.raw`(?=[\x60'"\s;/?&#,)\]}<>|\\@]|[.:!](?:[\x60'"\s]|$)|$)`;

/**
 * True when a pattern's first capture group is only part of the key: a named
 * field (jwt-base64) or a repeated piece (Teams webhook UUIDs). gitleaks reports
 * that group as the secret; a redactor has to mask the whole match instead.
 */
export function firstGroupIsPart(source: string): boolean {
  // Index past the bracket that closes the group or class opening at `i`.
  const skipClass = (i: number): number => {
    let j = i + 1;
    while (source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
    return j + 1;
  };
  for (let i = 0; i < source.length; ) {
    const c = source[i];
    if (c === '\\') i += 2;
    else if (c === '[') i = skipClass(i);
    else if (c !== '(' || /^\(\?(?:[:=!]|<[=!])/.test(source.slice(i))) i++;
    else if (source.startsWith('(?<', i)) return true;
    else {
      let depth = 0;
      for (let j = i; j < source.length; ) {
        const d = source[j];
        if (d === '\\') j += 2;
        else if (d === '[') j = skipClass(j);
        else if (d === ')' && --depth === 0) return /^[*+?{]/.test(source.slice(j + 1));
        else {
          if (d === '(') depth++;
          j++;
        }
      }
      throw new Error('unbalanced (');
    }
  }
  return false;
}

/** Index of the `|` or `)` that ends the alternative starting at `i`, or the end. */
function altEnd(src: string, i: number): number {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '[') {
      for (i++; src[i] !== ']'; i++) if (src[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && depth-- === 0) return i;
    else if (c === '|' && depth === 0) return i;
  }
  return i;
}

/** Literal text each alternative from `i` (up to its `)` or the end) must start with. */
function literalStarts(src: string, i: number): string[] {
  const out: string[] = [];
  for (;;) {
    out.push(...literalSeq(src, i).lits);
    i = altEnd(src, i);
    if (src[i] !== '|') return out;
    i++;
  }
}

/** The literal text one alternative must start with (one string per way), and whether that is all of it. */
function literalSeq(src: string, i: number): { lits: string[]; complete: boolean } {
  let lits = [''];
  const quantified = (at: number): boolean => /^[*+?{]/.test(src.slice(at));
  while (i < src.length && src[i] !== '|' && src[i] !== ')') {
    const c = src[i];
    let piece: string[];
    let next: number;
    if (c === '\\') {
      const n = src[i + 1];
      if (n === 'b' || n === 'B') {
        i += 2;
        continue;
      }
      if (n === 'x') [piece, next] = [[String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16))], i + 4];
      else if (/[A-Za-z0-9]/.test(n)) return { lits, complete: false };
      else [piece, next] = [[n], i + 2];
    } else if (c === '[') {
      const m = /^\[([A-Za-z])([A-Za-z])\]/.exec(src.slice(i));
      if (!m || m[1].toLowerCase() !== m[2].toLowerCase()) return { lits, complete: false };
      [piece, next] = [[m[1]], i + 4];
    } else if (c === '(') {
      const head = /^\((?:\?:|\?<\w+>)?/.exec(src.slice(i))![0];
      if (head === '(' && src[i + 1] === '?') return { lits, complete: false }; // lookaround
      let j = i + head.length;
      piece = [];
      let complete = true;
      for (;;) {
        const r = literalSeq(src, j);
        piece.push(...r.lits);
        complete &&= r.complete;
        j = altEnd(src, j);
        if (src[j] !== '|') break;
        j++;
      }
      next = j + 1;
      if (quantified(next)) return { lits, complete: false };
      lits = lits.flatMap((l) => piece.map((p) => l + p));
      if (!complete) return { lits, complete: false };
      i = next;
      continue;
    } else if (c === '^' || c === '$') {
      i++;
      continue;
    } else if ('.*+?{['.includes(c)) return { lits, complete: false };
    else [piece, next] = [[c], i + 1];
    if (quantified(next)) return { lits, complete: false };
    lits = lits.map((l) => l + piece[0]);
    i = next;
  }
  return { lits, complete: true };
}

/**
 * Keywords that are fixed text at the start of every key a rule finds (`ghp_`,
 * `AKIA`, `sk_live`): the issuer prefix a hint may show. Read from the pattern,
 * not the match: a context rule's key may happen to start with one of its
 * keywords, and that is payload.
 */
export function issuerPrefixes(source: string, keywords: string[], wholeMatch: boolean): string[] {
  const starts: number[] = [];
  if (!wholeMatch) {
    // Where each outermost capture group starts: the secret is one of those.
    const stack: boolean[] = [];
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === '\\') i++;
      else if (c === '[') {
        for (i++; source[i] !== ']'; i++) if (source[i] === '\\') i++;
      } else if (c === ')') stack.pop();
      else if (c === '(') {
        const head = /^\((?:\?:|\?<\w+>|\?[=!]|\?<[=!])?/.exec(source.slice(i))![0];
        const capturing = head === '(' || /^\(\?<\w+>$/.test(head);
        if (capturing && !stack.includes(true)) starts.push(i + head.length);
        stack.push(capturing);
        i += head.length - 1;
      }
    }
  }
  const lits = (starts.length ? starts : [0]).flatMap((s) => literalStarts(source, s)).map((l) => l.toLowerCase());
  return keywords.filter((k) => k.length >= 3 && lits.some((l) => l.startsWith(k))).sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------- Go samples

type GoTok = { k: 'str' | 'id' | 'p'; v: string };

export function goTokens(src: string): GoTok[] {
  const toks: GoTok[] = [];
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (src.startsWith('//', i)) i = src.includes('\n', i) ? src.indexOf('\n', i) : src.length;
    else if (src.startsWith('/*', i)) i = src.indexOf('*/', i) + 2;
    else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      toks.push({ k: 'str', v: src.slice(i + 1, end).replace(/\r/g, '') });
      i = end + 1;
    } else if (c === '"') {
      let v = '';
      for (i++; src[i] !== '"'; ) {
        if (src[i] !== '\\') {
          v += src[i++];
          continue;
        }
        const e = src[i + 1];
        const simple: Record<string, string> = {
          a: '\x07',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
          v: '\v',
          '\\': '\\',
          "'": "'",
          '"': '"',
        };
        if (e in simple) {
          v += simple[e];
          i += 2;
        } else if (e === 'x' || e === 'u' || e === 'U') {
          const len = { x: 2, u: 4, U: 8 }[e];
          v += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + len), 16));
          i += 2 + len;
        } else if (/[0-7]/.test(e)) {
          v += String.fromCharCode(parseInt(src.slice(i + 1, i + 4), 8));
          i += 4;
        } else throw new Error(`bad Go escape \\${e}`);
      }
      toks.push({ k: 'str', v });
      i++;
    } else if (c === "'") {
      let j = i + 1;
      while (src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      toks.push({ k: 'p', v: src.slice(i, j + 1) });
      i = j + 1;
    } else {
      const word = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d[\w.]*)/.exec(src.slice(i))?.[0];
      const punct = word ?? (['...', ':=', '=='].find((p) => src.startsWith(p, i)) || c);
      toks.push({ k: word ? 'id' : 'p', v: punct });
      i += punct.length;
    }
  }
  return toks;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Comma-separated items from `start` up to the matching `close`, at bracket depth 0. */
function itemsUntil(toks: GoTok[], start: number, close: string): GoTok[][] {
  const items: GoTok[][] = [[]];
  const stack: string[] = [];
  for (let j = start; j < toks.length; j++) {
    const t = toks[j];
    if (t.k === 'p' && !stack.length && t.v === close) return items.filter((x) => x.length);
    if (t.k === 'p' && OPEN[t.v]) stack.push(OPEN[t.v]);
    else if (t.k === 'p' && t.v === stack[stack.length - 1]) stack.pop();
    if (t.k === 'p' && t.v === ',' && !stack.length) items.push([]);
    else items[items.length - 1].push(t);
  }
  throw new Error(`no closing ${close}`);
}

/** Index of the bracket that closes the one at `open`. */
function closeOf(toks: GoTok[], open: number): number {
  let depth = 0;
  for (let j = open; j < toks.length; j++) {
    if (toks[j].k !== 'p') continue;
    if (OPEN[toks[j].v]) depth++;
    else if (Object.values(OPEN).includes(toks[j].v) && --depth === 0) return j;
  }
  throw new Error('unbalanced brackets');
}

/** A string literal, or literals joined with +. */
function literal(toks: GoTok[]): string | null {
  if (!toks.length || toks.length % 2 === 0) return null;
  let out = '';
  for (let j = 0; j < toks.length; j++) {
    if (j % 2 === 0 && toks[j].k === 'str') out += toks[j].v;
    else if (j % 2 === 1 && toks[j].v === '+') continue;
    else return null;
  }
  return out;
}

/**
 * What one tps/fps item stands for: a sample line, or an [identifier, secret]
 * pair that GenerateSampleSecrets spreads over its templates. Null when the
 * item isn't built from literals only (most are random from the rule's regex).
 */
function sampleItem(toks: GoTok[]): string | [string, string] | null {
  const t = toks[toks.length - 1]?.v === '...' ? toks.slice(0, -1) : toks;
  const call = t.length > 4 && t[0].v === 'utils' && t[1].v === '.' && t[3].v === '(' ? t[2].v : null;
  if (!call) return literal(t);
  if (t[t.length - 1].v !== ')') return null;
  const args = itemsUntil(t, 4, ')');
  const [id, secret] = args.length === 2 ? args.map(literal) : [null, null];
  if (id === null || secret === null) return null;
  if (call === 'GenerateSampleSecret') return `${id}_api_token = "${secret}"`;
  return call === 'GenerateSampleSecrets' ? [id, secret] : null;
}

/** The templates GenerateSampleSecrets fills in, in source order. */
export function sampleTemplates(helperSrc: string): string[] {
  const toks = goTokens(helperSrc);
  const fn = toks.findIndex((t, j) => t.v === 'GenerateSampleSecrets' && toks[j - 1]?.v === 'func');
  const at = toks.findIndex((t, j) => j > fn && t.v === 'samples' && toks[j + 1]?.v === ':=');
  const brace = toks.findIndex((t, j) => j > at && t.v === '{');
  if (fn === -1 || at === -1) throw new Error('GenerateSampleSecrets templates not found');
  return itemsUntil(toks, brace + 1, '}').map((item) => {
    if (item.length !== 3 || item[2].k !== 'str') throw new Error('unexpected template entry');
    return item[2].v;
  });
}

export interface RuleSamples {
  tp: Array<string | [string, string]>;
  fp: Array<string | [string, string]>;
  skipped: number;
}

/** Literal true/false-positive samples per rule id, from one rule source file. */
export function goSamples(src: string): Map<string, RuleSamples> {
  const toks = goTokens(src);
  const out = new Map<string, RuleSamples>();
  const funcs: GoTok[][] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.k === 'id' && t.v === 'func' && depth === 0) funcs.push([]);
    if (t.k === 'p' && t.v === '{') depth++;
    if (t.k === 'p' && t.v === '}') depth--;
    funcs[funcs.length - 1]?.push(t);
  }
  for (const f of funcs) {
    const at = f.findIndex((t, j) => t.v === 'RuleID' && f[j + 1]?.v === ':' && f[j + 2]?.k === 'str');
    if (at === -1) continue;
    const id = f[at + 2].v;
    const samples = out.get(id) ?? { tp: [], fp: [], skipped: 0 };
    out.set(id, samples);
    for (let j = 0; j < f.length; j++) {
      const name = f[j].v;
      if ((name !== 'tps' && name !== 'fps') || f[j - 1]?.v === ',' || f[j - 1]?.v === '(') continue;
      const list = name === 'tps' ? samples.tp : samples.fp;
      let items: GoTok[][] | null = null;
      const next = f.slice(j + 1, j + 7).map((t) => t.v);
      if (next[0] === ':=' && next[1] === '[' && next[2] === ']' && next[3] === 'string' && next[4] === '{') {
        items = itemsUntil(f, j + 6, '}');
      } else if (next[0] === '=' && next[1] === 'append' && next[2] === '(' && next[3] === name && next[4] === ',') {
        items = itemsUntil(f, j + 6, ')');
      } else if ((next[0] === ':=' || next[0] === '=') && next[1] === 'utils' && next[4] === '(') {
        items = [f.slice(j + 2, closeOf(f, j + 5) + 1)];
      }
      for (const item of items ?? []) {
        const sample = sampleItem(item);
        if (sample === null) samples.skipped++;
        else list.push(sample);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- build

interface Allowlist {
  target: 'secret' | 'match' | 'line';
  condition?: 'and';
  regexes?: Array<[string, string]>;
  stopwords?: string[];
}

interface BuiltRule {
  id: string;
  keywords: string[];
  regex: [string, string];
  entropy?: number;
  secretGroup?: number;
  maskMatch?: boolean;
  prefixes?: string[];
  allowlists?: Allowlist[];
}

const str = (v: TomlValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const strs = (v: TomlValue | undefined): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const pattern = (re2: string): [string, string] => {
  const { source, flags } = re2ToJs(re2);
  return [source, flags];
};

/**
 * `^a|b$` anchors only the first and last alternative, so gitleaks' global
 * `^true|false|null$` lets through any key that merely contains `false`. An
 * allowlist has to match a whole value, so the alternation is wrapped.
 */
export function anchorAlternation(re2: string): string {
  const m = /^(\(\?[a-z]+\))?\^([\s\S]*[^\\])\$$/.exec(re2);
  if (!m || altEnd(m[2], 0) === m[2].length) return re2;
  return `${m[1] ?? ''}^(?:${m[2]})$`;
}

/**
 * One gitleaks allowlist as it can apply to a log line: commit and path checks
 * can't match, so an AND allowlist that needs one never applies and an OR one
 * keeps only its regexes and stopwords.
 */
function allowlist(t: TomlTable): Allowlist | null {
  const and = str(t.condition)?.toUpperCase() === 'AND';
  const needsContext = strs(t.paths).length > 0 || strs(t.commits).length > 0;
  if (and && needsContext) return null;
  const regexes = strs(t.regexes).map((r) => pattern(anchorAlternation(r)));
  const stopwords = strs(t.stopwords).map((w) => w.toLowerCase());
  if (!regexes.length && !stopwords.length) return null;
  const target = (str(t.regexTarget) ?? 'secret') as Allowlist['target'];
  return {
    target,
    ...(and ? { condition: 'and' as const } : {}),
    ...(regexes.length ? { regexes } : {}),
    ...(stopwords.length ? { stopwords } : {}),
  };
}

export interface Build {
  rules: BuiltRule[];
  global: Allowlist;
  skipped: Array<[string, string]>;
}

export function buildRules(config: TomlTable): Build {
  const rules: BuiltRule[] = [];
  const skipped: Array<[string, string]> = [];
  for (const t of (config.rules ?? []) as TomlTable[]) {
    const id = str(t.id) ?? '';
    const regex = str(t.regex);
    const why = skipReason({ id, path: str(t.path), regex });
    if (why) {
      skipped.push([id, why]);
      continue;
    }
    let js: [string, string];
    const tokenEnd = regex!.endsWith(TOKEN_END_RE2);
    try {
      js = pattern(tokenEnd ? regex!.slice(0, -TOKEN_END_RE2.length) : regex!);
      if (tokenEnd) js = [js[0] + TOKEN_END_JS, js[1]];
      new RegExp(js[0], js[1]);
    } catch (err) {
      skipped.push([id, `regex does not port to JS: ${(err as Error).message}`]);
      continue;
    }
    const allowlists = ((t.allowlists ?? []) as TomlTable[]).map(allowlist).filter((a): a is Allowlist => !!a);
    // An allowlist on the whole match would see the context, so keep it there.
    const matchTarget = allowlists.some((a) => a.target === 'match');
    if (js[0].startsWith(LEADING_CONTEXT) && !matchTarget) js = [js[0].slice(LEADING_CONTEXT.length), js[1]];
    const keywords = [...new Set(strs(t.keywords).map((k) => k.toLowerCase()))];
    if (!keywords.length) {
      skipped.push([id, 'no keywords to gate it']);
      continue;
    }
    // The runtime indexes keywords by their first two characters.
    if (keywords.some((k) => k.length < 2)) throw new Error(`${id}: a keyword shorter than 2 characters`);
    const maskMatch = t.secretGroup === undefined && firstGroupIsPart(js[0]);
    const prefixes = issuerPrefixes(js[0], keywords, maskMatch);
    rules.push({
      id,
      keywords,
      regex: js,
      ...(typeof t.entropy === 'number' ? { entropy: t.entropy } : {}),
      ...(typeof t.secretGroup === 'number' ? { secretGroup: t.secretGroup } : {}),
      ...(maskMatch ? { maskMatch } : {}),
      ...(prefixes.length ? { prefixes } : {}),
      ...(allowlists.length ? { allowlists } : {}),
    });
  }
  const g = (config.allowlist ?? {}) as TomlTable;
  return { rules, global: allowlist({ ...g, paths: [] }) ?? { target: 'secret' }, skipped };
}

function rulesModule(build: Build, license: string): string {
  const lines = [
    `// Generated by scripts/gen-secret-rules.ts from gitleaks ${GITLEAKS_TAG} (${CONFIG_PATH} at`,
    `// ${GITLEAKS_COMMIT}, sha256 ${CONFIG_SHA256}).`,
    '// Do not edit: run `pnpm run secret-rules:generate`. Regexes are ported from',
    '// Go RE2 to JS; rules left out are listed in GITLEAKS_SKIPPED.',
    '//',
    ...license
      .trim()
      .split('\n')
      .map((l) => `// ${l}`.trimEnd()),
    '',
    '/** A pattern as [source, flags]. */',
    'export type GitleaksPattern = readonly [string, string];',
    '',
    'export interface GitleaksAllowlist {',
    "  target: 'secret' | 'match' | 'line';",
    "  condition?: 'and';",
    '  regexes?: readonly GitleaksPattern[];',
    '  stopwords?: readonly string[];',
    '}',
    '',
    'export interface GitleaksRule {',
    '  id: string;',
    '  /** Lower case; the rule runs only when one is in the text. */',
    '  keywords: readonly string[];',
    '  regex: GitleaksPattern;',
    '  /** The secret must have more Shannon entropy than this. */',
    '  entropy?: number;',
    '  secretGroup?: number;',
    '  /** Mask the whole match: the group gitleaks reports is only part of the key. */',
    '  maskMatch?: boolean;',
    '  /** Keywords that are fixed text at the start of every key it finds, longest first. */',
    '  prefixes?: readonly string[];',
    '  allowlists?: readonly GitleaksAllowlist[];',
    '}',
    '',
    `export const GITLEAKS_VERSION = ${JSON.stringify(GITLEAKS_TAG)};`,
    '',
    `export const GITLEAKS_ALLOWLIST: GitleaksAllowlist = ${JSON.stringify(build.global)};`,
    '',
    `export const GITLEAKS_RULES: readonly GitleaksRule[] = ${JSON.stringify(build.rules)};`,
    '',
    `export const GITLEAKS_SKIPPED: Readonly<Record<string, string>> = ${JSON.stringify(Object.fromEntries(build.skipped))};`,
    '',
  ];
  return lines.join('\n');
}

/** ROT13 on letters, ROT5 on digits: applying it twice gives the text back. */
export function rot135(s: string): string {
  return s.replace(/[A-Za-z0-9]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code <= 57) return String.fromCharCode(((code - 48 + 5) % 10) + 48);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

function samplesFile(samples: Map<string, RuleSamples>, kept: Set<string>, templates: string[]): string {
  // Scrambled before base64: GitHub's secret scanning decodes base64, and its push
  // protection blocks these fakes. Reversed, with letters and digits rotated
  // (ROT13, ROT5), no sample decodes to a key- or hex-shaped string.
  const b64 = (s: string): string => Buffer.from(rot135([...s].reverse().join('')), 'utf-8').toString('base64');
  const encode = (list: Array<string | [string, string]>): Array<string | [string, string]> => {
    const seen = new Set<string>();
    return list
      .map((x) => (typeof x === 'string' ? b64(x) : ([x[0], b64(x[1])] as [string, string])))
      .filter((x) => !seen.has(JSON.stringify(x)) && !!seen.add(JSON.stringify(x)));
  };
  const rules: Record<string, { tp: Array<string | [string, string]>; fp: Array<string | [string, string]> }> = {};
  for (const id of [...samples.keys()].sort()) {
    const s = samples.get(id)!;
    if (!kept.has(id) || (!s.tp.length && !s.fp.length)) continue;
    rules[id] = { tp: encode(s.tp), fp: encode(s.fp) };
  }
  const doc = {
    note:
      'Literal true/false-positive samples from gitleaks rule sources. Each sample is written backwards, its ' +
      'letters moved 13 places and its digits 5 places (ROT13, ROT5), then base64-encoded, so secret scanners ' +
      '(which decode base64) do not mistake the fakes for real keys. To read one, base64-decode it, move the ' +
      'letters and digits back the same way, and reverse it. ' +
      'An [identifier, secret] pair stands for every template filled in ({i}, {I} upper case, {s}). ' +
      'Generated by scripts/gen-secret-rules.ts.',
    gitleaks: GITLEAKS_TAG,
    commit: GITLEAKS_COMMIT,
    templates,
    rules,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

const sha256 = (data: string): string => createHash('sha256').update(data, 'utf-8').digest('hex');

async function fetchText(url: string): Promise<string> {
  const headers: Record<string, string> = process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};
  const res = await fetch(url, { headers: url.startsWith('https://api.github.com/') ? headers : {} });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Downloads the pinned files into a new folder, checks both hashes, returns their text by path. */
async function download(dir: string): Promise<Map<string, string>> {
  const tree = JSON.parse(
    await fetchText(`https://api.github.com/repos/gitleaks/gitleaks/git/trees/${GITLEAKS_COMMIT}?recursive=1`),
  ) as { truncated: boolean; tree: Array<{ path: string; type: string }> };
  if (tree.truncated) throw new Error('gitleaks tree listing was truncated');
  const sources = tree.tree
    .filter((e) => e.type === 'blob' && e.path.startsWith(RULES_DIR) && e.path.endsWith('.go'))
    .map((e) => e.path);
  const paths = [CONFIG_PATH, 'LICENSE', SAMPLE_HELPER, ...sources].sort();
  const files = new Map<string, string>();
  for (let k = 0; k < paths.length; k += 16) {
    await Promise.all(
      paths.slice(k, k + 16).map(async (p) => {
        const text = await fetchText(`https://raw.githubusercontent.com/gitleaks/gitleaks/${GITLEAKS_COMMIT}/${p}`);
        const file = join(dir, p);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        files.set(p, readFileSync(file, 'utf-8'));
      }),
    );
  }
  const config = sha256(files.get(CONFIG_PATH)!);
  if (config !== CONFIG_SHA256) throw new Error(`${CONFIG_PATH} sha256 ${config}, pinned ${CONFIG_SHA256}`);
  const digest = sha256(
    paths
      .filter((p) => p !== CONFIG_PATH)
      .map((p) => `${p}\0${files.get(p)}\0`)
      .join(''),
  );
  if (digest !== SOURCES_SHA256) throw new Error(`rule sources sha256 ${digest}, pinned ${SOURCES_SHA256}`);
  return files;
}

export interface Generated {
  rules: string;
  samples: string;
  report: string;
}

export async function generate(): Promise<Generated> {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-'));
  let files: Map<string, string>;
  try {
    files = await download(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const build = buildRules(parseToml(files.get(CONFIG_PATH)!));
  const templates = sampleTemplates(files.get(SAMPLE_HELPER)!);
  const samples = new Map<string, RuleSamples>();
  let skippedSamples = 0;
  for (const [p, text] of files) {
    if (!p.startsWith(RULES_DIR)) continue;
    let found: Map<string, RuleSamples>;
    try {
      found = goSamples(text);
    } catch (err) {
      throw new Error(`${p}: ${(err as Error).message}`, { cause: err });
    }
    for (const [id, s] of found) {
      const into = samples.get(id) ?? { tp: [], fp: [], skipped: 0 };
      into.tp.push(...s.tp);
      into.fp.push(...s.fp);
      into.skipped += s.skipped;
      samples.set(id, into);
      skippedSamples += s.skipped;
    }
  }
  const kept = new Set(build.rules.map((r) => r.id));
  const rulesSrc = rulesModule(build, files.get('LICENSE')!);
  const options = (await prettier.resolveConfig(RULES_OUT)) ?? {};
  const rules = await prettier.format(rulesSrc, { ...options, filepath: RULES_OUT });
  const samplesJson = samplesFile(samples, kept, templates);
  const withSamples = Object.keys((JSON.parse(samplesJson) as { rules: object }).rules).length;
  const report = [
    `gitleaks ${GITLEAKS_TAG}: ${build.rules.length} rules kept, ${build.skipped.length} skipped`,
    ...build.skipped.map(([id, why]) => `  skipped ${id}: ${why}`),
    `samples: ${withSamples} rules with literal samples; ${skippedSamples} generated (random) samples not reproducible`,
  ].join('\n');
  return { rules, samples: samplesJson, report };
}

async function main(mode: string): Promise<number> {
  const gen = await generate();
  if (mode === '--check') {
    const stale = [
      [RULES_OUT, gen.rules],
      [SAMPLES_OUT, gen.samples],
    ].filter(([file, text]) => readFileSync(file, 'utf-8') !== text);
    if (stale.length) {
      console.error(
        `${stale.map(([f]) => f).join(', ')} differ from a fresh build: run pnpm run secret-rules:generate`,
      );
      return 1;
    }
    console.log(gen.report);
    return 0;
  }
  writeFileSync(RULES_OUT, gen.rules);
  writeFileSync(SAMPLES_OUT, gen.samples);
  console.log(gen.report);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? '--generate';
  if (mode !== '--generate' && mode !== '--check') {
    console.error('usage: tsx scripts/gen-secret-rules.ts [--generate | --check]');
    process.exitCode = 2;
  } else {
    main(mode).then(
      (code) => (process.exitCode = code),
      (err: unknown) => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
      },
    );
  }
}
