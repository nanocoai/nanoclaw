/**
 * Split a concatenated stream of pretty-printed JSON documents.
 *
 * Watch-style runtime CLIs emit one indented JSON object per event with no
 * separator, so a line-based parser cannot find the boundaries. Brace-depth scanning can, provided it ignores braces inside
 * strings — which is the entire subtlety here.
 */
export class JsonDocumentStream {
  #buffer = '';
  #depth = 0;
  #inString = false;
  #escaped = false;
  #start = -1;

  /** Feed a chunk; returns every document completed by it. */
  push(chunk: string): unknown[] {
    const docs: unknown[] = [];
    this.#buffer += chunk;
    for (let i = this.#buffer.length - chunk.length; i < this.#buffer.length; i++) {
      const ch = this.#buffer[i];
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (ch === '\\') this.#escaped = true;
        else if (ch === '"') this.#inString = false;
        continue;
      }
      if (ch === '"') {
        this.#inString = true;
      } else if (ch === '{') {
        if (this.#depth === 0) this.#start = i;
        this.#depth++;
      } else if (ch === '}') {
        this.#depth--;
        if (this.#depth === 0 && this.#start >= 0) {
          const text = this.#buffer.slice(this.#start, i + 1);
          try {
            docs.push(JSON.parse(text));
          } catch {
            /* a truncated or non-JSON preamble is not worth killing supervision over */
          }
          this.#buffer = this.#buffer.slice(i + 1);
          i = -1;
          this.#start = -1;
        }
      }
    }
    // Never let an un-terminated document grow without bound.
    if (this.#depth === 0 && this.#buffer.length > 1_000_000) this.#buffer = '';
    return docs;
  }
}
