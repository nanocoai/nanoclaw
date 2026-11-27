/**
 * Claude SDK tool hooks for turn traces.
 *
 * `withTurnTraceHooks` appends trace matchers to the provider's own hook map
 * without replacing any existing matcher, so the provider's PreToolUse guard
 * still runs first and can still block a call.
 */
import type { HookCallback, HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';

import { recordToolEnd, recordToolStart } from './recorder.js';

type HookMap = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

interface ToolHookInput {
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
  duration_ms?: number;
}

const onToolStart: HookCallback = async (input, toolUseId) => {
  const i = input as ToolHookInput;
  recordToolStart(i.tool_use_id ?? toolUseId, i.tool_name ?? '', i.tool_input);
  return { continue: true };
};

const onToolEnd: HookCallback = async (input, toolUseId) => {
  const i = input as ToolHookInput;
  recordToolEnd(i.tool_use_id ?? toolUseId, i.tool_response, false, i.duration_ms);
  return { continue: true };
};

const onToolFailure: HookCallback = async (input, toolUseId) => {
  const i = input as ToolHookInput;
  recordToolEnd(i.tool_use_id ?? toolUseId, i.error ?? '', true, i.duration_ms);
  return { continue: true };
};

export function withTurnTraceHooks(hooks: HookMap): HookMap {
  return {
    ...hooks,
    PreToolUse: [...(hooks.PreToolUse ?? []), { hooks: [onToolStart] }],
    PostToolUse: [...(hooks.PostToolUse ?? []), { hooks: [onToolEnd] }],
    PostToolUseFailure: [...(hooks.PostToolUseFailure ?? []), { hooks: [onToolFailure] }],
  };
}
