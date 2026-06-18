/**
 * 收尾型工具白名单（finalizing tools）。
 *
 * 白名单内的工具是「纯记账、对用户和外部系统均无副作用」的工具——它们出现
 * 不代表 agent 还在继续干活。当一段缓存的 assistant 文本后面只跟随白名单内的
 * 工具时，这段文本应被当作正式回复发出，而非降级成 💬 中间叙述。
 *
 * 初始只含 TodoWrite。未来若要扩充，新增工具名 + 补单测即可。
 */
export const FINALIZING_TOOLS: ReadonlySet<string> = new Set(['TodoWrite']);

/**
 * 判定一段缓存文本之后跟随的工具是否「全部」落在收尾型工具白名单内。
 *
 * @param toolNames 该段文本被缓存之后、依次出现的所有 tool_use 工具名
 * @returns 仅当至少有一个跟随工具、且所有跟随工具都在白名单内时返回 true
 *
 * 约定：空数组返回 false。没有任何跟随工具属于「end_turn 纯文本回复」场景，
 * 走 SDK result 的正常正式回复路径，不归本判定处理。
 */
export function isFinalizingOnly(toolNames: string[]): boolean {
  if (toolNames.length === 0) return false;
  return toolNames.every((name) => FINALIZING_TOOLS.has(name));
}
