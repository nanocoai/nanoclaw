/**
 * Wiring test for the add-tool-visibility skill's code-edit integration point.
 *
 * The skill appends two hook callbacks to the hook arrays the Claude provider
 * passes to the SDK in `ClaudeProvider.query()` (src/providers/claude.ts).
 * That edit is not invocable hermetically — calling `query()` spawns the real
 * Claude Code SDK subprocess, and the hooks config is an options literal with
 * no runtime registry to inspect — so this asserts the edit *structurally*,
 * via the TypeScript AST. It verifies not just that the symbols appear, but
 * that:
 *   - claude.ts statically imports `preToolUseVisibility` and
 *     `postToolUseVisibility` from '../hooks/tool-visibility.js',
 *   - `preToolUseVisibility` is an element of the inner `hooks` array of the
 *     PreToolUse matcher,
 *   - `postToolUseVisibility` is an element of the inner `hooks` arrays of
 *     BOTH the PostToolUse and PostToolUseFailure matchers,
 *   - each visibility hook comes AFTER the core hook in its array
 *     (`preToolUseHook` / `postToolUseHook`), so container_state recording
 *     still runs first even if visibility throws.
 *
 * Delete the import, drop a hook from an array, or flip the ordering and this
 * goes red. Combined with the behavior test (tool-visibility.test.ts, the
 * hook's consumption of the real session DBs) and the container typecheck
 * (drifted symbols/paths), the three legs cover deletion, misplacement,
 * drift, and core consumption.
 *
 * Ships with the skill; apply copies it to container/agent-runner/src/hooks/.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import ts from 'typescript';

const claudePath = path.resolve(import.meta.dir, '../providers/claude.ts');
const source = fs.readFileSync(claudePath, 'utf8');
const sf = ts.createSourceFile('claude.ts', source, ts.ScriptTarget.Latest, true);

/** Named imports from '../hooks/tool-visibility.js', or null if absent. */
function visibilityImportNames(): string[] | null {
  let names: string[] | null = null;
  sf.forEachChild((n) => {
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      n.moduleSpecifier.text === '../hooks/tool-visibility.js'
    ) {
      const bindings = n.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        names = bindings.elements.map((e) => e.name.text);
      }
    }
  });
  return names;
}

/**
 * Find the `hooks:` options property (the object literal keyed by hook event
 * names) and return, per event, the identifier names listed in the inner
 * `hooks: [...]` arrays of its matchers, in source order.
 */
function hookIdentifiersByEvent(): Map<string, string[]> {
  const events = new Map<string, string[]>();

  function innerHookNames(matcherArray: ts.ArrayLiteralExpression): string[] {
    const names: string[] = [];
    for (const matcher of matcherArray.elements) {
      if (!ts.isObjectLiteralExpression(matcher)) continue;
      for (const prop of matcher.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === 'hooks' &&
          ts.isArrayLiteralExpression(prop.initializer)
        ) {
          for (const el of prop.initializer.elements) {
            if (ts.isIdentifier(el)) names.push(el.text);
            else names.push(el.getText(sf)); // e.g. createPreCompactHook(...)
          }
        }
      }
    }
    return names;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'hooks' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      // The hooks *options* object is keyed by hook event names; a matcher's
      // inner `hooks` array holds callbacks, not an object literal — that's
      // how we tell the two apart.
      for (const prop of node.initializer.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          ts.isArrayLiteralExpression(prop.initializer)
        ) {
          events.set(prop.name.text, innerHookNames(prop.initializer));
        }
      }
    }
    node.forEachChild(visit);
  }
  visit(sf);
  return events;
}

describe('add-tool-visibility wiring in src/providers/claude.ts', () => {
  it("imports both visibility hooks from '../hooks/tool-visibility.js'", () => {
    const names = visibilityImportNames();
    expect(names, "static import from '../hooks/tool-visibility.js' must exist").not.toBeNull();
    expect(names).toContain('preToolUseVisibility');
    expect(names).toContain('postToolUseVisibility');
  });

  it('appends preToolUseVisibility to the PreToolUse hook array, after the core hook', () => {
    const pre = hookIdentifiersByEvent().get('PreToolUse') ?? [];
    const coreIdx = pre.indexOf('preToolUseHook');
    const visIdx = pre.indexOf('preToolUseVisibility');
    expect(coreIdx, 'core preToolUseHook anchor not found in PreToolUse').toBeGreaterThanOrEqual(0);
    expect(visIdx, 'preToolUseVisibility must be wired into PreToolUse').toBeGreaterThanOrEqual(0);
    expect(visIdx, 'visibility must run after the core hook (container_state first)').toBeGreaterThan(coreIdx);
  });

  it('appends postToolUseVisibility to the PostToolUse hook array, after the core hook', () => {
    const post = hookIdentifiersByEvent().get('PostToolUse') ?? [];
    const coreIdx = post.indexOf('postToolUseHook');
    const visIdx = post.indexOf('postToolUseVisibility');
    expect(coreIdx, 'core postToolUseHook anchor not found in PostToolUse').toBeGreaterThanOrEqual(0);
    expect(visIdx, 'postToolUseVisibility must be wired into PostToolUse').toBeGreaterThanOrEqual(0);
    expect(visIdx, 'visibility must run after the core hook (container_state first)').toBeGreaterThan(coreIdx);
  });

  it('appends postToolUseVisibility to the PostToolUseFailure hook array, after the core hook', () => {
    const fail = hookIdentifiersByEvent().get('PostToolUseFailure') ?? [];
    const coreIdx = fail.indexOf('postToolUseHook');
    const visIdx = fail.indexOf('postToolUseVisibility');
    expect(coreIdx, 'core postToolUseHook anchor not found in PostToolUseFailure').toBeGreaterThanOrEqual(0);
    expect(visIdx, 'postToolUseVisibility must be wired into PostToolUseFailure').toBeGreaterThanOrEqual(0);
    expect(visIdx, 'visibility must run after the core hook (container_state first)').toBeGreaterThan(coreIdx);
  });
});
