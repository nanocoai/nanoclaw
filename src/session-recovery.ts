export function isSessionRecoveryError(error: string | undefined): boolean {
  return /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
    error ?? '',
  );
}

export function buildSessionRecoveryMessage(input: {
  sessionId?: string;
  error?: string;
}): string {
  const sessionLine = input.sessionId
    ? `当前 session：${input.sessionId}`
    : '当前 session：未知';
  const errorLine = input.error ? `错误：${input.error}` : '错误：未知';
  return [
    '⚠️ 当前会话恢复失败，我没有自动切换到新 session。',
    sessionLine,
    errorLine,
    '如果要丢弃旧上下文重新开始，请发送 /new；如果要保留现场继续排查，把这条错误发我就行。',
  ].join('\n');
}
