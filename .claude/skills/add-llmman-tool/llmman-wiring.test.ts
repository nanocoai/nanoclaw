/**
 * Wiring test for the host-side env-forwarding integration point (host/vitest tree).
 *
 * A direct unit test of the env helper stays green even if the reach-in is
 * deleted. composeSessionSpec is entangled with the gateway provider and not
 * cheaply invocable here, so we assert the integration structurally: inside
 * composeSessionSpec, the `contributedEnv` literal holds a `...llmmanEnv()`
 * spread. It must be that lane — `LLMMAN_API_KEY` is credential-NAMED, and the
 * composed `env` lane would deny the spawn. Delete or misplace the reach-in and
 * this goes red.
 *
 * The helper's own behavior (process env first, then the project `.env`, never
 * the plural `LLMMAN_API_KEYS`) is covered below against a real temp `.env`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, it, expect, vi } from 'vitest';
import ts from 'typescript';

import { llmmanEnv } from './llmman-env.js';

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

/** Is this node a `...llmmanEnv()` spread (object or array position)? */
function isEnvSpread(node: ts.Node): boolean {
  const spreadExpression = ts.isSpreadAssignment(node) || ts.isSpreadElement(node) ? node.expression : undefined;
  return (
    spreadExpression !== undefined &&
    ts.isCallExpression(spreadExpression) &&
    ts.isIdentifier(spreadExpression.expression) &&
    spreadExpression.expression.text === 'llmmanEnv'
  );
}

/** The initializer of `const <name> = ...` somewhere under `root`. */
function findInitializer(root: ts.Node, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node.initializer;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function containsEnvSpread(root: ts.Node): boolean {
  let wired = false;
  const visit = (node: ts.Node) => {
    if (isEnvSpread(node)) wired = true;
    if (!wired) ts.forEachChild(node, visit);
  };
  visit(root);
  return wired;
}

describe('container-runner.ts wires in llmmanEnv', () => {
  const sf = sourceFile();
  const fn = findFunction(sf, 'composeSessionSpec');

  it('finds composeSessionSpec', () => {
    expect(fn).toBeDefined();
  });

  it('spreads ...llmmanEnv() inside composeSessionSpec', () => {
    expect(fn?.body ? containsEnvSpread(fn.body) : false).toBe(true);
  });

  it('spreads it into the contributedEnv lane, where a credential-named key is allowed', () => {
    const literal = fn?.body ? findInitializer(fn.body, 'contributedEnv') : undefined;
    expect(literal).toBeDefined();
    expect(literal ? containsEnvSpread(literal) : false).toBe(true);
  });
});

describe('llmmanEnv()', () => {
  const roots: string[] = [];
  const project = (dotenv?: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmman-env-'));
    roots.push(root);
    if (dotenv !== undefined) fs.writeFileSync(path.join(root, '.env'), dotenv);
    return root;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('forwards nothing when nothing is set', () => {
    for (const key of ['LLMMAN_HOST', 'LLMMAN_API_KEY', 'LLMMAN_ADMIN_TOOLS']) vi.stubEnv(key, '');
    expect(llmmanEnv(project())).toEqual({});
  });

  it('reads the project .env, which the host never loads into process.env', () => {
    for (const key of ['LLMMAN_HOST', 'LLMMAN_API_KEY', 'LLMMAN_ADMIN_TOOLS']) vi.stubEnv(key, '');
    const root = project('LLMMAN_HOST=http://gpu-box:17434\nLLMMAN_API_KEY=abc123\nLLMMAN_ADMIN_TOOLS=true\n');
    expect(llmmanEnv(root)).toEqual({
      LLMMAN_HOST: 'http://gpu-box:17434',
      LLMMAN_API_KEY: 'abc123',
      LLMMAN_ADMIN_TOOLS: 'true',
    });
  });

  it('lets the host process environment win over .env', () => {
    vi.stubEnv('LLMMAN_HOST', '0.0.0.0:17434');
    vi.stubEnv('LLMMAN_API_KEY', '');
    vi.stubEnv('LLMMAN_ADMIN_TOOLS', '');
    expect(llmmanEnv(project('LLMMAN_HOST=other:1\n'))).toEqual({ LLMMAN_HOST: '0.0.0.0:17434' });
  });

  it("never forwards the daemon's plural LLMMAN_API_KEYS", () => {
    for (const key of ['LLMMAN_HOST', 'LLMMAN_API_KEY', 'LLMMAN_ADMIN_TOOLS']) vi.stubEnv(key, '');
    vi.stubEnv('LLMMAN_API_KEYS', 'k1,k2');
    expect(llmmanEnv(project('LLMMAN_API_KEYS=k3\n'))).toEqual({});
  });
});
