/**
 * Concatenate the text blocks of an SDK assistant message's `content` array,
 * ignoring tool_use / tool_result / other block types. Returns '' when the
 * content isn't an array of blocks or holds no text.
 *
 * Lives in its own module (free of the agent SDK import) so it can be unit
 * tested without pulling in the whole provider. Used by the Claude provider to
 * surface assistant text as it streams — see the `assistant_text` ProviderEvent.
 */
export function assistantTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text?: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}
