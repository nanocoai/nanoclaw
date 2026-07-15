/**
 * Guard for the dynamic MCP allow-pattern derivation this skill depends on.
 *
 * Registering `gmail` in a group's mcpServers map is the *only* wiring needed to expose
 * `mcp__gmail__*` to the agent — there is no static TOOL_ALLOWLIST edit. That holds solely
 * because `claude.ts` derives the allow-pattern from the registered servers at query time:
 *
 *     allowedTools: [ ...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern) ]
 *
 * `mcpAllowPattern` is not exported and the call site lives inside the SDK query options,
 * so the derivation is non-invocable from a test — we guard it structurally. Delete or
 * rename either half (the function or the spread into allowedTools) and this goes red,
 * surfacing that `gmail` tools would silently be filtered out despite being registered.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';
import ts from 'typescript';

function source(): { sf: ts.SourceFile; text: string } {
  const p = path.join(import.meta.dir, 'claude.ts');
  const text = fs.readFileSync(p, 'utf8');
  return { sf: ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true), text };
}

describe('claude.ts derives MCP allow-patterns from the registered servers', () => {
  const { sf, text } = source();

  it('defines an mcpAllowPattern function', () => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'mcpAllowPattern') found = true;
      if (!found) ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(found).toBe(true);
  });

  it('spreads Object.keys(this.mcpServers).map(mcpAllowPattern) into allowedTools', () => {
    // Normalize whitespace so formatting changes don't break the assertion.
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('Object.keys(this.mcpServers).map(mcpAllowPattern)');
  });
});
