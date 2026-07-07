/**
 * Wiring test for the add-dashboard skill's code-edit integration point.
 *
 * The skill inserts one colocated block into src/index.ts (a dynamic
 * `import('./dashboard-pusher.js')` + `await startDashboard()` in main()). A
 * behavioral test of the pusher can't see whether that edit is actually
 * present and correctly placed — booting the real host is too heavy — so this
 * asserts the edit *structurally*, via the TypeScript AST. It verifies not
 * just that the call exists, but that:
 *   - the pusher module is dynamically imported by its correct path,
 *   - startDashboard() is awaited,
 *   - both are DIRECT statements of main()'s body (right scope/level, not
 *     nested or stranded in another function),
 *   - the import precedes the call, and the whole block sits after DB init
 *     and before the boot-complete log (right place).
 *
 * Delete or misplace the edit and this goes red. Combined with the unit test
 * (behavior of startDashboard) and the build (the call still type-checks),
 * the three together cover deletion, misplacement, drift, and behavior — for
 * a true code edit, with no registry required.
 *
 * Ships with the skill; apply copies it to src/.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const indexPath = path.resolve(process.cwd(), 'src/index.ts');
const source = fs.readFileSync(indexPath, 'utf8');
const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);

function mainBody(): ts.NodeArray<ts.Statement> {
  let body: ts.NodeArray<ts.Statement> | undefined;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'main' && n.body) {
      body = n.body.statements;
    }
  });
  if (!body) throw new Error('main() not found in src/index.ts');
  return body;
}

function isAwaitedStartDashboard(s: ts.Statement): boolean {
  return (
    ts.isExpressionStatement(s) &&
    ts.isAwaitExpression(s.expression) &&
    ts.isCallExpression(s.expression.expression) &&
    ts.isIdentifier(s.expression.expression.expression) &&
    s.expression.expression.expression.text === 'startDashboard'
  );
}

/** `const { ... } = await import('./dashboard-pusher.js')` as a statement. */
function isDynamicImportOfPusher(s: ts.Statement): boolean {
  if (!ts.isVariableStatement(s)) return false;
  const init = s.declarationList.declarations[0]?.initializer;
  if (!init || !ts.isAwaitExpression(init) || !ts.isCallExpression(init.expression)) return false;
  const call = init.expression;
  if (call.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
  const arg = call.arguments[0];
  return !!arg && ts.isStringLiteral(arg) && arg.text === './dashboard-pusher.js';
}

describe('add-dashboard wiring in src/index.ts', () => {
  it('dynamically imports the pusher and awaits startDashboard(), colocated in main(), after DB init and before the boot-complete log', () => {
    const stmts = mainBody();
    const importIdx = stmts.findIndex(isDynamicImportOfPusher);
    const callIdx = stmts.findIndex(isAwaitedStartDashboard);
    const migrateIdx = stmts.findIndex((s) => s.getText(sf).includes('runMigrations('));
    const runningIdx = stmts.findIndex((s) => s.getText(sf).includes("log.info('NanoClaw running')"));

    expect(importIdx, "dynamic import('./dashboard-pusher.js') must be a statement of main()").toBeGreaterThanOrEqual(0);
    expect(callIdx, 'await startDashboard() must be a statement of main()').toBeGreaterThanOrEqual(0);
    expect(migrateIdx, 'runMigrations() anchor not found').toBeGreaterThanOrEqual(0);
    expect(runningIdx, 'boot-complete log anchor not found').toBeGreaterThanOrEqual(0);
    expect(importIdx, 'the dynamic import must come after DB init').toBeGreaterThan(migrateIdx);
    expect(callIdx, 'the call must come after its import (colocated)').toBeGreaterThan(importIdx);
    expect(callIdx, 'startDashboard() must run before the boot-complete log').toBeLessThan(runningIdx);
  });
});
