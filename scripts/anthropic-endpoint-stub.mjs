/**
 * A stand-in for Ollama's Anthropic-compatible surface, for verifying the
 * wiring before (or without) a real daemon.
 *
 * Serves POST /v1/messages with one canned assistant turn — SSE when the
 * client asks to stream, plain JSON otherwise — plus
 * POST /v1/messages/count_tokens. Every request is logged to stderr, so the
 * log alone answers the two questions that matter: did the container reach
 * this endpoint instead of Anthropic's, and did it ask for the model the
 * group's config names.
 *
 * Dependency-free node. Driven by `scripts/test-v2-endpoint-e2e.ts`; run it
 * directly to point a group's base_url at a fake endpoint by hand:
 *   node scripts/anthropic-endpoint-stub.mjs [port] [reply-text]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 21747);
const REPLY = process.argv[3] || 'stub reply';
const MODEL = process.env.STUB_MODEL || 'stub-model:latest';

let hits = 0;

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const [event, data] of chunks) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function messageChunks(text) {
  return [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_stub_0001',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 24 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    hits++;
    const url = (req.url || '').split('?')[0];
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* a non-JSON body is fine — the stub only reads model/stream */
    }
    console.error(
      `[stub] #${hits} ${req.method} ${req.url} model=${body.model ?? '-'} stream=${body.stream ?? false} bytes=${raw.length}`,
    );

    if (url.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 12 }));
      return;
    }
    if (url.endsWith('/v1/messages')) {
      if (body.stream) return sse(res, messageChunks(REPLY));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_stub_0001',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: REPLY }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 24 },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stub: 'anthropic-shape' }));
  });
});

server.listen(PORT, '0.0.0.0', () => console.error(`[stub] listening on 0.0.0.0:${PORT} (model ${MODEL})`));
