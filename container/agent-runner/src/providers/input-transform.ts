// Generic provider input-transform seam. INERT by default:
// with no registrant, applyInputTransform returns its input UNCHANGED (identity),
// so claude.ts behaves byte-identically to upstream. An overlay may register a
// transform that rewrites a user-facing text payload before it reaches the SDK.
// Composed by left-fold in registration order.
export type InputKind = 'prompt' | 'instructions';
export type InputTransform = (text: string, kind: InputKind) => string;

const transforms: InputTransform[] = [];

export function registerInputTransform(fn: InputTransform): void {
  transforms.push(fn);
}

/** Left-fold over registrants. No registrant ⇒ returns `text` unchanged. */
export function applyInputTransform(text: string, kind: InputKind): string {
  return transforms.reduce((acc, fn) => fn(acc, kind), text);
}

export function __resetInputTransformForTest(): void {
  transforms.length = 0;
}
