/**
 * Wiring test for the host-side credential-injection integration point
 * (host/vitest tree).
 *
 * native-credential-proxy.test.ts behavior-tests nativeCredentialEnvArgs() in
 * isolation, but that does not prove buildContainerArgs actually uses it — a
 * direct unit test stays green even if the reach-in is deleted.
 * buildContainerArgs is entangled with the OneCLI gateway and not cheaply
 * invocable, so the integration is asserted structurally:
 *   1. inside buildContainerArgs there is an
 *      `args.push(...nativeCredentialEnvArgs())` call (the credential reach-in);
 *   2. the OneCLI gateway block (`onecli.applyContainerConfig(...)`) is wrapped
 *      in a `nativeCredentialsEnabled()` guard so it is skipped under the
 *      opt-out (the gateway skip).
 * Delete either and the corresponding assertion goes red. The second guards the
 * "Invalid API key" failure: threading the credential without skipping the
 * gateway leaves an HTTPS_PROXY that MITMs the API and overrides the credential.
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

/** Does this subtree contain a call to the named identifier (e.g. a method like `applyContainerConfig`)? */
function containsCallTo(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && callee.text === name) found = true;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === name) found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Is this an `if` whose condition calls `nativeCredentialsEnabled()` and whose
 * branches contain the OneCLI gateway apply? Matches both `if (!enabled()) {
 * apply }` and `if (enabled()) {} else { apply }` shapes.
 */
function isGatewaySkipGuard(node: ts.Node): boolean {
  if (!ts.isIfStatement(node)) return false;
  if (!containsCallTo(node.expression, 'nativeCredentialsEnabled')) return false;
  const inThen = containsCallTo(node.thenStatement, 'applyContainerConfig');
  const inElse = node.elseStatement ? containsCallTo(node.elseStatement, 'applyContainerConfig') : false;
  return inThen || inElse;
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

  it('guards the OneCLI gateway apply with nativeCredentialsEnabled()', () => {
    let guarded = false;
    const visit = (node: ts.Node) => {
      if (isGatewaySkipGuard(node)) guarded = true;
      if (!guarded) ts.forEachChild(node, visit);
    };
    if (fn?.body) visit(fn.body);
    expect(guarded).toBe(true);
  });
});
