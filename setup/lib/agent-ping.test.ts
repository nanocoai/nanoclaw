import { describe, expect, it } from 'vitest';

import { isValidGroupFolder } from '../../src/group-folder.js';
import { classifyPingResult, PING_AGENT_FOLDER } from './agent-ping.js';

it('uses a runtime-safe folder for the setup ping agent', () => {
  expect(isValidGroupFolder(PING_AGENT_FOLDER)).toBe(true);
});

describe('classifyPingResult', () => {
  it('treats a normal text reply as ok', () => {
    expect(classifyPingResult(0, 'pong\n')).toBe('ok');
  });

  it('detects Anthropic auth errors printed as a chat reply', () => {
    expect(
      classifyPingResult(
        0,
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
      ),
    ).toBe('auth_error');
  });

  it('detects auth errors on stderr too', () => {
    expect(classifyPingResult(1, '', 'Authentication error')).toBe('auth_error');
  });

  it('detects Claude Code login banners printed as a chat reply', () => {
    expect(classifyPingResult(0, 'Invalid API key · Please run /login')).toBe('auth_error');
    expect(classifyPingResult(0, 'Not logged in · Please run /login')).toBe('auth_error');
  });

  it('preserves socket errors', () => {
    expect(classifyPingResult(2, '')).toBe('socket_error');
  });

  it('treats empty output as no reply', () => {
    expect(classifyPingResult(0, '')).toBe('no_reply');
  });
});
