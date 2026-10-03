/**
 * Unit tests for the typesafe-judge CLI (bun:test, mocked fetch).
 *
 * Run from the skill directory: `cd container/skills/typesafe-judge && bun test`.
 * No network: every request goes to a fake fetch that records what the CLI
 * would have sent, so the tests also prove the credential is always the
 * gateway placeholder and never anything from the environment.
 */
import { describe, expect, it } from 'bun:test';

import {
  API_URL,
  DEFAULT_MODEL,
  DEFAULT_THRESHOLDS,
  PLACEHOLDER_CREDENTIAL,
  UsageError,
  buildRequest,
  evaluate,
  gateAnswer,
  parseArgs,
  redact,
  retryAfterMs,
  run,
  type Answer,
  type RunIo,
  type Transport,
} from './typesafe-judge.ts';

interface Recorded {
  url: string;
  init: RequestInit;
  body: unknown;
}

function fakeTransport(responses: Array<{ status: number; body: unknown }>): { transport: Transport; calls: Recorded[]; sleeps: number[] } {
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const transport: Transport = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const next = responses[Math.min(i++, responses.length - 1)];
      calls.push({ url: String(url), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { transport, calls, sleeps };
}

const okAnswers = {
  model: 'jev-latest',
  answers: {
    is_bug: { type: 'noul', noul: 0.92 },
    area: { type: 'choice', choice: 'area/core', probabilities: { 'area/core': 0.9, 'area/skills': 0.1 }, confidence: 0.88 },
    priority: {
      type: 'score',
      score: 1.6,
      legend: { '0': 'low', '1': 'medium', '2': 'high' },
      probabilities: { '0': 0.05, '1': 0.3, '2': 0.65 },
      confidence: 0.7,
    },
  },
  usage: { input_tokens: 300, output_tokens: 40 },
};

const threeQuestions = {
  is_bug: { type: 'noul', instructions: 'Does `body` report a defect?' },
  area: { type: 'choice', instructions: 'Which area?', criteria: { 'area/core': 'host', 'area/skills': 'skills' } },
  priority: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] },
};

function io(overrides: Partial<RunIo> & { transport: Transport }): RunIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdin: async () => '',
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    readFile: () => {
      throw new Error('no files in this test');
    },
    ...overrides,
    out,
    err,
  };
}

describe('parseArgs', () => {
  it('builds the three primitives from shorthand flags in one fan-out', () => {
    const opts = parseArgs([
      '--state',
      'Payouts failing for 3 days',
      '--noul',
      'Is this urgent?',
      '--choice',
      'Which team?',
      '--options',
      'billing:money|technical:bugs',
      '--score',
      'How angry?',
      '--levels',
      'calm|annoyed|furious',
      '--gate',
    ]);
    expect(opts.state).toBe('Payouts failing for 3 days');
    expect(opts.questions).toEqual({
      noul: { type: 'noul', instructions: 'Is this urgent?' },
      choice: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'money', technical: 'bugs' } },
      score: { type: 'score', instructions: 'How angry?', criteria: ['calm', 'annoyed', 'furious'] },
    });
    expect(opts.gate).toBe(true);
  });

  it('parses inline JSON state and @file questions', () => {
    const files: Record<string, string> = { 'q.json': JSON.stringify({ q1: { type: 'noul', instructions: 'x' } }) };
    const opts = parseArgs(['--state', '{"title":"t"}', '--questions', '@q.json'], (p) => files[p]);
    expect(opts.state).toEqual({ title: 't' });
    expect(opts.questions).toEqual({ q1: { type: 'noul', instructions: 'x' } });
  });

  it('rejects an unknown flag, a dangling --options, and inverted thresholds', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(UsageError);
    expect(() => parseArgs(['--options', 'a:b|c:d'])).toThrow(/--choice/);
    expect(() => parseArgs(['--act', '0.5', '--propose', '0.7'])).toThrow(/--propose must not exceed/);
    expect(() => parseArgs(['--noul-act', '0.3'])).toThrow(/between 0.5 and 1/);
  });
});

describe('buildRequest', () => {
  it('reads state + questions from the JSON body and defaults the model', () => {
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: { a: 1 }, questions: threeQuestions }));
    expect(req.model).toBe(DEFAULT_MODEL);
    expect(req.state).toEqual({ a: 1 });
    expect(Object.keys(req.questions)).toEqual(['is_bug', 'area', 'priority']);
  });

  it('lets flags override the body and merges shorthand questions into it', () => {
    const req = buildRequest(
      parseArgs(['--model', 'jev-2', '--noul', 'extra?']),
      JSON.stringify({ state: 'x', model: 'jev-latest', questions: { area: threeQuestions.area } }),
    );
    expect(req.model).toBe('jev-2');
    expect(Object.keys(req.questions).sort()).toEqual(['area', 'noul']);
  });

  it('refuses more questions than the per-call ceiling unless it is raised deliberately', () => {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `q ${i}?` }]));
    const body = JSON.stringify({ state: 'x', questions: many });
    expect(() => buildRequest(parseArgs([]), body)).toThrow(/65 questions exceed the per-call ceiling of 64/);
    expect(Object.keys(buildRequest(parseArgs(['--max-questions', '100']), body).questions)).toHaveLength(65);
    expect(() => buildRequest(parseArgs(['--max-questions', '2']), JSON.stringify({ state: 'x', questions: threeQuestions }))).toThrow(/ceiling of 2/);
  });

  it('validates each primitive shape', () => {
    const bad = (questions: unknown) => () => buildRequest(parseArgs([]), JSON.stringify({ state: 'x', questions }));
    expect(bad({})).toThrow(/non-empty/);
    expect(bad({ q: { type: 'maybe', instructions: 'x' } })).toThrow(/type must be/);
    expect(bad({ q: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } })).toThrow(/at least two options/);
    expect(bad({ q: { type: 'score', instructions: 'x', criteria: 'low,high' } })).toThrow(/ordered array/);
    expect(bad({ q: { type: 'noul', instructions: '' } })).toThrow(/instructions are required/);
    expect(() => buildRequest(parseArgs([]), '{"questions":{}}')).toThrow(/state is required/);
    expect(() => buildRequest(parseArgs([]), 'not json')).toThrow(/not valid JSON/);
  });
});

describe('gateAnswer', () => {
  const t = DEFAULT_THRESHOLDS;
  it('maps noul probability to act / propose / withhold on both sides of 0.5', () => {
    expect(gateAnswer({ type: 'noul', noul: 0.92 }, t)).toEqual({ decision: 'act', certainty: 0.92, value: true });
    expect(gateAnswer({ type: 'noul', noul: 0.25 }, t)).toMatchObject({ decision: 'propose', value: false });
    expect(gateAnswer({ type: 'noul', noul: 0.55 }, t)).toMatchObject({ decision: 'withhold', value: true });
    expect(gateAnswer({ type: 'noul', noul: 0.1 }, t)).toMatchObject({ decision: 'act', value: false });
  });

  it('maps choice confidence and carries the chosen option', () => {
    const a: Answer = { type: 'choice', choice: 'x', probabilities: { x: 0.7, y: 0.3 }, confidence: 0.65 };
    expect(gateAnswer(a, t)).toEqual({ decision: 'propose', certainty: 0.65, value: 'x' });
    expect(gateAnswer({ ...a, confidence: 0.81 }, t).decision).toBe('act');
    expect(gateAnswer({ ...a, confidence: 0.2 }, t).decision).toBe('withhold');
  });

  it('rounds a score half-up to a level and returns its legend text', () => {
    const a: Answer = {
      type: 'score',
      score: 1.5,
      legend: { '0': 'low', '1': 'medium', '2': 'high' },
      probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
      confidence: 0.9,
    };
    expect(gateAnswer(a, t)).toEqual({ decision: 'act', certainty: 0.9, value: 1.5, level: { index: 2, text: 'high' } });
    expect(gateAnswer({ ...a, score: 0.49 }, t).level).toEqual({ index: 0, text: 'low' });
    expect(gateAnswer({ ...a, score: 9 }, t).level?.index).toBe(2);
  });

  it('honors custom thresholds', () => {
    const custom = { act: 0.95, propose: 0.9, noulAct: 0.99, noulPropose: 0.6 };
    expect(gateAnswer({ type: 'choice', choice: 'x', probabilities: {}, confidence: 0.92 }, custom).decision).toBe('propose');
    expect(gateAnswer({ type: 'noul', noul: 0.7 }, custom).decision).toBe('propose');
  });
});

describe('evaluate (mocked fetch)', () => {
  it('POSTs the request to the TypeSafe endpoint with the placeholder bearer only', async () => {
    const { transport, calls } = fakeTransport([{ status: 200, body: okAnswers }]);
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    const res = await evaluate(req, transport);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(API_URL);
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${PLACEHOLDER_CREDENTIAL}`);
    expect(calls[0].body).toEqual({ state: 's', model: DEFAULT_MODEL, questions: threeQuestions });
    expect(Object.keys(res.answers)).toEqual(['is_bug', 'area', 'priority']);
    expect(res.usage).toEqual({ input_tokens: 300, output_tokens: 40 });
  });

  it('retries 429 and 529 with exponential backoff, then succeeds', async () => {
    const { transport, calls, sleeps } = fakeTransport([
      { status: 429, body: { error: 'slow down' } },
      { status: 529, body: { error: 'overloaded' } },
      { status: 200, body: okAnswers },
    ]);
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    await evaluate(req, transport);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('gives up after the attempt budget on persistent overload', async () => {
    const { transport, calls } = fakeTransport([{ status: 529, body: {} }]);
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    await expect(evaluate(req, transport, { attempts: 2 })).rejects.toThrow(/529 after 2 attempts/);
    expect(calls).toHaveLength(2);
  });

  it('turns 401 into a missing-credential AuthError without retrying', async () => {
    const { transport, calls } = fakeTransport([{ status: 401, body: { error: 'app_not_connected' } }]);
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    await expect(evaluate(req, transport)).rejects.toThrow(/401: the api.typesafe.ai credential is missing or rejected/);
    expect(calls).toHaveLength(1);
  });

  it('diagnoses 403 as policy, permission or quota, not as a missing credential', async () => {
    const { transport, calls } = fakeTransport([{ status: 403, body: { error: 'blocked_by_policy' } }]);
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    const err = await evaluate(req, transport).catch((e: Error) => e.message);
    expect(err).toMatch(/403: the request was refused/);
    expect(err).toMatch(/gateway policy/);
    expect(err).toMatch(/quota/);
    expect(err).not.toMatch(/missing or rejected/);
    expect(calls).toHaveLength(1);
  });

  it('waits at least Retry-After on 429 and falls back to backoff without it', async () => {
    const calls: number[] = [];
    let n = 0;
    const transport: Transport = {
      fetch: (async () => {
        n++;
        if (n === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '7' } });
        if (n === 2) return new Response('{}', { status: 429, headers: { 'Retry-After': '45' } });
        if (n === 3) return new Response('{}', { status: 529 });
        return new Response(JSON.stringify(okAnswers), { status: 200 });
      }) as typeof fetch,
      sleep: async (ms) => void calls.push(ms),
    };
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    await evaluate(req, transport);
    expect(calls).toEqual([7000, 45_000, 4000]);
    expect(retryAfterMs(null)).toBe(0);
    expect(retryAfterMs('garbage')).toBe(0);
    expect(retryAfterMs('Wed, 17 Sep 2026 00:00:10 GMT', Date.parse('2026-09-17T00:00:00Z'))).toBe(10_000);
  });

  it('rejects a score that disagrees with its own distribution, or whose legend does not name the levels', async () => {
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    const bad = (priority: unknown) =>
      evaluate(req, fakeTransport([{ status: 200, body: { model: 'jev-latest', answers: { ...okAnswers.answers, priority } } }]).transport);
    const p = okAnswers.answers.priority;
    await expect(bad({ ...p, score: 2, probabilities: { '0': 1, '1': 0, '2': 0 }, confidence: 1 })).rejects.toThrow(/score answer for "priority"/);
    await expect(bad({ ...p, legend: {} })).rejects.toThrow(/score answer for "priority"/);
    await expect(bad({ ...p, legend: { '0': 'low', '1': 'medium' } })).rejects.toThrow(/score answer for "priority"/);
    await expect(bad(p)).resolves.toBeDefined(); // 0*0.05 + 1*0.3 + 2*0.65 = 1.6
    // A legend that names the right number of levels with the wrong text (reversed,
    // renamed) would let gate.level label a level with the opposite meaning.
    await expect(bad({ ...p, legend: { '0': 'high', '1': 'medium', '2': 'low' } })).rejects.toThrow(/score answer for "priority"/);
    await expect(bad({ ...p, legend: { '0': 'low', '1': 'medium', '2': 'critical' } })).rejects.toThrow(/score answer for "priority"/);
  });

  it('accepts structured level descriptions and echoes the nearest one in gate.level', async () => {
    const levels = [
      { name: 'low', description: 'cosmetic' },
      { name: 'high', description: 'core broken' },
    ];
    const questions = { urgency: { type: 'score', instructions: 'How urgent?', criteria: levels } };
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions }));
    const answer = { type: 'score', score: 1, confidence: 0.99, legend: { '0': levels[0], '1': levels[1] }, probabilities: { '0': 0, '1': 1 } };
    const { transport } = fakeTransport([{ status: 200, body: { model: 'jev-latest', answers: { urgency: answer } } }]);
    const res = await evaluate(req, transport);
    expect(gateAnswer(res.answers.urgency).level).toEqual({ index: 1, text: JSON.stringify(levels[1]) });
    const swapped = { ...answer, legend: { '0': levels[1], '1': levels[0] } };
    await expect(
      evaluate(req, fakeTransport([{ status: 200, body: { model: 'jev-latest', answers: { urgency: swapped } } }]).transport),
    ).rejects.toThrow(/score answer for "urgency"/);
  });

  it('turns a rate limit that will not clear soon into exit 5 so loops stop, instead of retrying into it', async () => {
    const long = { fetch: (async () => new Response('{}', { status: 429, headers: { 'Retry-After': '1800' } })) as typeof fetch, sleep: async () => {} };
    const ctx = io({ transport: long, stdin: async () => JSON.stringify({ state: 's', questions: threeQuestions }) });
    expect(await run([], ctx)).toBe(5);
    expect(ctx.err.join('')).toMatch(/rate limited \(429\), retry after about 1800s/);
    expect(ctx.err.join('')).toMatch(/Stop the loop/);
    // A 429 with no header that never clears also ends as exit 5, after the retries.
    const stuck = fakeTransport([{ status: 429, body: {} }]);
    const ctx2 = io({ transport: stuck.transport, stdin: async () => JSON.stringify({ state: 's', questions: threeQuestions }) });
    expect(await run([], ctx2)).toBe(5);
    expect(stuck.calls).toHaveLength(4);
  });

  it('rejects a choice that is not the argmax of its own distribution, and distributions that do not sum to 1', async () => {
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    const bad = (answers: Record<string, unknown>) =>
      evaluate(req, fakeTransport([{ status: 200, body: { model: 'jev-latest', answers: { ...okAnswers.answers, ...answers } } }]).transport);
    await expect(bad({ area: { type: 'choice', choice: 'area/skills', probabilities: { 'area/core': 0.9, 'area/skills': 0.1 }, confidence: 0.9 } })).rejects.toThrow(
      /choice answer for "area"/,
    );
    await expect(bad({ area: { type: 'choice', choice: 'area/core', probabilities: { 'area/core': 0.9, 'area/skills': 0.6 }, confidence: 0.9 } })).rejects.toThrow(
      /choice answer for "area"/,
    );
    await expect(bad({ area: { type: 'choice', choice: 'area/core', probabilities: { 'area/core': 1 }, confidence: 0.9 } })).rejects.toThrow(/choice answer for "area"/);
    await expect(bad({ priority: { ...okAnswers.answers.priority, probabilities: { '0': 0.5, '1': 0.5, '2': 0.5 } } })).rejects.toThrow(/score answer for "priority"/);
    // A tie at the top is a legitimate argmax.
    await expect(bad({ area: { type: 'choice', choice: 'area/skills', probabilities: { 'area/core': 0.5, 'area/skills': 0.5 }, confidence: 0.1 } })).resolves.toBeDefined();
  });

  it('rejects answers that do not match their question: wrong primitive, out-of-range, unknown option', async () => {
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    const bad = (answers: Record<string, unknown>) =>
      evaluate(req, fakeTransport([{ status: 200, body: { model: 'jev-latest', answers: { ...okAnswers.answers, ...answers } } }]).transport);
    await expect(bad({ is_bug: { type: 'noul', noul: 8 } })).rejects.toThrow(/well-formed noul answer for "is_bug"/);
    await expect(bad({ is_bug: { type: 'choice', choice: 'x', probabilities: {}, confidence: 1 } })).rejects.toThrow(/noul answer for "is_bug"/);
    await expect(bad({ area: { ...okAnswers.answers.area, choice: 'area/unlisted' } })).rejects.toThrow(/choice answer for "area"/);
    await expect(bad({ area: { ...okAnswers.answers.area, confidence: 1.7 } })).rejects.toThrow(/choice answer for "area"/);
    await expect(bad({ priority: { ...okAnswers.answers.priority, score: 3.2 } })).rejects.toThrow(/score answer for "priority"/);
  });

  it('never prints a credential-shaped body: 401 bodies are dropped, other bodies are redacted', async () => {
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    const auth = fakeTransport([{ status: 401, body: { error: 'Invalid Authorization: Bearer FAKE_SECRET_SENTINEL_0123456789' } }]);
    await expect(evaluate(req, auth.transport)).rejects.not.toThrow(/SENTINEL/);
    const server = fakeTransport([{ status: 500, body: { error: 'upstream saw Authorization: Bearer FAKE_SECRET_SENTINEL_0123456789 and token=abc' } }]);
    const err = await evaluate(req, server.transport).catch((e: Error) => e.message);
    expect(err).toContain('500');
    expect(err).not.toContain('SENTINEL');
    expect(err).not.toContain('token=abc');
    expect(redact('key: sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).not.toContain('sk-live');
    // Redaction runs before truncation: a secret straddling the 300-character
    // cut must not survive as a prefix the length-based matcher no longer sees.
    const padded = fakeTransport([{ status: 500, body: { error: 'x'.repeat(270) + ' api_key: FAKE_SECRET_SENTINEL_0123456789' } }]);
    const err2 = await evaluate(req, padded.transport).catch((e: Error) => e.message);
    expect(err2).not.toContain('FAKE_SECRET');
  });

  it('defaults the request timeout past one 120 s approval card', () => {
    expect(parseArgs([]).timeoutMs).toBe(150_000);
    expect(parseArgs(['--timeout', '30']).timeoutMs).toBe(30_000);
  });

  it('rejects a response missing an answer for an asked question', async () => {
    const { transport } = fakeTransport([{ status: 200, body: { model: 'jev-latest', answers: { is_bug: { type: 'noul', noul: 0.4 } } } }]);
    const req = buildRequest(parseArgs([]), JSON.stringify({ state: 's', questions: threeQuestions }));
    await expect(evaluate(req, transport)).rejects.toThrow(/missing a well-formed choice answer for "area"/);
  });
});

describe('run (end to end with stdin)', () => {
  it('reads the request from stdin and prints answers plus gate decisions', async () => {
    const { transport } = fakeTransport([{ status: 200, body: okAnswers }]);
    const ctx = io({ transport, stdin: async () => JSON.stringify({ state: 's', questions: threeQuestions }) });
    const code = await run(['--gate', '--compact'], ctx);
    expect(code).toBe(0);
    expect(ctx.err).toEqual([]);
    const printed = JSON.parse(ctx.out.join(''));
    expect(printed.answers.area.choice).toBe('area/core');
    expect(printed.gate).toEqual({
      is_bug: { decision: 'act', certainty: 0.92, value: true },
      area: { decision: 'act', certainty: 0.88, value: 'area/core' },
      priority: { decision: 'propose', certainty: 0.7, value: 1.6, level: { index: 2, text: 'high' } },
    });
    expect(ctx.out.join('')).not.toContain('\n  ');
  });

  it('exits 1 on a usage error, 2 on a missing credential, 3 on upstream failure', async () => {
    const usage = io({ transport: fakeTransport([{ status: 200, body: okAnswers }]).transport, stdin: async () => '{}' });
    expect(await run([], usage)).toBe(1);
    expect(usage.err.join('')).toMatch(/state is required/);

    const auth = io({
      transport: fakeTransport([{ status: 403, body: {} }]).transport,
      stdin: async () => JSON.stringify({ state: 's', questions: threeQuestions }),
    });
    expect(await run([], auth)).toBe(2);
    expect(auth.err.join('')).toMatch(/gateway rules/);
    expect(auth.err.join('')).toMatch(/Do not retry in a loop/);
    expect(auth.err.join('')).not.toMatch(/Bearer/);

    const missing = io({
      transport: fakeTransport([{ status: 401, body: {} }]).transport,
      stdin: async () => JSON.stringify({ state: 's', questions: threeQuestions }),
    });
    expect(await run([], missing)).toBe(2);
    expect(missing.err.join('')).toMatch(/add-typesafe-tool/);

    const upstream = io({
      transport: fakeTransport([{ status: 500, body: { error: 'boom' } }]).transport,
      stdin: async () => JSON.stringify({ state: 's', questions: threeQuestions }),
    });
    expect(await run([], upstream)).toBe(3);
    expect(upstream.err.join('')).toMatch(/500/);
  });

  it('prints help and exits 0', async () => {
    const ctx = io({ transport: fakeTransport([]).transport });
    expect(await run(['--help'], ctx)).toBe(0);
    expect(ctx.out.join('')).toContain('typesafe-judge');
  });
});
