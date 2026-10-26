/**
 * Redaction for text that lands in log files (host log, setup progression and
 * raw step logs). A floor, not a guarantee: callers should still avoid logging
 * secrets. Key shapes come from gitleaks' rule list (secret-rules.generated.ts,
 * rebuilt by scripts/gen-secret-rules.ts); LOCAL_SHAPES adds what it misses.
 */

import {
  GITLEAKS_ALLOWLIST,
  GITLEAKS_RULES,
  type GitleaksAllowlist,
  type GitleaksPattern,
  type GitleaksRule,
} from './secret-rules.generated.js';

export const SECRET_MASK = '[REDACTED]';
const MASK = SECRET_MASK;

// Start of a token: not inside a longer token-like run (so a long run is
// scanned once), or right after a JSON-escaped \n, \r or \t or an ANSI colour
// code, raw or JSON-escaped.
const START = String.raw`(?:(?<![A-Za-z0-9_.+-])|(?<=\\[nrt])|(?<=(?:\x1b|\\u001b)\[[0-9;]*m))`;
const startOf = (body: string, flags = 'g'): RegExp => new RegExp(START + body, flags);

/** A secret's span, and the issuer prefix that may stay visible ('' for none). */
interface Hit {
  start: number;
  end: number;
  prefix: string;
}

/**
 * The issuer prefix and last 4 characters, as provider consoles show, only when
 * at least 16 payload characters stay hidden; otherwise the whole mask.
 */
function hint(key: string, prefix: string): string {
  return prefix && key.length - prefix.length - 4 >= 16 ? `${prefix}${MASK}…${key.slice(-4)}` : MASK;
}

function applyHits(text: string, hits: Hit[]): string {
  if (!hits.length) return text;
  let out = '';
  let last = 0;
  for (const h of hits) {
    if (h.start < last) continue;
    out += text.slice(last, h.start) + hint(text.slice(h.start, h.end), h.prefix);
    last = h.end;
  }
  return out + text.slice(last);
}

/**
 * Shapes gitleaks misses, finds only next to a keyword, or finds only in one
 * exact length, each with the issuer prefix that may stay visible: `sk-` keys
 * (Anthropic OAuth, OpenRouter and other OpenAI-style providers), NanoClaw's
 * channel tokens, and JWTs.
 */
const LOCAL_SHAPES: Array<[RegExp, RegExp | null]> = [
  [startOf(String.raw`sk-[A-Za-z0-9_-]{20,}`), /^sk-(?:ant-(?:api|admin|oat|sid)\d{2}-|proj-|svcacct-|admin-)?/],
  [startOf(String.raw`(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`), /^gh[a-z]_/], // GitHub
  [startOf(String.raw`github_pat_[A-Za-z0-9_]{20,}`), /^github_pat_/],
  [startOf(String.raw`xox[a-z]-[A-Za-z0-9-]{10,}`), /^xox[a-z]-/], // Slack
  [startOf(String.raw`xapp-[A-Za-z0-9-]{10,}`), /^xapp-/],
  [startOf(String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), null], // JWT
  [/\d{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, null], // Telegram bot token, also inside /bot<token>/ URLs
  [startOf(String.raw`[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-])`), null], // Discord
  // Webhook URLs whose path is the credential: only the token part is masked.
  [/(?<=\/webhooks\/\d{6,}\/)[A-Za-z0-9_.-]{20,}/g, null], // Discord webhook and interaction tokens
  [/(?<=hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]{20,}/g, null],
];

function localHits(text: string, [re, prefix]: [RegExp, RegExp | null]): Hit[] {
  return [...text.matchAll(re)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    prefix: prefix?.exec(m[0])?.[0] ?? '',
  }));
}

interface Allowlist {
  target: GitleaksAllowlist['target'];
  and: boolean;
  regexes: RegExp[];
  stopwords: readonly string[];
}

interface Rule {
  rule: GitleaksRule;
  re: RegExp;
  allowlists: Allowlist[];
  /** Finding a match's line rescans it; only done when an allowlist reads it. */
  needsLine: boolean;
}

const compile = ([source, flags]: GitleaksPattern, extra = ''): RegExp => new RegExp(source, flags + extra);
const allowlistOf = (a: GitleaksAllowlist): Allowlist => ({
  target: a.target,
  and: a.condition === 'and',
  regexes: (a.regexes ?? []).map((p) => compile(p)),
  stopwords: a.stopwords ?? [],
});
const GLOBAL_ALLOWLIST = allowlistOf(GITLEAKS_ALLOWLIST);
const RULES: Rule[] = GITLEAKS_RULES.map((rule) => {
  const allowlists = [GLOBAL_ALLOWLIST, ...(rule.allowlists ?? []).map(allowlistOf)];
  return { rule, re: compile(rule.regex, 'gd'), allowlists, needsLine: allowlists.some((a) => a.target === 'line') };
});

// Allowlist regexes are unanchored and can backtrack on a long value; past this
// length the value is masked without consulting them.
const ALLOWLIST_LIMIT = 1000;

/** gitleaks' allowlist check, minus commits and paths, which a log line never has. */
function allowed(a: Allowlist, secret: string, match: string, line: string): boolean {
  const target = a.target === 'match' ? match : a.target === 'line' ? line : secret;
  const byRegex = target !== '' && target.length <= ALLOWLIST_LIMIT && a.regexes.some((re) => re.test(target));
  const lower = secret.toLowerCase();
  const byStopword = secret !== '' && a.stopwords.some((w) => lower.includes(w));
  if (!a.and) return byRegex || byStopword;
  return (!a.regexes.length || byRegex) && (!a.stopwords.length || byStopword);
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

/** One gitleaks rule's findings as gitleaks reports them: secret group, entropy and allowlists applied. */
function ruleHits(text: string, { rule, re, allowlists, needsLine }: Rule): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(re)) {
    let [start, end] = m.indices![0];
    while (start < end && text[start] === '\n') start++;
    while (end > start && text[end - 1] === '\n') end--;
    let span: [number, number] | undefined = [start, end];
    if (m.length > 1) {
      const groups = m.indices!;
      span = rule.secretGroup ? groups[rule.secretGroup] : (groups.slice(1).find((g) => g && g[1] > g[0]) ?? span);
    }
    if (!span || span[1] <= span[0]) continue;
    const secret = text.slice(span[0], span[1]);
    if (rule.entropy !== undefined && entropy(secret) <= rule.entropy) continue;
    const lineEnd = needsLine ? text.indexOf('\n', end) : -1;
    const line = needsLine
      ? text.slice(text.lastIndexOf('\n', start - 1) + 1, lineEnd === -1 ? undefined : lineEnd)
      : '';
    if (allowlists.some((a) => allowed(a, secret, text.slice(start, end), line))) continue;
    const [from, to] = rule.maskMatch ? [start, end] : span;
    const shown = text.slice(from, to).toLowerCase();
    const prefix = rule.prefixes?.find((p) => shown.startsWith(p));
    hits.push({ start: from, end: to, prefix: prefix ? text.slice(from, from + prefix.length) : '' });
  }
  return hits;
}

// Key characters right after a match are the rest of a longer key.
const TAIL = /[A-Za-z0-9_-]*/y;

/**
 * Every rule's hits at once, each run on to the end of its key, overlaps merged:
 * masking rule by rule would let a shorter rule cut a longer key in two.
 */
function gitleaksHits(view: string): Hit[] {
  const hits = rulesFor(view).flatMap((r) => ruleHits(view, r));
  hits.sort((a, b) => a.start - b.start || b.prefix.length - a.prefix.length);
  const merged: Hit[] = [];
  for (const h of hits) {
    TAIL.lastIndex = h.end;
    TAIL.exec(view);
    const end = TAIL.lastIndex;
    const last = merged[merged.length - 1];
    if (last && h.start < last.end) last.end = Math.max(last.end, end);
    else merged.push({ ...h, end });
  }
  return merged;
}

// JSON-escaped line ends, tabs and quotes, and ANSI colour codes (raw or JSON-escaped).
// gitleaks rules expect a key between spaces or quotes, so they run on a copy with
// these blanked to spaces: same length, so every span maps back to the text as is.
const ESCAPES = new RegExp(String.raw`\\[nrt"]|(?:\x1b|\\u001b)\[[0-9;]*m`, 'g');
const plain = (text: string): string =>
  text.includes('\\') || text.includes('\x1b') ? text.replace(ESCAPES, (m) => ' '.repeat(m.length)) : text;

// Keywords by their first two characters (the generator rejects shorter ones):
// one pass over a line finds every rule it needs, instead of a search per keyword.
const BY_PAIR = new Map<number, Array<[string, Rule]>>();
for (const r of RULES) {
  for (const k of r.rule.keywords) {
    const key = k.charCodeAt(0) * 65536 + k.charCodeAt(1);
    BY_PAIR.set(key, [...(BY_PAIR.get(key) ?? []), [k, r]]);
  }
}

/** The gitleaks rules whose keywords appear in the text, in list order: only those run. */
function rulesFor(text: string): Rule[] {
  const lower = text.toLowerCase();
  const found = new Set<Rule>();
  for (let i = 0; i + 1 < lower.length; i++) {
    const list = BY_PAIR.get(lower.charCodeAt(i) * 65536 + lower.charCodeAt(i + 1));
    if (list) for (const [k, r] of list) if (lower.startsWith(k, i)) found.add(r);
  }
  return found.size ? RULES.filter((r) => found.has(r)) : [];
}

/** Every gitleaks finding in the text, by rule id. For tests and diagnostics. */
export function detectSecrets(text: string, ids?: ReadonlySet<string>): Array<{ rule: string; secret: string }> {
  const view = plain(text);
  return rulesFor(view)
    .filter((r) => !ids || ids.has(r.rule.id))
    .flatMap((r) => ruleHits(view, r).map((h) => ({ rule: r.rule.id, secret: text.slice(h.start, h.end) })));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const HINT = new RegExp(
  String.raw`^(?:${[
    ...LOCAL_SHAPES.flatMap(([, p]) => (p ? [p.source.slice(1)] : [])),
    ...[...new Set(GITLEAKS_RULES.flatMap((r) => r.prefixes ?? []))].map(escapeRe),
  ].join('|')})\[REDACTED\]…[^\s"'\\]{4}$`,
  'i',
);

/** Exactly a mask written here or upstream: `[redacted]`, `ghp_[REDACTED]…a1B2`, `<redacted: N bytes …>`. */
export function isRedactionPlaceholder(value: string): boolean {
  return /^(?:\[redacted\]|<redacted[^<>]*>)$/i.test(value) || HINT.test(value);
}

/** A secret-named field's value: the hint when it is exactly one prefixed key, else fully masked. */
export function maskSecretValue(value: string): string {
  const whole = (hits: Hit[]): Hit | undefined =>
    hits.length === 1 && hits[0].start === 0 && hits[0].end === value.length ? hits[0] : undefined;
  for (const shape of LOCAL_SHAPES) {
    const h = whole(localHits(value, shape));
    if (h) return hint(value, h.prefix);
  }
  const h = whole(gitleaksHits(plain(value)));
  return h ? hint(value, h.prefix) : MASK;
}

// PEM body (with any Proc-Type/DEK-Info headers) up to its END line, or to the
// end of the base64 run when cut off; the backslash covers JSON-escaped newlines.
// Runs first: a mask inserted inside the body would end the match early.
const PEM_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----END )[A-Za-z0-9+/=\s\\:,-])*(?:-----END [A-Z ]*PRIVATE KEY-----)?/g;

/** Last word of a field, variable, flag or header name that holds a secret. */
const SECRET_NAME_WORDS = [
  'token',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'private_key',
  'secret_key',
  'access_key',
  'secret_access_key',
  'credential',
  'credentials',
  'authorization',
  'cookie',
];

/** `max_tokens`, `secret_name` and `key` stay readable; `bot_token`, `x-api-key` do not. */
export function isSecretName(name: string): boolean {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.]/g, '_')
    .toLowerCase();
  return SECRET_NAME_WORDS.some((word) => snake === word || snake.endsWith(`_${word}`));
}

const NAME_WORDS = SECRET_NAME_WORDS.map((w) => w.replace(/_/g, '[_-]?')).join('|');
// A value runs to its closing quote when quoted (escapes included; in a
// JSON-escaped value \" closes and \\\" is a quote inside), else to the next
// space or delimiter.
const VALUE = String.raw`((?<=\\")(?:[^"\\\r\n]|\\\\\\"|\\\\|\\[^"\\\r\n])+|(?<=(?<!\\)")(?:[^"\\\r\n]|\\[^\r\n])+|(?<=')(?:[^'\\\r\n]|\\[^\r\n])+|(?:[^\s"'\\,;&]|\\(?![\\"'nrt]))+)`;
// NAME=value, NAME: value, "name":"value". The value may carry an auth scheme,
// which stays visible. Never crosses a line end.
const NAMED_VALUE = startOf(
  String.raw`([A-Za-z0-9_.-]*?(?:${NAME_WORDS}))(\\?["']?[ \t]*[:=][ \t]*\\?["']?)((?:Bearer|Basic|Token|Bot)[ \t]+)?${VALUE}`,
  'gi',
);
// --flag value, --flag "value"
const FLAG_VALUE = startOf(String.raw`(--[A-Za-z0-9_.-]*?(?:${NAME_WORDS}))([ \t]+["']?)${VALUE}`, 'gi');
// Every cookie in a Cookie / Set-Cookie header line, not just the first.
// Quoted cookie values may be raw or JSON-escaped; a JSON-escaped line end stops it.
const COOKIE_HEADER = startOf(
  String.raw`((?:set-)?cookie[ \t]*:[ \t]*)((?:[^\r\n"\\]|"[^"\r\n\\]*"|\\"[^"\r\n\\]*\\"|\\[^"nr\r\n])+)`,
  'gi',
);
const BEARER = /\b(bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/gi;
const URL_PASSWORD = startOf(String.raw`([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@`, 'gi');

// Unquoted words that say a secret is absent stay readable: `token: not configured`.
const PLACEHOLDER_WORDS = new Set(['true', 'false', 'null', 'undefined', 'none', 'not', 'unset', 'missing', 'empty']);

function maskNamed(match: string, name: string, sep: string, scheme: string | undefined, value: string): string {
  if (!isSecretName(name.replace(/^-+/, '')) || isRedactionPlaceholder(value)) return match;
  if (!/["']$/.test(sep) && PLACEHOLDER_WORDS.has(value.toLowerCase())) return match;
  return `${name}${sep}${scheme ?? ''}${MASK}`;
}

export function redactSecrets(text: string): string {
  let out = String(text).replace(PEM_BLOCK, MASK);
  for (const shape of LOCAL_SHAPES) out = applyHits(out, localHits(out, shape));
  out = applyHits(out, gitleaksHits(plain(out)));
  out = out.replace(URL_PASSWORD, `$1${MASK}@`);
  out = out.replace(COOKIE_HEADER, (match, head: string, value: string) =>
    isRedactionPlaceholder(value) ? match : `${head}${MASK}`,
  );
  out = out.replace(NAMED_VALUE, maskNamed);
  out = out.replace(FLAG_VALUE, (match, name: string, sep: string, value: string) =>
    maskNamed(match, name, sep, undefined, value),
  );
  out = out.replace(BEARER, (match, scheme: string, value: string) =>
    isRedactionPlaceholder(value) ? match : `${scheme}${MASK}`,
  );
  return out;
}

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * For output that arrives a line at a time: `redactSecrets` per line, plus a
 * PEM key's body lines, which only the BEGIN line identifies, until its END line.
 */
export function createLineRedactor(): (text: string) => string {
  let inKey = false;
  const line = (raw: string): string => {
    const end = raw.search(/\r?\n$|\r$/);
    const [body, eol] = end === -1 ? [raw, ''] : [raw.slice(0, end), raw.slice(end)];
    if (inKey) {
      const close = PEM_END.exec(body);
      if (!close) return MASK + eol;
      inKey = false;
      return MASK + redactSecrets(body.slice(close.index + close[0].length)) + eol;
    }
    const begins = [...body.matchAll(PEM_BEGIN)];
    const last = begins[begins.length - 1];
    if (last && !PEM_END.test(body.slice(last.index))) inKey = true;
    return redactSecrets(body) + eol;
  };
  return (text) =>
    text
      .split(/(?<=\n)/)
      .map(line)
      .join('');
}
