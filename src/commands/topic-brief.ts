import { logger } from '../logger.js';
import { registerCommand } from './registry.js';

export const MANUAL_TOPIC_BRIEF_PROMPT = [
  '[AUTO_TOPIC_BRIEF]',
  '你刚才已经回复了用户。现在请补发一条极简话题回顾，只做上下文压缩，不要继续执行任务。',
  '',
  '要求：',
  '1. 只输出两行。',
  '2. 第一行以「这是什么事：」开头，用一句话说清楚这个话题的缘由。',
  '3. 第二行以「当前结论：」开头，用一句话总结当前回复的结论，以及是否需要大杰处理。',
  '4. 不要调用工具，不要新增事实，不要复述流水账。',
  '5. 不要解释规则，不要输出多余文本。',
].join('\n');

// /j — 手动补发当前话题的两行回顾
registerCommand({
  name: '/j',
  description: '手动补发当前话题两行回顾',
  order: 23,
  handler: async (ctx) => {
    const queued = ctx.queue.sendMessage(
      ctx.chatJid,
      MANUAL_TOPIC_BRIEF_PROMPT,
      { thinking: 'disabled' },
      null,
      ctx.msg.sender,
    );

    logger.info(
      { group: ctx.group.folder, queued },
      '/j: 手动话题回顾请求',
    );

    if (!queued) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        '当前没有活跃会话可触发话题回顾。请在刚收到回复后再用 /j。',
      );
    }
  },
});
