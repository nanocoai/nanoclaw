/**
 * CLI 模式解析 — 从 ContainerConfig 解析当前群的 cliMode。
 *
 * 单独成轻量模块(无运行时副作用),供 registry/commands/channels 引用,
 * 避免为了一个纯函数而拖入 container-runner 的 OneCLI 等模块级副作用。
 * container-runner.ts re-export 本函数,保持既有 import 路径兼容。
 */
import type { CliMode, ContainerConfig } from './types.js';

export const ALL_CLI_MODES: CliMode[] = [
  'sdk',
  'print',
  'interactive',
  'codex',
  'gemini',
];

/** Anthropic(Claude Code)系模式:这几种共用 Claude 专属命令与思考修饰符 */
export const CLAUDE_MODES: CliMode[] = ['sdk', 'print', 'interactive'];

/** 从 ContainerConfig 解析 cliMode，向后兼容 useCliMode */
export function resolveCliMode(config?: ContainerConfig): CliMode {
  if (config?.cliMode) {
    if (!ALL_CLI_MODES.includes(config.cliMode)) {
      throw new Error(
        `Invalid cliMode: "${config.cliMode}". Valid values: ${ALL_CLI_MODES.join(', ')}`,
      );
    }
    return config.cliMode;
  }
  if (config?.useCliMode) return 'print';
  return 'sdk';
}
