import { describe, expect, it } from 'vitest';

import { analyzeTmuxPane } from './tmux-session-manager.js';

describe('analyzeTmuxPane ready 判定', () => {
  it('新会话欢迎页（Try 提示）→ ready', () => {
    const pane = `╭─ Claude Code ─╮
Try "fix lint errors"
❯ `;
    expect(analyzeTmuxPane(pane).state).toBe('ready');
  });

  it('resume 老会话后 idle 状态栏（v2.1.170+ 无 Try/无 /effort）→ ready', () => {
    // 真实案例：2026-06-10 Gemini3_1 群 11MB session resume 成功但 readiness 不识别，
    // 60s 超时反杀好端端的 CLI（pane 取自 diag log）
    const pane = `收工。
✻ Crunched for 2m 49s
❯
────────────────────────
⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents 3% until auto-compact`;
    expect(analyzeTmuxPane(pane).state).toBe('ready');
  });

  it('busy（esc to interrupt 在状态栏）→ 不是 ready', () => {
    const pane = `⏺ Bash(npm test)
· Effecting… (4m 26s · ↓ 17.4k tokens)
❯
⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt`;
    const result = analyzeTmuxPane(pane);
    expect(result.state).not.toBe('ready');
    expect(result.state).toBe('busy');
  });

  it('Resume session 搜索页 → blocked-resume-search', () => {
    const pane = `Resume session
Type to Search`;
    expect(analyzeTmuxPane(pane).state).toBe('blocked-resume-search');
  });

  it('信任目录对话框 → recoverable-dialog', () => {
    const pane = `Do you trust this folder?
Press Enter to continue`;
    expect(analyzeTmuxPane(pane).state).toBe('recoverable-dialog');
  });

  it('鉴权失败 → auth-error', () => {
    const pane = `Not logged in. Run /login`;
    expect(analyzeTmuxPane(pane).state).toBe('auth-error');
  });

  it('渲染历史中（无状态栏、有 ⏺）→ busy 不误判 ready', () => {
    const pane = `⏺ Bash(ssh dev 'docker exec ...')
  ⎿ "ok": true`;
    expect(analyzeTmuxPane(pane).state).toBe('busy');
  });
});
