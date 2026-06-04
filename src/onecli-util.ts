/**
 * 解析 onecli list 类命令（secrets list / agents list / agents secrets 等）的输出。
 * 兼容两种格式：
 *   - 旧版：直接返回 JSON 数组 `[...]`
 *   - 新版：包装成 `{ "hint": "...", "data": [...] }`
 * onecli 升级后输出从数组改为 {hint,data}，所有直接 .find/.length 的旧代码都会崩，
 * 统一走这里取数组，前后版本都安全。
 */
export function parseOneCLIList<T = unknown>(raw: string): T[] {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed && Array.isArray((parsed as { data?: unknown }).data)) {
    return (parsed as { data: T[] }).data;
  }
  return [];
}

export function isAnthropicSecret(secret: { type?: string }): boolean {
  return secret.type === 'anthropic' || secret.type == null;
}

export function filterAnthropicSecrets<T extends { type?: string }>(
  secrets: T[],
): T[] {
  return secrets.filter(isAnthropicSecret);
}
