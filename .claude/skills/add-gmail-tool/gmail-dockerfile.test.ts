/**
 * Structural guard for the Gmail MCP package-install integration point (container image).
 *
 * `@gongrzhe/server-gmail-autoauth-mcp` is a CLI binary installed into the image via the
 * Dockerfile — it is not importable or typed from this tree, so the build leg can't catch
 * its removal and there's no runtime seam to behavior-test. This asserts the Dockerfile
 * still carries the ARG and the pinned pnpm global-install line. Drop either and this goes
 * red, signalling the agent would boot without the `gmail-mcp` binary on PATH.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';

function dockerfile(): string {
  // container/agent-runner/src/providers/ -> ../../../Dockerfile == container/Dockerfile
  const p = path.join(import.meta.dir, '..', '..', '..', 'Dockerfile');
  return fs.readFileSync(p, 'utf8');
}

describe('container/Dockerfile installs the Gmail MCP server', () => {
  const text = dockerfile();

  it('declares the GMAIL_MCP_VERSION ARG', () => {
    expect(/ARG\s+GMAIL_MCP_VERSION=/.test(text)).toBe(true);
  });

  it('pnpm-installs @gongrzhe/server-gmail-autoauth-mcp pinned to the ARG', () => {
    expect(text).toContain('pnpm install -g');
    expect(/@gongrzhe\/server-gmail-autoauth-mcp@\$\{GMAIL_MCP_VERSION\}/.test(text)).toBe(true);
  });

  it('pins the zod-to-json-schema workaround version', () => {
    expect(/zod-to-json-schema@3\.22\.5/.test(text)).toBe(true);
  });
});
