import { describe, expect, it } from 'vitest';

import { extractClaudeOAuthToken } from './captured-token.js';

// A syntactically valid token: sk-ant-oat + 93 token chars + AA.
const TOKEN = `sk-ant-oat01-${'a'.repeat(90)}AA`;

describe('extractClaudeOAuthToken', () => {
  it('extracts the token from clean single-line output (normal terminal)', () => {
    const raw = `Login successful.\nYour token:\n${TOKEN}\n`;
    expect(extractClaudeOAuthToken(raw)).toBe(TOKEN);
  });

  // The actual sbx failure shape: the real token wrapped across two lines AND
  // the `export CLAUDE_CODE_OAUTH_TOKEN=<token>` placeholder in the same
  // capture. The old parser returned null (matched only the first fragment);
  // the normalizer must un-wrap the real token and never mistake the
  // placeholder for it.
  it('extracts the real wrapped token from sbx capture and ignores the placeholder export', () => {
    const head = TOKEN.slice(0, 72);
    const tail = TOKEN.slice(72);
    const raw = `
\x1b[?2026h✓ Long-lived authentication token created successfully!

  Your OAuth token (valid for 1 year):

  ${head}
  ${tail}

Store this token securely. You won't be able to see it again.

Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>
`;
    expect(extractClaudeOAuthToken(raw)).toBe(TOKEN);
  });

  it('returns null for the placeholder env-var line, not a real token', () => {
    expect(extractClaudeOAuthToken('export CLAUDE_CODE_OAUTH_TOKEN=<token>\n')).toBeNull();
  });

  it('returns null when no token is present', () => {
    expect(extractClaudeOAuthToken('claude: authentication cancelled\n')).toBeNull();
  });
});
