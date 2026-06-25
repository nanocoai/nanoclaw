// Generic provider tool-result middleware seam. INERT by default: with
// no registrant, applyToolResultMiddleware returns its input UNCHANGED
// (changed:false), so claude.ts's PostToolUse hook behaves byte-identically to
// upstream — it only clears the in-flight tool and returns { continue: true }.
// An overlay may register a middleware that rewrites a tool_response payload
// before the SDK records it as a tool_result (e.g. strip lone UTF-16 surrogates
// that would otherwise 400 the next request). Composed by left-fold in
// registration order; `changed` is true iff the folded value differs by
// reference from the input (so a no-op middleware never forces updatedToolOutput).
export type ToolResultMiddleware = (value: unknown) => unknown;

const middlewares: ToolResultMiddleware[] = [];

export function registerToolResultMiddleware(fn: ToolResultMiddleware): void {
  middlewares.push(fn);
}

/** Left-fold over registrants. No registrant ⇒ { value, changed:false }. */
export function applyToolResultMiddleware(value: unknown): { value: unknown; changed: boolean } {
  const folded = middlewares.reduce((acc, fn) => fn(acc), value);
  return { value: folded, changed: folded !== value };
}

export function __resetToolResultMiddlewareForTest(): void {
  middlewares.length = 0;
}
