/**
 * pr-factory-core guard — the mcp-tools barrel line.
 *
 * The handlers are behavior-tested in pr-factory-tools.test.ts, but that does
 * not prove the module is registered: delete the barrel import and the six
 * tools simply never appear, yet the handler test stays green. The barrel
 * (mcp-tools/index.ts) calls startMcpServer() at import, so it can't be
 * imported in a test — per the add-atomic-chat-tool precedent the
 * registration is asserted structurally: a side-effect ImportDeclaration of
 * './pr-factory.js' must exist BEFORE the startMcpServer() statement.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

function sourceFile(): ts.SourceFile {
  const p = path.join(import.meta.dir, 'index.ts');
  return ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
}

describe('mcp-tools barrel registers pr-factory', () => {
  const sf = sourceFile();

  const prFactoryImport = sf.statements.find(
    (s): s is ts.ImportDeclaration =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === './pr-factory.js',
  );

  it("has a side-effect import of './pr-factory.js' (no import clause)", () => {
    expect(prFactoryImport).toBeDefined();
    // Side-effect import: `import './pr-factory.js';` — a named/default import
    // would not run registerTools the same way the other tool modules do.
    expect(prFactoryImport!.importClause).toBeUndefined();
  });

  it('the import precedes the startMcpServer() call', () => {
    const startCall = sf.statements.find(
      (s) =>
        ts.isExpressionStatement(s) &&
        ts.isCallExpression(s.expression) &&
        s.expression.expression.getText(sf).startsWith('startMcpServer'),
    );
    expect(startCall).toBeDefined();
    expect(prFactoryImport!.getStart(sf)).toBeLessThan(startCall!.getStart(sf));
  });
});
