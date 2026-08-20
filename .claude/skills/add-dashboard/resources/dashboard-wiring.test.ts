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
 * Startup is the skill's only edit to core: teardown rides the host's
 * `onHostShutdown` registry from inside dashboard-pusher.ts, so it is a
 * behavior test in dashboard-pusher.test.ts rather than an assertion here.
 *
 * The second describe guards the pusher's two read boundaries, which no
 * behavior test can see on the default all-SQLite composition.
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

const pusherPath = path.resolve(process.cwd(), 'src/dashboard-pusher.ts');
const pusherSf = ts.createSourceFile(
  'dashboard-pusher.ts',
  fs.readFileSync(pusherPath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

/** Module specifiers the pusher imports — code, so comments can't fake it. */
function pusherImports(): string[] {
  const specifiers: string[] = [];
  pusherSf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) specifiers.push(n.moduleSpecifier.text);
  });
  return specifiers;
}

/** Every string/template literal in the pusher — the SQL and paths it runs. */
function pusherLiterals(): string[] {
  const literals: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) literals.push(node.text);
    node.forEachChild(walk);
  };
  pusherSf.forEachChild(walk);
  return literals;
}

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

    expect(importIdx, "dynamic import('./dashboard-pusher.js') must be a statement of main()").toBeGreaterThanOrEqual(
      0,
    );
    expect(callIdx, 'await startDashboard() must be a statement of main()').toBeGreaterThanOrEqual(0);
    expect(migrateIdx, 'runMigrations() anchor not found').toBeGreaterThanOrEqual(0);
    expect(runningIdx, 'boot-complete log anchor not found').toBeGreaterThanOrEqual(0);
    expect(importIdx, 'the dynamic import must come after DB init').toBeGreaterThan(migrateIdx);
    expect(callIdx, 'the call must come after its import (colocated)').toBeGreaterThan(importIdx);
    expect(callIdx, 'startDashboard() must run before the boot-complete log').toBeLessThan(runningIdx);
  });
});

/**
 * The pusher's two read boundaries. Both are invisible to a behavior test on
 * the default composition — SQLite central DB, SQLite session mailboxes — so
 * they are asserted on the source: a regression here would keep every test
 * green locally and only fail on someone else's backend.
 */
describe('add-dashboard read boundaries in src/dashboard-pusher.ts', () => {
  it('never opens session storage directly — per-session reads go through the mailbox seam', () => {
    const imports = pusherImports();
    expect(imports, 'session messages must be read through the seam, not a better-sqlite3 handle').not.toContain(
      'better-sqlite3',
    );
    expect(imports, 'the pusher reads sessions via session-manager (withExistingMailboxSession)').toContain(
      './session-manager.js',
    );
    for (const literal of pusherLiterals()) {
      expect(literal, 'the mailbox owns its storage layout — no session DB file paths here').not.toMatch(
        /(in|out)bound\.db/,
      );
    }
  });

  it('keeps its central-DB queries dialect-agnostic', () => {
    // getDb() fronts a driver that is not necessarily SQLite (src/db/driver.ts).
    for (const literal of pusherLiterals()) {
      for (const construct of ['NULLS LAST', 'NULLS FIRST', "datetime('now')", 'strftime(']) {
        expect(literal, `${construct} is backend-specific; keep it out of getDb() queries`).not.toContain(construct);
      }
    }
  });
});
