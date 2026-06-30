const POOL_FOOTER_PREFIX = '今日仅';

export function formatDigestMessage(msg: {
  dateLabel: string;
  entries: Array<{ rank: number; title: string; summary: string; url: string }>;
  qualifiedCount: number;
  emptyMessage?: string;
}): string {
  const lines: string[] = [`📰 AI 技术日报 · ${msg.dateLabel}`, '---', ''];

  if (msg.entries.length === 0) {
    lines.push(msg.emptyMessage ?? '今日无 notable AI 热点');
  } else {
    for (const entry of msg.entries) {
      lines.push(`${entry.rank}. ${entry.title}`);
      lines.push(entry.summary);
      lines.push(entry.url);
      lines.push('');
    }
  }

  if (msg.qualifiedCount < 5) {
    lines.push(
      `${POOL_FOOTER_PREFIX} ${msg.qualifiedCount} 条合格条目 (候选池 < 5)`,
    );
  }

  return lines.join('\n').trimEnd();
}
