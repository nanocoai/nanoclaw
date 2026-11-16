import { describe, expect, it } from 'vitest';

import { createLineRedactor, isSecretName, maskSecretValue, redactSecrets } from './secret-redaction.js';

// Fakes are assembled at runtime so no key-shaped literal sits in the source.
const fake = (prefix: string, body: string): string => prefix + body;
const A = (n: number): string => 'A'.repeat(n);
// Random-looking payloads, the same every run: gitleaks rules skip low-entropy fakes.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let seed = 7;
const rand = (n: number, chars = ALNUM): string =>
  Array.from({ length: n }, () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return chars[Math.floor((seed / 2 ** 31) * chars.length)];
  }).join('');
const digits = (n: number): string => rand(n, '0123456789');

const FAKES = {
  anthropic: fake('sk-ant-api03-', `TESTKEY${A(40)}`),
  openai: fake('sk-proj-', `TESTKEY${A(40)}`),
  githubClassic: fake('ghp_', rand(36)),
  githubOauth: fake('gho_', rand(36)),
  githubFine: fake('github_pat_', rand(82, `${ALNUM}_`)),
  slackBot: fake('xoxb-', `${digits(10)}-${digits(13)}-${rand(24)}`),
  slackUser: fake('xoxp-', `${digits(10)}-${digits(12)}-${digits(13)}-${rand(32)}`),
  slackApp: fake('xapp-', `1-A0000000000-0000000000000-TESTTOKEN${A(40)}`),
  aws: fake('AKIA', rand(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
  telegram: fake('123456789:', `TESTTOKEN${A(26)}`),
  discord: fake('MTE', `${A(23)}.TESTAA.TESTTOKEN${A(29)}`),
  google: fake('AIza', rand(35, `${ALNUM}_-`)),
  jwt: fake('eyJ', `hbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.TESTSIGNATURE${A(20)}`),
};

describe('redactSecrets: key-shaped values', () => {
  for (const [name, value] of Object.entries(FAKES)) {
    it(`removes a ${name} value from prose, JSON and URLs`, () => {
      for (const text of [
        `request failed with ${value} attached`,
        JSON.stringify({ nested: { value } }),
        `https://example.test/path/${value}/getMe?x=1`,
      ]) {
        const out = redactSecrets(text);
        expect(out).not.toContain(value);
        expect(out).toContain('[REDACTED]');
      }
    });
  }

  it('removes a whole PEM private key block', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\nTESTKEY${A(40)}\n${A(40)}\n-----END PRIVATE KEY-----`;
    const out = redactSecrets(`loaded ${pem} ok`);
    expect(out).not.toContain('TESTKEY');
    expect(out).toBe('loaded [REDACTED] ok');
  });

  it('removes a PEM body that is JSON-escaped or cut off before its END line', () => {
    const escaped = JSON.stringify({
      key: `-----BEGIN RSA PRIVATE KEY-----\nTESTKEY${A(40)}\n-----END RSA PRIVATE KEY-----`,
    });
    expect(redactSecrets(escaped)).not.toContain('TESTKEY');
    const cut = `-----BEGIN OPENSSH PRIVATE KEY-----\nTESTKEY${A(40)}`.slice(0, 60);
    expect(redactSecrets(`stderr: ${cut}`)).not.toContain('TESTKEY');
  });

  it('removes values from JSON-escaped text', () => {
    const nested = JSON.stringify({ body: JSON.stringify({ apiKey: 'opaqueTESTVALUE' }) });
    expect(redactSecrets(nested)).toBe('{"body":"{\\"apiKey\\":\\"[REDACTED]\\"}"}');
    const multiline = JSON.stringify({ text: `line one\n${FAKES.githubClassic}\tTOKEN=opaqueTESTVALUE` });
    const out = redactSecrets(multiline);
    expect(out).not.toContain(FAKES.githubClassic);
    expect(out).not.toContain('opaqueTESTVALUE');
  });

  it('removes a Telegram token from a bot API URL', () => {
    const out = redactSecrets(`GET https://api.telegram.test/bot${FAKES.telegram}/getMe failed`);
    expect(out).not.toContain(FAKES.telegram.split(':')[1]);
  });

  it('removes the token segment of webhook URLs and keeps the rest of the path', () => {
    const interaction = `TESTTOKEN${A(60)}`;
    expect(redactSecrets(`path="/webhooks/123456789012345678/${interaction}/messages/@original"`)).toBe(
      'path="/webhooks/123456789012345678/[REDACTED]/messages/@original"',
    );
    const hook = `https://hooks.slack.test/services/T00000000/B00000000/TESTTOKEN${A(15)}`.replace('.test', '.com');
    expect(redactSecrets(`posting to ${hook}`)).toBe('posting to https://hooks.slack.com/services/[REDACTED]');
  });

  it('stays linear on long token-like runs', () => {
    const runs = [
      'eyJ-'.repeat(50_000),
      'a-'.repeat(100_000),
      'x'.repeat(200_000),
      'sk-'.repeat(60_000),
      '\x1b[1;2m'.repeat(40_000),
      'token="'.repeat(40_000),
      '\\"password\\":\\"'.repeat(20_000),
    ];
    const start = Date.now();
    for (const run of runs) redactSecrets(`${run} password`);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('redactSecrets: auth headers, URLs and secret names', () => {
  it('keeps the scheme of an Authorization header and drops the credential', () => {
    expect(redactSecrets('Authorization: Bearer opaque-TESTTOKEN-123')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactSecrets('{"authorization":"Basic dXNlcjpwYXNz"}')).toBe('{"authorization":"Basic [REDACTED]"}');
    expect(redactSecrets("curl -H 'Proxy-Authorization: Bearer opaqueTESTTOKEN'")).toBe(
      "curl -H 'Proxy-Authorization: Bearer [REDACTED]'",
    );
  });

  it('drops a bare bearer token outside a header', () => {
    expect(redactSecrets('sent bearer opaqueTESTTOKEN0123456789 upstream')).toBe('sent bearer [REDACTED] upstream');
  });

  it('drops api-key and cookie header values', () => {
    expect(redactSecrets('x-api-key: opaqueTESTKEY')).toBe('x-api-key: [REDACTED]');
    expect(redactSecrets('{"X-Api-Key":"opaqueTESTKEY","Content-Type":"json"}')).toBe(
      '{"X-Api-Key":"[REDACTED]","Content-Type":"json"}',
    );
    expect(redactSecrets('Cookie: session=opaqueTESTVALUE')).toBe('Cookie: [REDACTED]');
  });

  it('drops the password of a URL userinfo and keeps the host', () => {
    expect(redactSecrets('HTTPS_PROXY=http://user:opaqueTESTPASS@proxy.test:8080')).toBe(
      'HTTPS_PROXY=http://user:[REDACTED]@proxy.test:8080',
    );
  });

  it('drops values assigned to secret-named variables, flags and fields', () => {
    expect(redactSecrets('SLACK_BOT_TOKEN=opaqueTESTVALUE')).toBe('SLACK_BOT_TOKEN=[REDACTED]');
    expect(redactSecrets('export DISCORD_BOT_TOKEN="opaqueTESTVALUE"')).toBe('export DISCORD_BOT_TOKEN="[REDACTED]"');
    expect(redactSecrets('{"apiKey":"opaqueTESTVALUE","botToken":"opaqueTESTVALUE"}')).toBe(
      '{"apiKey":"[REDACTED]","botToken":"[REDACTED]"}',
    );
    expect(redactSecrets('cli --api-key opaqueTESTVALUE --name bot')).toBe('cli --api-key [REDACTED] --name bot');
    expect(redactSecrets('cli --token=opaqueTESTVALUE')).toBe('cli --token=[REDACTED]');
    expect(redactSecrets('client_secret: opaqueTESTVALUE')).toBe('client_secret: [REDACTED]');
  });
});

describe('redactSecrets: review cases', () => {
  it('masks a whole quoted value, for flags and assignments', () => {
    expect(redactSecrets('cli --token "opaqueTESTVALUE" --name bot')).toBe('cli --token "[REDACTED]" --name bot');
    expect(redactSecrets('PASSWORD="alpha beta" next')).toBe('PASSWORD="[REDACTED]" next');
  });

  it('masks every cookie in a Cookie header', () => {
    expect(redactSecrets('Cookie: theme=dark; session=opaqueSESSION')).toBe('Cookie: [REDACTED]');
  });

  it('finds a token wrapped in ANSI colour codes', () => {
    const out = redactSecrets(`\x1b[32m${FAKES.githubClassic}\x1b[0m`);
    expect(out).toBe(`\x1b[32mghp_[REDACTED]…${FAKES.githubClassic.slice(-4)}\x1b[0m`);
  });

  it('does not let a prose word hide the assignment after it', () => {
    expect(redactSecrets('token password=opaqueTESTVALUE')).toBe('token password=[REDACTED]');
  });

  it('never reaches across a line end for a value', () => {
    expect(redactSecrets('TOKEN=\nECONNREFUSED')).toBe('TOKEN=\nECONNREFUSED');
  });
});

describe('redactSecrets: review round 2', () => {
  it('masks quoted values that contain backslashes, raw or JSON-escaped', () => {
    expect(redactSecrets('PASSWORD="\\secret" next')).toBe('PASSWORD="[REDACTED]" next');
    expect(redactSecrets('PASSWORD="ab\\cd"')).toBe('PASSWORD="[REDACTED]"');
    const nested = JSON.stringify({ body: JSON.stringify({ password: 'a\\b c', user: 'sam' }) });
    expect(redactSecrets(nested)).toBe(
      JSON.stringify({ body: JSON.stringify({ password: '[REDACTED]', user: 'sam' }) }),
    );
  });

  it('finds a token after a JSON-escaped ANSI colour code', () => {
    const out = redactSecrets(JSON.stringify({ stderr: `\x1b[32m${FAKES.githubClassic}\x1b[0m` }));
    expect(out).not.toContain(FAKES.githubClassic);
  });

  it('masks a Cookie header whose values are quoted', () => {
    expect(redactSecrets('Cookie: theme="dark"; session=opaqueSESSION')).toBe('Cookie: [REDACTED]');
  });

  it('masks a traditional encrypted PEM key with Proc-Type and DEK-Info headers', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0123456789ABCDEF',
      '',
      `TESTKEYBODY${A(40)}`,
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`key ${pem} ok`);
    expect(out).toBe('key [REDACTED] ok');
  });
});

describe('redactSecrets: review round 3', () => {
  it('masks every cookie when the header line is JSON-escaped', () => {
    const out = redactSecrets(JSON.stringify({ stderr: 'Cookie: theme="dark"; session=opaqueSESSION' }));
    expect(out).toBe(JSON.stringify({ stderr: 'Cookie: [REDACTED]' }));
  });

  it('masks a JSON-escaped password that contains a quote', () => {
    const out = redactSecrets(JSON.stringify({ body: JSON.stringify({ password: 'prefix"opaqueSECRET' }) }));
    expect(out).toBe(JSON.stringify({ body: JSON.stringify({ password: '[REDACTED]' }) }));
  });
});

describe('redactSecrets: hints, AWS names, plain values', () => {
  const key = `sk-ant-api03-${'x'.repeat(40)}WXYZ`;

  it('keeps the issuer prefix and last 4 of a prefixed key, nothing else', () => {
    expect(redactSecrets(`auth failed for ${key}`)).toBe('auth failed for sk-ant-api03-[REDACTED]…WXYZ');
    expect(redactSecrets(`ANTHROPIC_API_KEY=${key}`)).toBe('ANTHROPIC_API_KEY=sk-ant-api03-[REDACTED]…WXYZ');
    expect(redactSecrets(`token ${fake('ghp_', `${rand(32)}Q1w2`)}`)).toBe('token ghp_[REDACTED]…Q1w2');
  });

  it('masks a prefixed key whole when fewer than 16 characters would stay hidden', () => {
    expect(redactSecrets(`aws ${FAKES.aws}`)).toBe('aws [REDACTED]');
  });

  it('shows no characters of a value found only by its name or shape', () => {
    expect(redactSecrets('PASSWORD=hunter2hunter2')).toBe('PASSWORD=[REDACTED]');
    expect(redactSecrets(`bot ${FAKES.telegram}`)).toBe('bot [REDACTED]');
  });

  it.each([
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY',
    'STRIPE_SECRET_KEY',
    'secretAccessKey',
    'accessKey',
    'secret_key',
  ])('masks %s by name, as a field and as NAME=value', (name) => {
    expect(isSecretName(name)).toBe(true);
    expect(redactSecrets(`${name}=opaqueTESTVALUE`)).toBe(`${name}=[REDACTED]`);
  });

  it('keeps AWS_ACCESS_KEY_ID readable by name (the AKIA shape masks its value)', () => {
    expect(isSecretName('AWS_ACCESS_KEY_ID')).toBe(false);
  });

  it('masks a Google API key', () => {
    expect(redactSecrets(`GOOGLE ${FAKES.google} end`)).toBe(`GOOGLE AIza[REDACTED]…${FAKES.google.slice(-4)} end`);
  });

  it.each(['token: not configured', 'ANTHROPIC_API_KEY=undefined', 'password: missing', 'apiKey: null'])(
    'leaves a placeholder word readable: %s',
    (text) => expect(redactSecrets(text)).toBe(text),
  );

  it('still masks a short real value', () => {
    expect(redactSecrets('password: hunter2')).toBe('password: [REDACTED]');
  });
});

describe('redactSecrets: hint review', () => {
  it('does not trust a mask marker inside a value', () => {
    expect(redactSecrets('PASSWORD="hunter2[redacted]"')).toBe('PASSWORD="[REDACTED]"');
    expect(redactSecrets('Cookie: theme=dark; session=opaqueSECRET; other=[redacted]')).toBe('Cookie: [REDACTED]');
  });

  it('shows only a known issuer prefix, never payload characters', () => {
    const out = redactSecrets(`k ${fake('sk-proj-', `a1b2c3d4-${A(16)}WXYZ`)}`);
    expect(out).toBe('k sk-proj-[REDACTED]…WXYZ');
  });

  it('does not count the public prefix toward the 16 hidden characters', () => {
    expect(redactSecrets(`k ${fake('sk-ant-api03-', `${A(10)}WXYZ`)}`)).toBe('k [REDACTED]');
  });

  it('masks a placeholder word when it is quoted', () => {
    expect(redactSecrets('curl --password "missing"')).toBe('curl --password "[REDACTED]"');
    expect(redactSecrets('{"password":"false"}')).toBe('{"password":"[REDACTED]"}');
  });
});

describe('redactSecrets: hint review 2', () => {
  it('masks a PEM key whole even when its body holds a prefixed-key shape', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\nMEcCAQAwBQYDK2VxBDsEOQ/AIza${A(35)}//\n${'B'.repeat(33)}Q==\n-----END PRIVATE KEY-----`;
    expect(redactSecrets(`key ${pem} ok`)).toBe('key [REDACTED] ok');
  });

  it('does not accept a hint-shaped value without a known issuer prefix', () => {
    expect(redactSecrets('password: "hunter2hunter2[REDACTED]…WXYZ"')).toBe('password: "[REDACTED]"');
  });

  it('keeps only a known Anthropic prefix', () => {
    expect(redactSecrets(`k ${fake('sk-ant-secret12-', `${'x'.repeat(24)}WXYZ`)}`)).toBe('k sk-[REDACTED]…WXYZ');
  });
});

describe('createLineRedactor', () => {
  it('masks a PEM body that arrives one line per call', () => {
    const redact = createLineRedactor();
    const out = [
      'loading key\n',
      '-----BEGIN PRIVATE KEY-----\n',
      `TESTKEY${A(40)}\n`,
      `${A(40)}\n`,
      '-----END PRIVATE KEY-----\n',
      'done\n',
    ].map(redact);
    expect(out.join('')).not.toContain('TESTKEY');
    expect(out.join('')).not.toContain(A(40));
    expect(out[0]).toBe('loading key\n');
    expect(out[5]).toBe('done\n');
  });
});

describe('redactSecrets: leaves ordinary text alone', () => {
  it.each([
    'max_tokens=4096 tokenCount=3',
    'key="TELEGRAM_BOT_TOKEN" existed=true',
    'the token expired; ask the owner for a new one',
    'Basic setup complete',
    'image sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'session 4f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f started',
    'https://example.test:8443/path?page=2',
    'sk-1 is not a key',
  ])('%s', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactSecrets(`TOKEN=${FAKES.githubClassic} Authorization: Bearer ${FAKES.jwt}`);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('isSecretName', () => {
  it.each([
    'botToken',
    'SLACK_BOT_TOKEN',
    'apiKey',
    'x-api-key',
    'authorization',
    'cookie',
    'clientSecret',
    'password',
  ])('flags %s', (name) => expect(isSecretName(name)).toBe(true));
  it.each(['key', 'maxTokens', 'tokenCount', 'keyId', 'secretName', 'authMode'])('passes %s', (name) =>
    expect(isSecretName(name)).toBe(false),
  );
});

describe('redactSecrets: keys only the gitleaks list knows', () => {
  const lower = 'abcdefghijklmnopqrstuvwxyz0123456789';
  it.each([
    ['Stripe', fake('sk_live_', rand(24)), 'sk_live'],
    ['GitLab', fake('glpat-', rand(20)), 'glpat-'],
    ['npm', fake('npm_', rand(36, lower)), 'npm_'],
    ['Hugging Face', fake('hf_', rand(34, ALNUM.slice(0, 52))), 'hf_'],
  ])('masks a %s key and keeps its issuer prefix', (_issuer, key, prefix) => {
    expect(redactSecrets(`push failed: ${key} was rejected`)).toBe(
      `push failed: ${prefix}[REDACTED]…${key.slice(-4)} was rejected`,
    );
  });

  it('finds a key that ends at URL punctuation, not only at a space or quote', () => {
    const url = `https://generativelanguage.googleapis.test/v1/models/m:generate?key=${FAKES.google}&alt=sse`;
    expect(redactSecrets(url)).not.toContain(FAKES.google);
    expect(redactSecrets(`(${FAKES.githubFine})`)).not.toContain(FAKES.githubFine);
  });
});

/** ~10k ordinary log lines (host log, setup and step output), the same every run. */
function normalLogLines(count = 10_000): string[] {
  let s = 11;
  const next = (): number => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const n = (max: number): number => Math.floor(next() * max);
  const pick = <T>(xs: readonly T[]): T => xs[n(xs.length)];
  const hex = (len: number): string => Array.from({ length: len }, () => '0123456789abcdef'[n(16)]).join('');
  const uuid = (): string => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
  const time = (): string =>
    `[${[n(24), n(60), n(60)].map((v) => String(v).padStart(2, '0')).join(':')}.${String(n(1000)).padStart(3, '0')}]`;
  const lines: Array<() => string> = [
    () =>
      `${time()} INFO Message received channel=${pick(['telegram', 'discord', 'slack'])} chatId=-100${n(1e9)} length=${n(400)}`,
    () =>
      `${time()} INFO Container started name=nanoclaw-${pick(['main', 'ops'])}-${hex(8)} image=nanoclaw-agent:latest durationMs=${n(9000)}`,
    () =>
      `${time()} DEBUG Routing {"messageId":"${uuid()}","agentGroupId":"${uuid()}","platform":"${pick(['discord', 'slack'])}","threadId":"${n(1e9)}${n(1e9)}"}`,
    () => `${time()} WARN Delivery retry attempt=${n(5)} sessionId=${uuid()} error="ECONNRESET" nextInMs=${n(30000)}`,
    () =>
      `${time()} ERROR Send failed err={ type: "Error", message: "Request failed with status code ${pick([429, 500])}", stack: Error: Request failed\\n    at dispatch (/app/node_modules/chat/dist/index.js:${n(4000)}:${n(80)}) }`,
    () => `GET https://api.github.com/repos/nanocoai/nanoclaw/pulls/${n(5000)}?per_page=100 200 ${n(900)}ms`,
    () => `Progress: resolved ${n(900)}, reused ${n(900)}, downloaded 0, added ${n(900)}, done`,
    () => `+ @anthropic-ai/claude-agent-sdk 0.2.${n(90)}`,
    () =>
      `#${n(30)} [stage-1 ${n(9)}/9] RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git`,
    () => `#${n(30)} writing image sha256:${hex(64)} done`,
    () => `HEAD is now at ${hex(9)} fix(setup): restart the service after a re-auth`,
    () => `${time()} INFO Updated .env key=TELEGRAM_BOT_TOKEN existed=${pick(['true', 'false'])}`,
    () => `${time()} DEBUG Session ${uuid()} wrote ${n(5)} messages to outbound.db (${n(90000)} bytes)`,
    () => `${time()} INFO Scheduled task fired taskId=${uuid()} cron="0 9 * * 1-5" nextRun=2026-10-24T09:00:00.000Z`,
    () =>
      `${time()} INFO Turn done input_tokens=${n(90000)} output_tokens=${n(4000)} cache_read_input_tokens=${n(90000)} max_tokens=8192`,
    () => `npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported`,
    () => `${time()} INFO OneCLI gateway healthy url=http://127.0.0.1:${n(60000)} latencyMs=${n(40)}`,
    () => `✓ src/${pick(['router', 'delivery', 'host-sweep'])}.test.ts (${n(60)} tests) ${n(900)}ms`,
    () => `${time()} WARN token expired for agent group ${uuid()}; ask the owner for a new one`,
    () =>
      `  at Object.<anonymous> (/Users/sam/nanoclaw/src/${pick(['index', 'container-runner'])}.ts:${n(900)}:${n(60)})`,
  ];
  return Array.from({ length: count }, () => pick(lines)());
}

describe('redactSecrets: ordinary log volume', () => {
  const corpus = normalLogLines();

  it('leaves 10k ordinary log lines unchanged', () => {
    expect(corpus.filter((line) => redactSecrets(line) !== line)).toEqual([]);
  });

  it('costs well under 50 µs a line', () => {
    for (const line of corpus.slice(0, 1000)) redactSecrets(line);
    const start = performance.now();
    for (const line of corpus) redactSecrets(line);
    expect(((performance.now() - start) * 1000) / corpus.length).toBeLessThan(50);
  });
});

describe('redactSecrets: gitleaks rules in escaped text', () => {
  const stripe = fake('sk_live_', rand(24));
  it.each([
    ['after a JSON-escaped line end', () => JSON.stringify({ stderr: `line\n${FAKES.aws}` }), FAKES.aws],
    ['after a JSON-escaped tab', () => JSON.stringify({ x: `a\t${FAKES.google}` }), FAKES.google],
    ['after an ANSI colour code', () => `\x1b[32m${FAKES.aws}\x1b[0m`, FAKES.aws],
    ['after a JSON-escaped ANSI colour code', () => JSON.stringify({ s: `\x1b[31m${stripe}` }), stripe],
    ['inside JSON nested in JSON', () => JSON.stringify({ body: JSON.stringify({ k: FAKES.google }) }), FAKES.google],
    ['inside JSON nested in JSON, Stripe', () => JSON.stringify({ body: JSON.stringify({ k: stripe }) }), stripe],
  ])('finds a key %s', (_where, text, key) => {
    expect(redactSecrets(text())).not.toContain(key);
  });

  it('never shows a word that named the key as its prefix', () => {
    const key = `datadog${rand(33, 'abcdefghijklmnopqrstuvwxyz0123456789')}`;
    expect(redactSecrets(`datadog_api_token = "${key}"`)).toBe('datadog_api_token = "[REDACTED]"');
    expect(redactSecrets(`DD ${key}`)).toBe(`DD ${key}`);
  });
});

describe('redactSecrets: gitleaks review', () => {
  it('masks the whole key where a rule captures only part of it', () => {
    const encoded = fake('ZXlK', `aGJHY2lPaU${'Ab9Xq1'.repeat(20)}`);
    expect(redactSecrets(`jwt ${encoded}`)).not.toContain('Ab9Xq1Ab9Xq1');
    const id = (): string =>
      `${rand(8, 'abcdef0123456789')}-${rand(4)}-${rand(4)}-${rand(4)}-${rand(12)}`.toLowerCase();
    const secret = rand(32, 'abcdef0123456789');
    const teams = `https://acme.webhook.office.com/webhookb2/${id()}@${id()}/IncomingWebhook/${secret}/${id()}`;
    expect(redactSecrets(`posting to ${teams}`)).not.toContain(secret);
  });

  it('masks a longer key whole when a shorter rule matches its start', () => {
    const routable = fake('glpat-', 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4.a12345678');
    expect(redactSecrets(`token ${routable} ok`)).toBe('token glpat-[REDACTED]…5678 ok');
    const longer = fake('ghp_', rand(44));
    expect(redactSecrets(longer)).toBe(`ghp_[REDACTED]…${longer.slice(-4)}`);
  });

  it('masks a Slack token of any layout whole', () => {
    const legacy = fake('xoxa-', '2-511111111-31111111111-31111111111111-e039d02840a0b9379c');
    expect(redactSecrets(legacy)).toBe('xoxa-[REDACTED]…379c');
  });

  it('masks a JWT with short segments', () => {
    const jwt = fake('eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmno');
    expect(redactSecrets(`token ${jwt}`)).toBe('token [REDACTED]');
  });

  it('keeps the prefix hint for a secret-named field holding a key from the gitleaks list', () => {
    const key = fake('glpat-', rand(20));
    expect(maskSecretValue(key)).toBe(`glpat-[REDACTED]…${key.slice(-4)}`);
    expect(maskSecretValue(`${key} and more`)).toBe('[REDACTED]');
  });

  it('shows only fixed issuer text as a prefix, never payload that looks like a keyword', () => {
    const payload = `jira${rand(16)}${rand(4, 'abcdef0123456789')}`;
    expect(redactSecrets(`atlassian = ${payload}`)).toBe('atlassian = [REDACTED]');
    const infix = `atlasv1${rand(7)}.atlasv1.${rand(70)}`;
    expect(redactSecrets(infix)).toBe('[REDACTED]');
  });

  it.each(['|next', '\\/next', '<next', '@host'])('finds a key followed by %s', (after) => {
    expect(redactSecrets(`${FAKES.google}${after}`)).toBe(`AIza[REDACTED]…${FAKES.google.slice(-4)}${after}`);
  });

  it('masks a GitHub token of any length and the rest of a longer key', () => {
    const short = fake('ghp_', rand(20));
    expect(redactSecrets(`t ${short}`)).toBe(`t ghp_[REDACTED]…${short.slice(-4)}`);
    const fine = fake('github_pat_', rand(20));
    expect(redactSecrets(`t ${fine}`)).toBe(`t github_pat_[REDACTED]…${fine.slice(-4)}`);
    const gitlab = fake('glpat-', `${rand(20)}-SECRETTAIL`);
    expect(redactSecrets(`t ${gitlab}`)).toBe('t glpat-[REDACTED]…TAIL');
  });

  it('masks a key that merely contains an allowlisted word', () => {
    const key = fake('glpat-', `${rand(6)}false${rand(9)}`);
    expect(redactSecrets(`t ${key}`)).toBe(`t glpat-[REDACTED]…${key.slice(-4)}`);
  });

  it('finds a key that ends a sentence', () => {
    expect(redactSecrets(`bad key ${FAKES.google}.`)).toBe(`bad key AIza[REDACTED]…${FAKES.google.slice(-4)}.`);
  });
});
