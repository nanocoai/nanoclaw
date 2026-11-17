import { describe, expect, it } from 'bun:test';

import {
  STALE_CONVERSATION_RE,
  antigravityFailureNotice,
  classifyAntigravityError,
  parseAntigravityLine,
  parseAntigravityStderrLine,
  renderAntigravityFirstTurn,
  renderAntigravityUserLine,
  stepProgressMessage,
} from './antigravity-protocol.js';

describe('agy stream-json protocol', () => {
  it('renders one user line per turn', () => {
    expect(renderAntigravityUserLine('hi "there"\nsecond line')).toBe(
      '{"event":"user","message":{"content":"hi \\"there\\"\\nsecond line"}}\n',
    );
  });

  it('puts the session context ahead of the first prompt, or sends the bare prompt', () => {
    expect(renderAntigravityFirstTurn('CTX\n', 'hello')).toBe(
      '<nanoclaw_system_context>\nCTX\n</nanoclaw_system_context>\n\nhello',
    );
    expect(renderAntigravityFirstTurn(undefined, 'hello')).toBe('hello');
    expect(renderAntigravityFirstTurn('  ', 'hello')).toBe('hello');
  });

  it('parses the three consumed event kinds and ignores everything else', () => {
    expect(parseAntigravityLine('{"event":"init","conversation_id":"c1","init":{}}')).toEqual({
      event: 'init',
      conversation_id: 'c1',
      init: {},
    });
    expect(parseAntigravityLine('{"event":"result","result":{"status":"SUCCESS"}}')?.event).toBe('result');
    expect(parseAntigravityLine('{"event":"step_update","step_update":{}}')?.event).toBe('step_update');
    expect(parseAntigravityLine('{"event":"future"}')).toBeNull();
    expect(parseAntigravityLine('Fetching available models...')).toBeNull();
    expect(parseAntigravityLine('   ')).toBeNull();
  });

  it('parses the stderr lines agy writes', () => {
    expect(
      parseAntigravityStderrLine(
        'AGY_ERROR: {"short_error":"boom","status":"UNKNOWN","error_code":2,"code_kind":"grpc","retryable":false,"error_id":"e"}',
      ),
    ).toEqual({
      kind: 'agy-error',
      error: {
        short_error: 'boom',
        status: 'UNKNOWN',
        error_code: 2,
        code_kind: 'grpc',
        retryable: false,
        error_id: 'e',
      },
    } as never);
    expect(parseAntigravityStderrLine('warning: conversation "abc-123" not found')).toEqual({
      kind: 'conversation-not-found',
      conversationId: 'abc-123',
    });
    expect(parseAntigravityStderrLine('error: interrupted')).toEqual({ kind: 'error', message: 'interrupted' });
    expect(parseAntigravityStderrLine('AGY_ERROR: {broken')).toEqual({ kind: 'other' });
    expect(parseAntigravityStderrLine('something else')).toEqual({ kind: 'other' });
  });

  it('names tool steps, and MCP calls by server and tool', () => {
    expect(stepProgressMessage({ step_type: 'tool', state: 'ACTIVE', tool_name: 'write_file' })).toBe('write_file…');
    expect(stepProgressMessage({ step_type: 'tool', state: 'DONE', tool_name: 'write_file' })).toBeNull();
    expect(stepProgressMessage({ step_type: 'tool', state: 'ERROR', tool_info: { name: 'run_command' } })).toBe(
      'run_command failed',
    );
    expect(
      stepProgressMessage({
        step_type: 'tool',
        state: 'ACTIVE',
        tool_name: 'call_mcp_tool',
        tool_info: { parameters: { ServerName: 'nanoclaw', ToolName: 'send_message' } },
      }),
    ).toBe('nanoclaw/send_message…');
    expect(stepProgressMessage({ step_type: 'agent_response', state: 'DONE', text_delta: 'x' })).toBeNull();
  });
});

describe('agy failure classification', () => {
  it.each([
    ['API key not valid. Please pass a valid API key.', 'auth'],
    ['doRequest: error sending request: Post "https://generativelanguage.googleapis.com/…": Forbidden', 'auth'],
    ['RESOURCE_EXHAUSTED: Quota exceeded for metric', 'quota'],
    ['429 Too Many Requests', 'quota'],
    ['dial tcp 127.0.0.1:443: connect: connection refused', 'network'],
    ['interrupted', 'interrupted'],
    ['conversation "x" not found', 'stale-session'],
    ['something unexpected', undefined],
  ])('classifies %j as %j', (message, expected) => {
    expect(classifyAntigravityError(message)).toBe(expected as never);
  });

  it('matches only the missing-conversation wording, not other "not found" errors', () => {
    expect(STALE_CONVERSATION_RE.test('warning: conversation "00000000-0000" not found')).toBe(true);
    expect(STALE_CONVERSATION_RE.test('unknown conversation')).toBe(true);
    expect(STALE_CONVERSATION_RE.test('failed to load conversation state: model gemini-x not found')).toBe(false);
    expect(STALE_CONVERSATION_RE.test('conversation  not found')).toBe(false);
    expect(classifyAntigravityError('failed to load conversation state: model gemini-x not found')).toBeUndefined();
  });

  it('turns known classes into fixed notices and caps anything else', () => {
    // Setup's provider-auth step in a terminal, not the skill: an agent
    // running /add-antigravity has no TTY and keeps the stored key.
    expect(antigravityFailureNotice('API key not valid')).toContain(
      '`pnpm exec tsx setup/index.ts --step provider-auth antigravity`',
    );
    expect(antigravityFailureNotice('API key not valid')).toContain('Replace');
    expect(antigravityFailureNotice('API key not valid')).not.toContain('/add-antigravity');
    expect(antigravityFailureNotice('weird\nstack line')).toBe('Antigravity turn failed: weird');
    expect(antigravityFailureNotice('x'.repeat(400))).toHaveLength('Antigravity turn failed: '.length + 301);
    expect(antigravityFailureNotice('')).toBe('Antigravity turn failed.');
  });
});
