import fs from 'node:fs';
import ts from 'typescript';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('./router.js', () => ({ routeInbound: vi.fn() }));
vi.mock('./log.js', () => ({ log: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), fatal: vi.fn() } }));
import { routeInbound } from './router.js';
import { channelInboundHandler } from './channel-inbound.js';
import { log } from './log.js';

beforeEach(() => vi.resetAllMocks());
const message = {
  id: 'message',
  kind: 'chat' as const,
  content: { text: 'hello' },
  timestamp: '2026-09-07T00:00:00.000Z',
};

it('returns pending host acceptance and preserves instance context', async () => {
  let accept!: () => void;
  vi.mocked(routeInbound).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
  );
  const promise = channelInboundHandler({ channelType: 'nostr', instance: 'personal' })('peer', null, {
    ...message,
  });
  let settled = false;
  void Promise.resolve(promise).then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(routeInbound).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(routeInbound).toHaveBeenCalledWith(
    expect.objectContaining({
      channelType: 'nostr',
      instance: 'personal',
      platformId: 'peer',
      message: expect.objectContaining({ content: '{"text":"hello"}' }),
    }),
  );
  accept();
  await promise;
  expect(settled).toBe(true);
});

it.each(['throw', 'reject'])('logs a routing %s while returning failure to the adapter', async (failure) => {
  const error = new Error('mailbox write failed');
  vi.mocked(routeInbound).mockImplementation(() => {
    if (failure === 'throw') throw error;
    return Promise.reject(error);
  });
  await expect(channelInboundHandler({ channelType: 'nostr' })('peer', null, message)).rejects.toBe(error);
  expect(log.error).toHaveBeenCalledOnce();
});

it('observes routing failure when an existing adapter ignores the returned promise', async () => {
  const error = new Error('mailbox unavailable');
  vi.mocked(routeInbound).mockRejectedValue(error);

  // Existing adapters may call this without awaiting or attaching a catch.
  // Vitest also fails this test if the ignored promise becomes unhandled.
  void channelInboundHandler({ channelType: 'test' })('peer', null, message);

  await vi.waitFor(() =>
    expect(log.error).toHaveBeenCalledWith('Failed to route inbound message', {
      channelType: 'test',
      err: error,
    }),
  );
  expect(routeInbound).toHaveBeenCalledWith(expect.objectContaining({ instance: 'test' }));
});

it('wires the acceptance-preserving handler at the real channel startup boundary', () => {
  const file = ts.createSourceFile('index.ts', fs.readFileSync('src/index.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = file.statements.filter(ts.isImportDeclaration);
  expect(
    imports.some(
      (node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './channel-inbound.js',
    ),
  ).toBe(true);
  let wired = false;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'initChannelAdapters') {
      const setup = node.arguments[0];
      if (setup && ts.isArrowFunction(setup) && ts.isBlock(setup.body)) {
        for (const statement of setup.body.statements) {
          if (
            !ts.isReturnStatement(statement) ||
            !statement.expression ||
            !ts.isObjectLiteralExpression(statement.expression)
          )
            continue;
          wired = statement.expression.properties.some(
            (prop) =>
              ts.isPropertyAssignment(prop) &&
              prop.name.getText(file) === 'onInbound' &&
              ts.isCallExpression(prop.initializer) &&
              prop.initializer.expression.getText(file) === 'channelInboundHandler' &&
              prop.initializer.arguments[0]?.getText(file) === 'adapter',
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(wired).toBe(true);
});

it('snapshots caller-owned data before returning the completion promise', async () => {
  vi.mocked(routeInbound).mockResolvedValue(undefined);
  const adapter = { channelType: 'test', instance: 'original' };
  const input = { ...message, content: { text: 'original' } };
  const completion = channelInboundHandler(adapter)('peer', 'thread', input);
  input.id = 'changed';
  input.content.text = 'changed';
  adapter.instance = 'changed';
  await completion;
  expect(routeInbound).toHaveBeenCalledWith({
    channelType: 'test',
    instance: 'original',
    platformId: 'peer',
    threadId: 'thread',
    message: {
      id: 'message',
      kind: 'chat',
      content: '{"text":"original"}',
      timestamp: message.timestamp,
      isMention: undefined,
      isGroup: undefined,
    },
  });
});
