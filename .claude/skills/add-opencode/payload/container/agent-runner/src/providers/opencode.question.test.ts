import { describe, it, expect } from 'bun:test';

import {
  autoAnswerQuestion,
  drainPendingQuestions,
  handleQuestionAsked,
  QUESTION_STEERING_TEXT,
  type QuestionClient,
} from './opencode.js';

/**
 * Fake `/v2` question client — captures every reply/list call so tests can
 * assert what OpenCodeProvider sends back without spawning a real server.
 * These unit tests check reply/list behavior for native request shapes.
 * opencode.shared-runtime.test.ts separately drives question.asked through
 * the production event pump and requires its reply before the turn completes.
 */
function createFakeQuestionClient(
  opts: {
    pending?: Array<{ id: string; sessionID?: string; questions?: unknown[] }>;
    replyError?: unknown;
  } = {},
): { client: QuestionClient; replyCalls: Array<{ requestID: string; answers: string[][] }> } {
  const replyCalls: Array<{ requestID: string; answers: string[][] }> = [];
  const client: QuestionClient = {
    question: {
      async reply(params) {
        replyCalls.push(params);
        if (opts.replyError) return { error: opts.replyError };
        return { data: true };
      },
      async list() {
        return { data: opts.pending ?? [] };
      },
    },
  };
  return { client, replyCalls };
}

describe('autoAnswerQuestion', () => {
  it('replies with one steering-text answer per sub-question — the wedge-path fix', async () => {
    const { client, replyCalls } = createFakeQuestionClient();

    // Simulates a `question.asked` event's properties for a two-part question.
    await autoAnswerQuestion(client, {
      id: 'que_f931faf310018jM9tBPKPMsezK',
      questions: [{ question: 'Proceed with deletion?' }, { question: 'Which target?' }],
    });

    expect(replyCalls).toEqual([
      {
        requestID: 'que_f931faf310018jM9tBPKPMsezK',
        answers: [[QUESTION_STEERING_TEXT], [QUESTION_STEERING_TEXT]],
      },
    ]);
  });

  it('answers with a single steering-text entry when the question count is unknown', async () => {
    const { client, replyCalls } = createFakeQuestionClient();

    await autoAnswerQuestion(client, { id: 'que_no_questions_array' });

    expect(replyCalls).toEqual([{ requestID: 'que_no_questions_array', answers: [[QUESTION_STEERING_TEXT]] }]);
  });

  it('steers the model toward autonomy or the real ask_user_question MCP tool', async () => {
    const { client, replyCalls } = createFakeQuestionClient();
    await autoAnswerQuestion(client, { id: 'que_1', questions: [{}] });
    const [{ answers }] = replyCalls;
    expect(answers[0][0]).toContain('ask_user_question');
    expect(answers[0][0].toLowerCase()).toContain('not available in this environment');
  });

  it('never throws — a failed reply must not take the session down with it', async () => {
    const { client } = createFakeQuestionClient({ replyError: { message: 'boom' } });
    await expect(autoAnswerQuestion(client, { id: 'que_err', questions: [{}] })).resolves.toBeUndefined();
  });

  it('is a no-op without a request id', async () => {
    const { client, replyCalls } = createFakeQuestionClient();
    await autoAnswerQuestion(client, {});
    expect(replyCalls).toEqual([]);
  });
});

describe('handleQuestionAsked', () => {
  it('answers a question.asked event whose sessionID differs from the active session', async () => {
    // This is the wedge fix: previously the `question.asked` case in
    // OpenCodeProvider's event loop skipped events where `req.sessionID` was
    // set and did not match the turn's own session. The server is shared, so
    // a skipped foreign-session question stayed wedged until the next
    // runtime creation ran drainPendingQuestions. handleQuestionAsked is what
    // that switch case now delegates to unconditionally — assert it answers
    // regardless of sessionID, simulating a question raised by some other,
    // unrelated session on the shared server.
    const { client, replyCalls } = createFakeQuestionClient();

    await handleQuestionAsked(client, {
      id: 'que_foreign_session',
      sessionID: 'ses_some_other_session',
      questions: [{}],
    });

    expect(replyCalls).toEqual([{ requestID: 'que_foreign_session', answers: [[QUESTION_STEERING_TEXT]] }]);
  });

  it('answers regardless of whether sessionID is present at all', async () => {
    const { client, replyCalls } = createFakeQuestionClient();
    await handleQuestionAsked(client, { id: 'que_no_session', questions: [{}] });
    expect(replyCalls.map((c) => c.requestID)).toEqual(['que_no_session']);
  });

  it('gives up after its timeout and logs, so a never-resolving reply cannot stall the turn', async () => {
    // Mirrors drainPendingQuestions' own timeout test: `.reply()` here never
    // resolves, simulating a hung round-trip on the per-turn event path.
    // handleQuestionAsked is awaited inline from the `question.asked` case in
    // the provider's event loop, so it must return on its own timeout budget
    // rather than stall the turn forever. A short budget keeps this
    // deterministic instead of waiting out the real 10s production default.
    const client: QuestionClient = {
      question: {
        reply: () => new Promise(() => {}),
        list: async () => ({ data: [] }),
      },
    };

    const original = console.error;
    const messages: string[] = [];
    console.error = ((...args: unknown[]) => {
      messages.push(String(args[0]));
    }) as typeof console.error;

    try {
      await expect(handleQuestionAsked(client, { id: 'que_hung', questions: [{}] }, 20)).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }

    expect(messages.some((m) => m.includes('Timed out') && m.includes('que_hung'))).toBe(true);
  });
});

describe('drainPendingQuestions', () => {
  it('answers every question already pending when the runtime starts', async () => {
    const { client, replyCalls } = createFakeQuestionClient({
      pending: [
        { id: 'que_a', sessionID: 'ses_1', questions: [{}] },
        { id: 'que_b', sessionID: 'ses_2', questions: [{}, {}] },
      ],
    });

    await drainPendingQuestions(client);

    expect(replyCalls.map((c) => c.requestID)).toEqual(['que_a', 'que_b']);
    expect(replyCalls[1].answers).toHaveLength(2);
  });

  it('does nothing when there are no pending questions', async () => {
    const { client, replyCalls } = createFakeQuestionClient({ pending: [] });
    await drainPendingQuestions(client);
    expect(replyCalls).toEqual([]);
  });

  it('never throws when listing itself fails', async () => {
    const client: QuestionClient = {
      question: {
        reply: async () => ({ data: true }),
        list: async () => {
          throw new Error('connection reset');
        },
      },
    };
    await expect(drainPendingQuestions(client)).resolves.toBeUndefined();
  });

  it('gives up after its timeout and logs, so a hung round-trip cannot block runtime startup', async () => {
    // The `.list()` call here never resolves — simulating a hung round-trip
    // to the OpenCode server. drainPendingQuestions is awaited inline in the
    // runtime-startup path, so it must return on its own timeout budget
    // rather than hang the caller forever. A short budget (well under bun
    // test's default timeout) keeps this deterministic and fast instead of
    // actually waiting out the real 10s production default.
    const client: QuestionClient = {
      question: {
        reply: async () => ({ data: true }),
        list: () => new Promise(() => {}),
      },
    };

    const original = console.error;
    const messages: string[] = [];
    console.error = ((...args: unknown[]) => {
      messages.push(String(args[0]));
    }) as typeof console.error;

    try {
      await expect(drainPendingQuestions(client, 20)).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }

    expect(messages.some((m) => m.includes('Timed out') && m.includes('draining pending questions'))).toBe(true);
  });
});
