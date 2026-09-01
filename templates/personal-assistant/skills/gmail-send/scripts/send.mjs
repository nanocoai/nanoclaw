#!/usr/bin/env node

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GMAIL_SEND_URL =
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const EXPECTED_PROXY = 'http://sidecar:15001';
const EXPECTED_CA = '/run/nanoco/proxy-ca.pem';
const MAX_SPEC_BYTES = 128 * 1024;

function fail(message) {
  throw new Error(`gmail-send: ${message}`);
}

function headerValue(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${name} must be a non-empty string`);
  }
  if (/[\r\n]/u.test(value)) fail(`${name} contains a line break`);
  return value.trim();
}

function addresses(value, name, required = false) {
  const values =
    typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  if (required && values.length === 0) fail(`${name} needs at least one address`);
  return values.map((entry) => headerValue(entry, name));
}

function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

export function buildRawMessage(input, now = new Date()) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('spec must be a JSON object');
  }
  const allowed = new Set(['to', 'cc', 'bcc', 'subject', 'body']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(`unknown spec field: ${key}`);
  }

  const to = addresses(input.to, 'to', true);
  const cc = addresses(input.cc, 'cc');
  const bcc = addresses(input.bcc, 'bcc');
  const subject = headerValue(input.subject, 'subject');
  if (typeof input.body !== 'string' || input.body.length === 0) {
    fail('body must be a non-empty string');
  }
  if (Buffer.byteLength(input.body, 'utf8') > 100 * 1024) {
    fail('body exceeds 100 KiB');
  }

  const headers = [
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${now.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  const body = input.body.replace(/\r?\n/gu, '\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

export function requestBody(input, now) {
  return JSON.stringify({
    raw: Buffer.from(buildRawMessage(input, now), 'utf8').toString('base64url'),
  });
}

function readSpec(path) {
  const stat = fs.statSync(path);
  if (!stat.isFile()) fail('spec path is not a regular file');
  if ((stat.mode & 0o077) !== 0) fail('spec file must have mode 0600');
  if (stat.size > MAX_SPEC_BYTES) fail('spec exceeds 128 KiB');
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function main() {
  const specPath = process.argv[2];
  if (!specPath || process.argv.length !== 3) {
    fail('usage: send.mjs /path/to/mode-0600-spec.json');
  }
  if (process.env.HTTPS_PROXY !== EXPECTED_PROXY) {
    fail(`HTTPS_PROXY must be ${EXPECTED_PROXY}`);
  }
  if (process.env.CURL_CA_BUNDLE !== EXPECTED_CA || !fs.existsSync(EXPECTED_CA)) {
    fail(`CURL_CA_BUNDLE must name the mounted NanoCo CA at ${EXPECTED_CA}`);
  }

  const result = spawnSync(
    'curl',
    [
      '--silent',
      '--show-error',
      '--fail-with-body',
      '--max-time',
      '330',
      '--proxy',
      EXPECTED_PROXY,
      '--cacert',
      EXPECTED_CA,
      '--request',
      'POST',
      '--header',
      'content-type: application/json',
      '--data-binary',
      '@-',
      GMAIL_SEND_URL,
    ],
    {
      input: requestBody(readSpec(specPath)),
      encoding: 'utf8',
      timeout: 340_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    },
  );
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'request failed')
      .trim()
      .slice(0, 500);
    fail(detail);
  }

  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    fail('Gmail returned a non-JSON response');
  }
  if (
    typeof response !== 'object' ||
    response === null ||
    typeof response.id !== 'string' ||
    response.id === ''
  ) {
    fail('Gmail response did not contain a message id');
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, id: response.id, threadId: response.threadId ?? null })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
