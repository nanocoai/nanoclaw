/**
 * tmux 会话管理器 — 纯函数单元测试
 */
import { describe, it, expect } from 'vitest';
import {
  buildTmuxSessionName,
  escapeTmuxInput,
  buildInteractiveCliArgs,
  buildTmuxCommand,
  analyzeTmuxPane,
  shellQuote,
  SEND_KEYS_MAX_BYTES,
} from '../container/agent-runner/src/tmux-session-manager.js';

describe('buildTmuxSessionName', () => {
  it('过滤非字母数字字符，拼接完整 id', () => {
    const name = buildTmuxSessionName('fs_oc_e6ce3bf2d85d6c9ec049a96e1219c7d6');
    expect(name).toBe('nanoclaw-fsoce6ce3bf2d85d6c9ec049a96e1219c7d6');
  });

  it('短 chatJid 使用全部', () => {
    const name = buildTmuxSessionName('abc');
    expect(name).toBe('nanoclaw-abc');
  });

  it('空 chatJid 使用 unknown', () => {
    const name = buildTmuxSessionName('');
    expect(name).toBe('nanoclaw-unknown');
  });

  it('特殊字符被过滤', () => {
    const name = buildTmuxSessionName('fs:oc_123');
    expect(name).toBe('nanoclaw-fsoc123');
  });

  it('相同输入返回相同结果（确定性）', () => {
    const name1 = buildTmuxSessionName('test');
    const name2 = buildTmuxSessionName('test');
    expect(name1).toBe('nanoclaw-test');
    expect(name1).toBe(name2);
  });
});

describe('escapeTmuxInput', () => {
  it('普通文本不变', () => {
    expect(escapeTmuxInput('hello world')).toBe('hello world');
  });

  it('换行替换为空格', () => {
    expect(escapeTmuxInput('line1\nline2\nline3')).toBe('line1 line2 line3');
  });

  it('保留 $ 符号', () => {
    expect(escapeTmuxInput('echo $HOME')).toBe('echo $HOME');
  });

  it('保留引号', () => {
    expect(escapeTmuxInput('it\'s a "test"')).toBe('it\'s a "test"');
  });

  it('保留反斜杠', () => {
    expect(escapeTmuxInput('path\\to\\file')).toBe('path\\to\\file');
  });

  it('中文文本不变', () => {
    expect(escapeTmuxInput('帮我写一个排序函数')).toBe('帮我写一个排序函数');
  });

  it('空文本', () => {
    expect(escapeTmuxInput('')).toBe('');
  });
});

describe('buildInteractiveCliArgs', () => {
  it('基本参数（不含 --print）', () => {
    const args = buildInteractiveCliArgs({
      mcpConfigPath: '/tmp/mcp.json',
    });
    expect(args).not.toContain('--print');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/mcp.json');
  });

  it('指定 model', () => {
    const args = buildInteractiveCliArgs({
      model: 'claude-3-5-sonnet',
      mcpConfigPath: '/tmp/mcp.json',
    });
    expect(args).toContain('--model');
    expect(args).toContain('claude-3-5-sonnet');
  });

  it('interactive 调用侧传入默认 model 时会生成 --model', () => {
    const args = buildInteractiveCliArgs({
      model: 'claude-opus-4-8',
      mcpConfigPath: '/tmp/mcp.json',
      sessionId: '30270a9e-916e-47bb-b50a-72c98f89d08b',
    });
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
  });

  it('resume session', () => {
    const args = buildInteractiveCliArgs({
      mcpConfigPath: '/tmp/mcp.json',
      sessionId: 'session_abc123',
    });
    expect(args).toContain('--resume');
    expect(args).toContain('session_abc123');
  });

  it('额外目录', () => {
    const args = buildInteractiveCliArgs({
      mcpConfigPath: '/tmp/mcp.json',
      additionalDirectories: ['/extra/dir1', '/extra/dir2'],
    });
    const addDirIndices = args.reduce<number[]>((acc, arg, i) => {
      if (arg === '--add-dir') acc.push(i);
      return acc;
    }, []);
    expect(addDirIndices).toHaveLength(2);
    expect(args[addDirIndices[0] + 1]).toBe('/extra/dir1');
    expect(args[addDirIndices[1] + 1]).toBe('/extra/dir2');
  });

  it('system prompt append', () => {
    const args = buildInteractiveCliArgs({
      mcpConfigPath: '/tmp/mcp.json',
      systemPromptAppend: 'You are a helpful assistant',
    });
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('You are a helpful assistant');
  });

  it('禁用 skip-permissions', () => {
    const args = buildInteractiveCliArgs({
      mcpConfigPath: '/tmp/mcp.json',
      dangerouslySkipPermissions: false,
    });
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});

describe('analyzeTmuxPane', () => {
  it('识别正常就绪提示', () => {
    const pane = 'Claude Code v2.1.162\n❯\n⏵⏵ bypass permissions on · /effort';
    expect(analyzeTmuxPane(pane).state).toBe('ready');
  });

  it('识别 Resume session 搜索页为阻塞坏态', () => {
    const pane = [
      'Resume session',
      '⌕ new-fs:oc_df0d2dcb8747d8bcc2047c60ddcc7120-1779164795213',
      'No sessions match "new-fs:oc_df0d2dcb8747d8bcc2047c60ddcc7120-1779164795213".',
      'Type to Search · Enter to select · Esc to clear',
    ].join('\n');
    const result = analyzeTmuxPane(pane);
    expect(result.state).toBe('blocked-resume-search');
    expect(result.reason).toContain('Resume session');
  });

  it('识别可自动确认的欢迎页', () => {
    const result = analyzeTmuxPane('Welcome\nPress Enter to continue');
    expect(result.state).toBe('recoverable-dialog');
    expect(result.action).toBe('enter');
  });
});

describe('buildTmuxCommand', () => {
  it('new-session', () => {
    const args = buildTmuxCommand('new-session', 'my-session', [
      'claude --model haiku',
    ]);
    expect(args).toEqual([
      'tmux',
      'new-session',
      '-d',
      '-s',
      'my-session',
      '-x',
      '200',
      '-y',
      '50',
      'claude --model haiku',
    ]);
  });

  it('send-keys 显式指定 window 0', () => {
    const args = buildTmuxCommand('send-keys', 'my-session', ['-l', 'hello']);
    expect(args).toEqual([
      'tmux',
      'send-keys',
      '-t',
      'my-session:0',
      '-l',
      'hello',
    ]);
  });

  it('send-keys Enter 也指定 window 0', () => {
    const args = buildTmuxCommand('send-keys', 'my-session', ['Enter']);
    expect(args).toEqual(['tmux', 'send-keys', '-t', 'my-session:0', 'Enter']);
  });

  it('kill-session', () => {
    const args = buildTmuxCommand('kill-session', 'my-session');
    expect(args).toEqual(['tmux', 'kill-session', '-t', 'my-session']);
  });

  it('has-session', () => {
    const args = buildTmuxCommand('has-session', 'my-session');
    expect(args).toEqual(['tmux', 'has-session', '-t', 'my-session']);
  });

  it('list-sessions', () => {
    const args = buildTmuxCommand('list-sessions', '');
    expect(args).toEqual(['tmux', 'list-sessions', '-F', '#{session_name}']);
  });

  it('load-buffer', () => {
    const args = buildTmuxCommand('load-buffer', '', ['/tmp/msg.txt']);
    expect(args).toEqual(['tmux', 'load-buffer', '/tmp/msg.txt']);
  });

  it('paste-buffer 显式指定 window 0', () => {
    const args = buildTmuxCommand('paste-buffer', 'my-session');
    expect(args).toEqual(['tmux', 'paste-buffer', '-t', 'my-session:0']);
  });

  it('capture-pane 显式指定 window 0', () => {
    const args = buildTmuxCommand('capture-pane', 'my-session', ['-S', '-50']);
    expect(args).toEqual([
      'tmux',
      'capture-pane',
      '-t',
      'my-session:0',
      '-p',
      '-S',
      '-50',
    ]);
  });
});

describe('shellQuote', () => {
  it('普通文本用单引号包裹', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('包含空格', () => {
    expect(shellQuote('hello world')).toBe("'hello world'");
  });

  it('转义内部单引号', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('防止 $() 命令替换', () => {
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });

  it('防止反引号命令替换', () => {
    expect(shellQuote('`whoami`')).toBe("'`whoami`'");
  });

  it('防止双引号内变量展开', () => {
    expect(shellQuote('$HOME')).toBe("'$HOME'");
  });

  it('空字符串', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('SEND_KEYS_MAX_BYTES', () => {
  it('是 2048 字节', () => {
    expect(SEND_KEYS_MAX_BYTES).toBe(2048);
  });
});
