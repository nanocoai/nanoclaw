#!/usr/bin/env bun
/**
 * typesafe-judge — ask TypeSafe's System One model (Jev) for typed judgments.
 *
 * Reads `{ state, questions, model? }` as JSON on stdin (or from flags), POSTs
 * it to https://api.typesafe.ai/v1/systemone and prints the answers as JSON.
 * The three primitives (noul, choice, score) are passed through unchanged;
 * several questions in one call are one request (speculative fan-out).
 * `--gate` adds a per-answer decision (act / propose / withhold) derived from
 * the answer's confidence or probability.
 *
 * Credentials: the request carries `Authorization: Bearer placeholder`. The
 * install's credential gateway (OneCLI or Iron Proxy) replaces it with the
 * real key at the network edge, matched on the api.typesafe.ai host. This
 * script never reads an API key from the environment, a file, or an argument.
 *
 * Runs under Bun inside the agent container with no runtime dependencies. It
 * only uses portable Node/Web APIs so it typechecks under either runtime.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
export const PLACEHOLDER_CREDENTIAL = 'placeholder';
const USER_AGENT = 'nanoclaw typesafe-judge';
const RETRY_STATUSES = new Set([429, 529]);

export type QuestionType = 'noul' | 'choice' | 'score';

export interface Question {
  type: QuestionType;
  instructions: unknown;
  criteria?: unknown;
}

export interface JudgeRequest {
  state: unknown;
  model: string;
  questions: Record<string, Question>;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JudgeResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type Decision = 'act' | 'propose' | 'withhold';

export interface Gate {
  decision: Decision;
  /** The number the decision was made on: confidence for choice/score, max(p, 1-p) for noul. */
  certainty: number;
  /** What the answer is, in the shape code acts on. */
  value: string | number | boolean;
  /** Score only: the nearest level index and its legend text. */
  level?: { index: number; text: string };
}

export interface GateThresholds {
  act: number;
  propose: number;
  noulAct: number;
  noulPropose: number;
}

/**
 * Defaults measured against nanocoai/nanoclaw triage: 0.6 confidence was the
 * proposal floor for area/kind/priority, 0.7 the yes/no floor. "act" sits
 * above those so an unattended run only labels what the model is sure about.
 */
export const DEFAULT_THRESHOLDS: GateThresholds = { act: 0.8, propose: 0.6, noulAct: 0.85, noulPropose: 0.7 };

export interface CliOptions {
  input?: string;
  state?: unknown;
  questions?: Record<string, Question>;
  model?: string;
  gate: boolean;
  thresholds: GateThresholds;
  pretty: boolean;
  help: boolean;
  timeoutMs: number;
  attempts: number;
}

export class UsageError extends Error {}
export class AuthError extends Error {}
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const HELP = `typesafe-judge — typed judgments from TypeSafe Jev (no text generation)

Usage:
  typesafe-judge [flags] < request.json
  typesafe-judge --input request.json [--gate]
  typesafe-judge --state '<json or text>' --questions '<json>' [--gate]
  typesafe-judge --state @item.json --noul "Is this a bug report?" --gate

Request JSON: { "state": <string|object|array>, "questions": { "<id>": Question }, "model"?: "jev-latest" }
Question:     { "type": "noul"|"choice"|"score", "instructions": string, "criteria": ... }
  noul    criteria optional: { "true": "...", "false": "..." }   → answer.noul (probability of yes)
  choice  criteria required: { "<option>": "rubric", ... }        → answer.choice + probabilities + confidence
  score   criteria required: [ "level 0 desc", "level 1 desc" ]   → answer.score + legend + probabilities + confidence

Flags:
  --input <file>            Read the request JSON from a file instead of stdin
  --state <json|text|@file> State to judge (inline JSON, plain text, or @path)
  --questions <json|@file>  Questions map (inline JSON or @path); merged with shorthands
  --noul "<question>"       Shorthand: one noul question (id "noul")
  --choice "<question>" --options "a:rubric|b:rubric"   Shorthand choice (id "choice")
  --score "<question>" --levels "low desc|mid desc|high desc"   Shorthand score (id "score")
  --model <name>            Default jev-latest
  --gate                    Add gate.<id> = { decision: act|propose|withhold, certainty, value, level? }
  --act <0-1>               Confidence to act on a choice/score (default ${DEFAULT_THRESHOLDS.act})
  --propose <0-1>           Confidence to propose (default ${DEFAULT_THRESHOLDS.propose})
  --noul-act <0.5-1>        max(p,1-p) to act on a noul (default ${DEFAULT_THRESHOLDS.noulAct})
  --noul-propose <0.5-1>    max(p,1-p) to propose on a noul (default ${DEFAULT_THRESHOLDS.noulPropose})
  --compact                 Single-line JSON output
  --timeout <seconds>       Per-request timeout (default 60)
  -h, --help                This text

Exit codes: 0 ok, 1 usage/input, 2 credential not connected (401/403), 3 upstream failure.
Auth is injected by the credential gateway; this tool never sees the key.`;

function parseNumber(flag: string, raw: string | undefined, min: number, max: number): number {
  if (raw === undefined) throw new UsageError(`${flag} needs a value`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} must be a number between ${min} and ${max}`);
  return n;
}

function readArgValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new UsageError(`${flag} needs a value`);
  return v;
}

/** `@path` reads a file; anything else is returned as-is. */
function expandAt(raw: string, readFile: (p: string) => string): string {
  return raw.startsWith('@') ? readFile(raw.slice(1)) : raw;
}

/** Inline JSON when it parses; otherwise the literal text (state may be prose). */
function jsonOrText(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function parsePairs(flag: string, raw: string): [string, string][] {
  const pairs = raw
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): [string, string] => {
      const idx = s.indexOf(':');
      if (idx < 1) throw new UsageError(`${flag} entries look like "key:rubric" separated by |`);
      return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
    });
  if (pairs.length < 2) throw new UsageError(`${flag} needs at least two entries`);
  return pairs;
}

export function parseArgs(argv: string[], readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): CliOptions {
  const opts: CliOptions = {
    gate: false,
    thresholds: { ...DEFAULT_THRESHOLDS },
    pretty: true,
    help: false,
    timeoutMs: 60_000,
    attempts: 4,
  };
  const shorthand: Record<string, Question> = {};
  let choiceOptions: string | undefined;
  let scoreLevels: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--input':
        opts.input = readArgValue(argv, i++, a);
        break;
      case '--state':
        opts.state = jsonOrText(expandAt(readArgValue(argv, i++, a), readFile));
        break;
      case '--questions': {
        const parsed = jsonOrText(expandAt(readArgValue(argv, i++, a), readFile));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new UsageError('--questions must be a JSON object of id → question');
        }
        opts.questions = { ...(opts.questions ?? {}), ...(parsed as Record<string, Question>) };
        break;
      }
      case '--noul':
        shorthand.noul = { type: 'noul', instructions: readArgValue(argv, i++, a) };
        break;
      case '--choice':
        shorthand.choice = { type: 'choice', instructions: readArgValue(argv, i++, a) };
        break;
      case '--options':
        choiceOptions = readArgValue(argv, i++, a);
        break;
      case '--score':
        shorthand.score = { type: 'score', instructions: readArgValue(argv, i++, a) };
        break;
      case '--levels':
        scoreLevels = readArgValue(argv, i++, a);
        break;
      case '--model':
        opts.model = readArgValue(argv, i++, a);
        break;
      case '--gate':
        opts.gate = true;
        break;
      case '--act':
        opts.thresholds.act = parseNumber(a, argv[++i], 0, 1);
        break;
      case '--propose':
        opts.thresholds.propose = parseNumber(a, argv[++i], 0, 1);
        break;
      case '--noul-act':
        opts.thresholds.noulAct = parseNumber(a, argv[++i], 0.5, 1);
        break;
      case '--noul-propose':
        opts.thresholds.noulPropose = parseNumber(a, argv[++i], 0.5, 1);
        break;
      case '--compact':
        opts.pretty = false;
        break;
      case '--timeout':
        opts.timeoutMs = parseNumber(a, argv[++i], 1, 600) * 1000;
        break;
      default:
        throw new UsageError(`unknown flag ${a} (see --help)`);
    }
  }

  if (shorthand.choice) {
    if (!choiceOptions) throw new UsageError('--choice needs --options "a:rubric|b:rubric"');
    shorthand.choice.criteria = Object.fromEntries(parsePairs('--options', choiceOptions));
  } else if (choiceOptions) {
    throw new UsageError('--options only makes sense with --choice');
  }
  if (shorthand.score) {
    if (!scoreLevels) throw new UsageError('--score needs --levels "low|mid|high"');
    const levels = scoreLevels
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (levels.length < 2) throw new UsageError('--levels needs at least two levels');
    shorthand.score.criteria = levels;
  } else if (scoreLevels) {
    throw new UsageError('--levels only makes sense with --score');
  }
  if (Object.keys(shorthand).length > 0) opts.questions = { ...(opts.questions ?? {}), ...shorthand };
  if (opts.thresholds.propose > opts.thresholds.act) throw new UsageError('--propose must not exceed --act');
  if (opts.thresholds.noulPropose > opts.thresholds.noulAct) throw new UsageError('--noul-propose must not exceed --noul-act');
  return opts;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateQuestions(raw: unknown): Record<string, Question> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    throw new UsageError('questions must be a non-empty object of id → { type, instructions, criteria? }');
  }
  const out: Record<string, Question> = {};
  for (const [id, q] of Object.entries(raw)) {
    if (!isRecord(q)) throw new UsageError(`question "${id}" must be an object`);
    const type = q.type;
    if (type !== 'noul' && type !== 'choice' && type !== 'score') {
      throw new UsageError(`question "${id}": type must be noul, choice or score`);
    }
    if (q.instructions === undefined || q.instructions === '') {
      throw new UsageError(`question "${id}": instructions are required`);
    }
    if (type === 'choice') {
      if (!isRecord(q.criteria) || Object.keys(q.criteria).length < 2) {
        throw new UsageError(`question "${id}": a choice needs criteria with at least two options`);
      }
    } else if (type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        throw new UsageError(`question "${id}": a score needs criteria as an ordered array of at least two levels`);
      }
    } else if (q.criteria !== undefined && !isRecord(q.criteria)) {
      throw new UsageError(`question "${id}": noul criteria, when given, are { "true": ..., "false": ... }`);
    }
    out[id] = { type, instructions: q.instructions, ...(q.criteria === undefined ? {} : { criteria: q.criteria }) };
  }
  return out;
}

/** Merge stdin/--input JSON with flag overrides into one validated request. */
export function buildRequest(opts: CliOptions, body: string | undefined): JudgeRequest {
  let base: Record<string, unknown> = {};
  if (body !== undefined && body.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new UsageError(`request is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isRecord(parsed)) throw new UsageError('request JSON must be an object with state and questions');
    base = parsed;
  }
  const state = opts.state !== undefined ? opts.state : base.state;
  if (state === undefined) throw new UsageError('state is required (stdin JSON, --input, or --state)');
  const questions = validateQuestions({
    ...(isRecord(base.questions) ? base.questions : {}),
    ...(opts.questions ?? {}),
  });
  const model = opts.model ?? (typeof base.model === 'string' && base.model ? base.model : DEFAULT_MODEL);
  return { state, model, questions };
}

function decide(certainty: number, act: number, propose: number): Decision {
  if (certainty >= act) return 'act';
  if (certainty >= propose) return 'propose';
  return 'withhold';
}

/** Map one answer to act / propose / withhold. Pure; safe to re-run with new thresholds. */
export function gateAnswer(answer: Answer, t: GateThresholds = DEFAULT_THRESHOLDS): Gate {
  switch (answer.type) {
    case 'noul': {
      const p = answer.noul;
      const certainty = Math.max(p, 1 - p);
      return { decision: decide(certainty, t.noulAct, t.noulPropose), certainty, value: p >= 0.5 };
    }
    case 'choice':
      return { decision: decide(answer.confidence, t.act, t.propose), certainty: answer.confidence, value: answer.choice };
    case 'score': {
      const index = Math.max(0, Math.min(Object.keys(answer.legend).length - 1, Math.floor(answer.score + 0.5)));
      return {
        decision: decide(answer.confidence, t.act, t.propose),
        certainty: answer.confidence,
        value: answer.score,
        level: { index, text: answer.legend[String(index)] ?? '' },
      };
    }
  }
}

export function gateAll(answers: Record<string, Answer>, t: GateThresholds = DEFAULT_THRESHOLDS): Record<string, Gate> {
  return Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, gateAnswer(a, t)]));
}

export interface Transport {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * An answer counts only when it matches the question it answers: same
 * primitive, probabilities in [0, 1], a choice among the offered options, a
 * score within the offered levels. Anything else is an upstream defect, and
 * an upstream defect must never become an `act`.
 */
export function answerMatches(question: Question, v: unknown): v is Answer {
  if (!isRecord(v) || v.type !== question.type) return false;
  if (v.type === 'noul') return unit(v.noul);
  if (v.type === 'choice') {
    const options = isRecord(question.criteria) ? Object.keys(question.criteria) : [];
    return (
      typeof v.choice === 'string' &&
      options.includes(v.choice) &&
      isRecord(v.probabilities) &&
      Object.values(v.probabilities).every(unit) &&
      unit(v.confidence)
    );
  }
  if (v.type === 'score') {
    const levels = Array.isArray(question.criteria) ? question.criteria.length : 0;
    return (
      typeof v.score === 'number' &&
      Number.isFinite(v.score) &&
      v.score >= 0 &&
      v.score <= Math.max(0, levels - 1) &&
      isRecord(v.legend) &&
      isRecord(v.probabilities) &&
      Object.values(v.probabilities).every(unit) &&
      unit(v.confidence)
    );
  }
  return false;
}

/** POST one request through the gateway; retries 429/529 with exponential backoff. */
export async function evaluate(
  request: JudgeRequest,
  transport: Transport,
  { timeoutMs = 60_000, attempts = 4 }: { timeoutMs?: number; attempts?: number } = {},
): Promise<JudgeResponse> {
  const body = JSON.stringify(request);
  let delay = 1000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await transport.fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PLACEHOLDER_CREDENTIAL}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt === attempts) throw new UpstreamError(`could not reach TypeSafe through the gateway: ${reason}`);
      await transport.sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      // The body is deliberately not surfaced: an auth error is the one place a
      // gateway or upstream might echo the header it rejected.
      throw new AuthError(`TypeSafe returned ${res.status}: the api.typesafe.ai credential is not connected in the gateway`);
    }
    if (RETRY_STATUSES.has(res.status)) {
      if (attempt === attempts) throw new UpstreamError(`TypeSafe returned ${res.status} after ${attempts} attempts`, res.status);
      await transport.sleep(delay);
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      throw new UpstreamError(`TypeSafe returned ${res.status}: ${await safeText(res)}`, res.status);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new UpstreamError('TypeSafe returned a non-JSON body', res.status);
    }
    if (!isRecord(parsed) || !isRecord(parsed.answers)) throw new UpstreamError('TypeSafe response has no answers map', res.status);
    const answers: Record<string, Answer> = {};
    for (const id of Object.keys(request.questions)) {
      const a = parsed.answers[id];
      if (!answerMatches(request.questions[id], a)) {
        throw new UpstreamError(`TypeSafe response is missing a well-formed ${request.questions[id].type} answer for "${id}"`, res.status);
      }
      answers[id] = a;
    }
    return {
      model: typeof parsed.model === 'string' ? parsed.model : request.model,
      answers,
      ...(isRecord(parsed.usage) ? { usage: parsed.usage as JudgeResponse['usage'] } : {}),
    };
  }
  throw new UpstreamError('TypeSafe request failed');
}

/** Strip anything shaped like a credential from text that reaches stderr. */
export function redact(text: string): string {
  return text
    .replace(/\b(bearer|token|key|secret|authorization)\b(\s*[:=]?\s*)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]');
}

/** Bounded, single-line, redacted error text. */
async function safeText(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, ' ').trim();
    return redact(text.slice(0, 300));
  } catch {
    return '';
  }
}

export interface RunIo {
  stdin: () => Promise<string>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readFile: (p: string) => string;
  transport: Transport;
}

/** Full CLI run; returns the exit code. */
export async function run(argv: string[], io: RunIo): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv, io.readFile);
  } catch (err) {
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (opts.help) {
    io.stdout(HELP + '\n');
    return 0;
  }
  try {
    let body: string | undefined;
    if (opts.input) body = io.readFile(opts.input);
    else if (opts.state === undefined) body = await io.stdin();
    const request = buildRequest(opts, body);
    const response = await evaluate(request, io.transport, { timeoutMs: opts.timeoutMs, attempts: opts.attempts });
    const out: Record<string, unknown> = { model: response.model, answers: response.answers };
    if (response.usage) out.usage = response.usage;
    if (opts.gate) out.gate = gateAll(response.answers, opts.thresholds);
    io.stdout(JSON.stringify(out, null, opts.pretty ? 2 : 0) + '\n');
    return 0;
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    if (err instanceof UsageError) {
      io.stderr(`error: ${message}\n`);
      return 1;
    }
    if (err instanceof AuthError) {
      io.stderr(
        `error: ${message}\n` +
          'Ask the operator to store the TypeSafe API key in the credential gateway for host api.typesafe.ai ' +
          '(on the host: /add-typesafe-tool), then retry. Never ask for the key in chat.\n',
      );
      return 2;
    }
    io.stderr(`error: ${message}\n`);
    return 3;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const invokedDirectly = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run(process.argv.slice(2), {
    stdin: readStdin,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readFile: (p) => readFileSync(p, 'utf8'),
    transport: { fetch: (...args) => fetch(...args), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error: unexpected ${redact(err instanceof Error ? err.message : String(err))}\n`);
      process.exit(3);
    },
  );
}
