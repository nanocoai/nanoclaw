/**
 * 输出过滤器 — 拦截不应发送给用户的 agent 输出
 *
 * 两类过滤：
 * 1. thinking progress — 模型内部思考过程，发出去会被用户看到并触发新一轮处理（死循环）
 * 2. 模型拒绝文本 — "No response requested." 等，模型认为不需要回复时产生的文本
 */

// 模型拒绝回复文本 — 这些不应发给用户（会触发死循环）
// 注意：必须精确匹配完整短句（以句号或行尾结束），避免误拦截 "Not applicable here because..." 等正常回复
export const MODEL_REFUSAL_PATTERN =
  /^(?:No response requested\.|I don't have (?:a |any )?(?:response|reply)\.?|not applicable\.?)$/i;

/**
 * 判断 progress 类型是否应被过滤（不发给用户）
 * 目前只过滤 thinking 类型
 */
export function shouldFilterProgress(progressType: string | undefined): boolean {
  return progressType === 'thinking';
}

/**
 * 判断最终回复文本是否为模型拒绝文本（不应发给用户）
 */
export function isModelRefusal(text: string): boolean {
  return MODEL_REFUSAL_PATTERN.test(text);
}
