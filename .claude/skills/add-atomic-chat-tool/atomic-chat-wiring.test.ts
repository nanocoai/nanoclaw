/**
 * Wiring test for the host-side env-forwarding integration point (host/vitest tree).
 *
 * The env helper is behavior-tested in isolation, but that does not prove
 * composeSessionSpec actually uses it — a direct unit test stays green even if
 * the reach-in is deleted. composeSessionSpec is entangled with the gateway
 * provider and not cheaply invocable here, so we assert the integration
 * structurally: inside composeSessionSpec there is a `...atomicChatEnv()`
 * spread. Delete the reach-in and this goes red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

function sourceFile(): ts.SourceFile {
  const p = path.resolve(process.cwd(), 'src/container-runner.ts');
  return ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
}

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Is this node a `...atomicChatEnv()` spread (object or array position)? */
function isEnvSpread(node: ts.Node): boolean {
  const spreadExpression = ts.isSpreadAssignment(node) || ts.isSpreadElement(node) ? node.expression : undefined;
  return (
    spreadExpression !== undefined &&
    ts.isCallExpression(spreadExpression) &&
    ts.isIdentifier(spreadExpression.expression) &&
    spreadExpression.expression.text === 'atomicChatEnv'
  );
}

describe('container-runner.ts wires in atomicChatEnv', () => {
  const sf = sourceFile();
  const fn = findFunction(sf, 'composeSessionSpec');

  it('finds composeSessionSpec', () => {
    expect(fn).toBeDefined();
  });

  it('spreads ...atomicChatEnv() inside composeSessionSpec', () => {
    let wired = false;
    const visit = (node: ts.Node) => {
      if (isEnvSpread(node)) wired = true;
      if (!wired) ts.forEachChild(node, visit);
    };
    if (fn?.body) visit(fn.body);
    expect(wired).toBe(true);
  });
});
