// Generic poll-loop extension seam (Route-C hook). INERT on pristine core: with
// no registrant, every apply* returns its input unchanged, so the poll loop
// behaves byte-identically to upstream. An overlay may register hooks that
// transform the pending-message batch or the turn lifecycle. This module holds
// the poll-loop registries (one per extraction); each is independently inert.
//
// First registry (cluster 5, #387 runner-gating): a message filter applied to
// the pending batch right after it is read from getPendingMessages — e.g. a
// state-gated suppression of scheduled-runner (standup/digest/review) messages
// when the board is idle/stale. Composed left-to-right in registration order.
import type { MessageInRow } from './db/messages-in.js';

export type MessageFilter = (messages: MessageInRow[]) => MessageInRow[];

const messageFilters: MessageFilter[] = [];

export function registerMessageFilter(fn: MessageFilter): void {
  messageFilters.push(fn);
}

/** Left-fold over registrants. No registrant ⇒ returns `messages` unchanged. */
export function applyMessageFilter(messages: MessageInRow[]): MessageInRow[] {
  return messageFilters.reduce((acc, fn) => fn(acc), messages);
}

export function __resetMessageFilterForTest(): void {
  messageFilters.length = 0;
}

// Second registry (cluster 4): a prompt transform applied to the formatted turn
// prompt right before provider.query — e.g. prepend an embedding-ranked board
// context preamble. Async + composed left-to-right; no registrant ⇒ the prompt
// is returned unchanged.
export type PromptTransform = (prompt: string, messages: MessageInRow[]) => Promise<string> | string;

const promptTransforms: PromptTransform[] = [];

export function registerPromptTransform(fn: PromptTransform): void {
  promptTransforms.push(fn);
}

/** Left-fold over registrants. No registrant ⇒ resolves to `prompt` unchanged. */
export async function applyPromptTransform(prompt: string, messages: MessageInRow[]): Promise<string> {
  let current = prompt;
  for (const fn of promptTransforms) current = await fn(current, messages);
  return current;
}

export function __resetPromptTransformForTest(): void {
  promptTransforms.length = 0;
}

// Third registry (cluster 7, #407): a prefilter side-effect run over the freshly
// read pending batch BEFORE the kind!=='system' filter — e.g. replay approved
// actions. Hooks run in order; no registrant ⇒ no-op. Side-effect only (void).
export type PrefilterStep = (messages: MessageInRow[]) => Promise<void> | void;

const prefilterSteps: PrefilterStep[] = [];

export function registerPrefilterStep(fn: PrefilterStep): void {
  prefilterSteps.push(fn);
}

/** Run each registrant over the batch in order. No registrant ⇒ no-op. */
export async function applyPrefilterSteps(messages: MessageInRow[]): Promise<void> {
  for (const fn of prefilterSteps) await fn(messages);
}

export function __resetPrefilterStepsForTest(): void {
  prefilterSteps.length = 0;
}
