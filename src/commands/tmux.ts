import { execFileSync } from 'child_process';
import { registerCommand } from './registry.js';

/**
 * 复现 container/agent-runner/src/tmux-session-manager.ts 的 buildTmuxSessionName。
 * 命名规则：nanoclaw-<chatJid 去掉非字母数字>，与群绑定固定不变。
 * （主进程不直接 import agent-runner 模块，避免拖入 tmux manager 运行时依赖；逻辑极简，复现并注明同源。）
 */
function buildTmuxSessionName(chatJid: string): string {
  const id = chatJid.replace(/[^a-zA-Z0-9]/g, '') || 'unknown';
  return `nanoclaw-${id}`;
}

// /tmux — 显示进入当前会话 tmux 窗口的命令（仅 interactive 模式）
// interactive 模式下 Claude CLI 跑在 per-group tmux 窗口里，本命令让你从宿主终端
// attach 进同一窗口，实时围观正在发生什么。
registerCommand({
  name: '/tmux',
  description: '显示进入当前 tmux 窗口的命令（仅 interactive 模式）',
  order: 43,
  modes: ['interactive'],
  handler: async (ctx) => {
    const session = buildTmuxSessionName(ctx.chatJid);
    let alive = false;
    try {
      execFileSync('tmux', ['has-session', '-t', session], {
        timeout: 5000,
        stdio: 'ignore',
      });
      alive = true;
    } catch {
      alive = false;
    }

    if (!alive) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `⚠️ 当前没有活跃的 tmux 窗口（${session}）。\n先发一条消息触发一轮对话，窗口起来后再 /tmux。`,
      );
      return;
    }

    const msg = [
      `📺 tmux 窗口: ${session}`,
      ``,
      `围观（只读，不会误触打断 Claude）:`,
      `  tmux attach -r -t ${session}`,
      ``,
      `进入并可操作:`,
      `  tmux attach -t ${session}`,
      ``,
      `退出窗口（detach，不影响后台运行）: 按 Ctrl-b 再按 d`,
    ].join('\n');
    await ctx.channel.sendMessage(ctx.chatJid, msg);
  },
});
