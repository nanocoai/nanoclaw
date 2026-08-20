import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createPendingApproval } from '../db/sessions.js';
import { log } from '../log.js';
import { registerQuestionRenderResolver, resolveQuestionRender } from './question-render-registry.js';

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
});

describe('question render resolver registry', () => {
  it('runs module resolvers in registration order and stops on the first result', async () => {
    const order: string[] = [];
    const later = vi.fn(() => undefined);
    const expected = {
      title: 'Module question',
      options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
    };

    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-order-question') return undefined;
      order.push('first');
      return undefined;
    });
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-order-question') return undefined;
      order.push('second');
      return expected;
    });
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-order-question') return undefined;
      later();
      return undefined;
    });

    expect(await resolveQuestionRender('module-order-question')).toBe(expected);
    expect(order).toEqual(['first', 'second']);
    expect(later).not.toHaveBeenCalled();
  });

  it('resolves over a snapshot when a resolver registers another resolver', async () => {
    const expected = {
      title: 'Registered during resolution',
      options: [{ label: 'Continue', selectedLabel: 'Continued', value: 'continue' }],
    };
    const registeredDuringResolution = vi.fn((questionId: string) =>
      questionId === 'snapshot-question' ? expected : undefined,
    );
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'snapshot-question') return undefined;
      registerQuestionRenderResolver(registeredDuringResolution);
      return undefined;
    });

    expect(await resolveQuestionRender('snapshot-question')).toBeUndefined();
    expect(registeredDuringResolution).not.toHaveBeenCalled();

    expect(await resolveQuestionRender('snapshot-question')).toBe(expected);
    expect(registeredDuringResolution).toHaveBeenCalledOnce();
  });

  it('logs an optional resolver failure and continues to the built-in fallback', async () => {
    const failure = new Error('resolver failure');
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    registerQuestionRenderResolver((questionId) => {
      if (questionId === 'resolver-failure-question') throw failure;
      return undefined;
    });
    await createPendingApproval({
      approval_id: 'resolver-failure-question',
      request_id: 'request-resolver-failure',
      action: 'test-action',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: 'Built-in fallback after failure',
      options_json: JSON.stringify([{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }]),
    });

    expect(await resolveQuestionRender('resolver-failure-question')).toEqual({
      title: 'Built-in fallback after failure',
      question: '',
      options: [{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }],
    });
    expect(errorSpy).toHaveBeenCalledWith('Question render resolver threw', { err: failure });
  });

  it('uses the existing database lookup as the final built-in fallback', async () => {
    await createPendingApproval({
      approval_id: 'built-in-render-question',
      request_id: 'request-1',
      action: 'test-action',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: 'Built-in approval',
      options_json: JSON.stringify([{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }]),
    });

    expect(await resolveQuestionRender('built-in-render-question')).toEqual({
      title: 'Built-in approval',
      question: '',
      options: [{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }],
    });
  });

  it('returns undefined when neither a module nor the built-in fallback owns the id', async () => {
    expect(await resolveQuestionRender('unowned-render-question')).toBeUndefined();
  });
});
