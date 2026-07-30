/**
 * Wiring test for the host-side credential-injection integration point
 * (host/vitest tree).
 *
 * native-credential-proxy.test.ts behavior-tests nativeCredentialEnvArgs() in
 * isolation, but that does not prove buildContainerArgs actually uses it — a
 * direct unit test stays green even if the reach-in is deleted.
 * buildContainerArgs is entangled with the OneCLI gateway and not cheaply
 * invocable, so the integration is asserted structurally: inside
 * buildContainerArgs there is an `args.push(...nativeCredentialEnvArgs())`
 * call. Delete the reach-in and this goes red.
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

/** Is this node `args.push(...nativeCredentialEnvArgs())`? */
function isSpreadPushOfCredentialArgs(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== 'push' ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'args'
  ) {
    return false;
  }
  return node.arguments.some(
    (arg) =>
      ts.isSpreadElement(arg) &&
      ts.isCallExpression(arg.expression) &&
      ts.isIdentifier(arg.expression.expression) &&
      arg.expression.expression.text === 'nativeCredentialEnvArgs',
  );
}

describe('container-runner.ts wires in nativeCredentialEnvArgs', () => {
  const sf = sourceFile();
  const fn = findFunction(sf, 'buildContainerArgs');

  it('finds buildContainerArgs', () => {
    expect(fn).toBeDefined();
  });

  it('calls args.push(...nativeCredentialEnvArgs()) inside buildContainerArgs', () => {
    let wired = false;
    const visit = (node: ts.Node) => {
      if (isSpreadPushOfCredentialArgs(node)) wired = true;
      if (!wired) ts.forEachChild(node, visit);
    };
    if (fn?.body) visit(fn.body);
    expect(wired).toBe(true);
  });
});
