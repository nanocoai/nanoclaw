/**
 * Trailing run of orphan harness tags. The model occasionally leaks spurious
 * tool syntax (e.g. `<invoke name="Bash">` or `</parameter>`) at the very end
 * of a <message> body, and it reaches the user verbatim. Matches one or more
 * known opening or closing harness tags — case-insensitive, optional opening-
 * tag attributes and whitespace/newlines allowed — anchored to the END of the
 * string only, so legitimate content that *discusses* these tags mid-text is
 * never touched.
 */
const TRAILING_HARNESS_TAGS_RE =
  /(?:\s*<\/?(?:parameter|invoke|function_calls|function_results|dispatch)(?:\s+[^<>]*?)?\s*>)+\s*$/i;

/**
 * Remove a trailing run of orphan opening or closing harness tags from text
 * bound for delivery, along with the whitespace that separated them from the
 * content. Text without a trailing run is returned unchanged.
 */
export function stripHarnessTagArtifacts(text: string): string {
  return text.replace(TRAILING_HARNESS_TAGS_RE, '');
}
