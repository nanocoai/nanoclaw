/**
 * Question-card render resolver registry.
 *
 * Optional modules register compact-card metadata lookups at import time.
 * The host's existing DB lookup remains the final fallback for core question
 * and approval rows.
 */
import { getAskQuestionRender } from '../db/sessions.js';
import { log } from '../log.js';
import type { NormalizedOption } from './ask-question.js';

export interface QuestionRender {
  title: string;
  question?: string;
  options: NormalizedOption[];
}

export type QuestionRenderResolver = (questionId: string) => QuestionRender | undefined;

const resolvers: QuestionRenderResolver[] = [];

export function registerQuestionRenderResolver(resolver: QuestionRenderResolver): void {
  resolvers.push(resolver);
}

export function resolveQuestionRender(questionId: string): QuestionRender | undefined {
  for (const resolver of [...resolvers]) {
    /* eslint-disable no-catch-all/no-catch-all -- one optional resolver must not block later resolvers or the built-in fallback */
    try {
      const render = resolver(questionId);
      if (render) return render;
    } catch (err) {
      log.error('Question render resolver threw', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  return getAskQuestionRender(questionId);
}
