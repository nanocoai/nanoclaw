export function truncateForAi(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n…[truncated ${text.length - maxChars} chars]`;
  const slice = Math.max(0, maxChars - marker.length);
  return text.slice(0, slice) + marker;
}
