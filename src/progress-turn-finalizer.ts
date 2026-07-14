interface InteractiveTurnChannel {
  tryFinalizeTextOnly?: (jid: string) => Promise<boolean>;
  sendUsageOnly?: (jid: string) => Promise<void>;
  cleanupProgressCard?: (jid: string) => Promise<void>;
}

/**
 * 收口 CLI interactive 的空正文 turn：优先把 text-only 起手卡转成结果卡，
 * 未命中时保持原有 usage-only → cleanup 顺序。
 */
export async function finalizeInteractiveTurn(
  channel: object,
  jid: string,
  textSentToUser: boolean,
): Promise<boolean> {
  const capabilities = channel as InteractiveTurnChannel;
  const finalized = capabilities.tryFinalizeTextOnly
    ? await capabilities.tryFinalizeTextOnly(jid)
    : false;
  if (finalized) return true;
  if (textSentToUser && capabilities.sendUsageOnly) {
    await capabilities.sendUsageOnly(jid);
  }
  await capabilities.cleanupProgressCard?.(jid);
  return false;
}
