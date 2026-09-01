import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRawMessage, requestBody } from './send.mjs';

const WHEN = new Date('2026-07-27T07:00:00.000Z');

test('builds a UTF-8 RFC 5322 message and Gmail base64url envelope', () => {
  const spec = {
    to: ['friend@example.com'],
    cc: ['copy@example.com'],
    subject: 'שלום friend',
    body: 'First line\nSecond line',
  };
  const raw = buildRawMessage(spec, WHEN);
  assert.match(raw, /^To: friend@example\.com\r\nCc: copy@example\.com\r\n/u);
  assert.match(raw, /Subject: =\?UTF-8\?B\?.+\?=\r\n/u);
  assert.match(raw, /\r\n\r\nFirst line\r\nSecond line$/u);

  const envelope = JSON.parse(requestBody(spec, WHEN));
  assert.equal(
    Buffer.from(envelope.raw, 'base64url').toString('utf8'),
    raw,
  );
  assert.doesNotMatch(envelope.raw, /[+/=]/u);
});

test('rejects header injection and unknown fields', () => {
  assert.throws(
    () =>
      buildRawMessage(
        { to: 'a@example.com\nBcc: attacker@example.com', subject: 'x', body: 'y' },
        WHEN,
      ),
    /line break/u,
  );
  assert.throws(
    () =>
      buildRawMessage(
        { to: 'a@example.com', subject: 'x', body: 'y', authorization: 'Bearer nope' },
        WHEN,
      ),
    /unknown spec field/u,
  );
});
