import { writeChatMessageOnce } from './messages-out.js';

const id = Bun.argv[2];
if (!id) throw new Error('message id argument is required');

const result = writeChatMessageOnce(
  {
    id,
    in_reply_to: 'inbound-1',
    channel_type: 'mouse',
    platform_id: 'mouse-chat',
    thread_id: null,
    text: 'Exactly once.',
  },
  'turn-1',
  id === 'mcp-process' ? 'mcp' : 'final',
);

process.stdout.write(JSON.stringify(result));
