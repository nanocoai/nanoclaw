import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { hookPayload, resolveSource } from './cursor-hook.js';

describe('cursor-hook adapter', () => {
  it('maps --compact onto the compact memory source', () => {
    expect(resolveSource(['--compact'], '')).toBe('compact');
  });

  it('reads Cursor stdin source when present', () => {
    expect(resolveSource([], JSON.stringify({ source: 'clear' }))).toBe('clear');
    expect(resolveSource([], JSON.stringify({ source: 'resume' }))).toBe('resume');
  });

  it('treats sessionStart (no source field) as startup', () => {
    expect(resolveSource([], '{}')).toBe('startup');
    expect(resolveSource([], 'not-json')).toBe('startup');
  });

  it('omits additional_context on resume so Cursor does not re-inject memory', () => {
    expect(hookPayload('resume')).toEqual({});
  });

  it('renders the shared NanoClaw memory context on startup, clear, and compact', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-memory-hook-'));
    try {
      fs.mkdirSync(path.join(base, 'memory', 'system'), { recursive: true });
      fs.writeFileSync(path.join(base, 'memory', 'index.md'), '# Cursor memory sentinel\n');
      fs.writeFileSync(path.join(base, 'memory', 'system', 'definition.md'), '# Memory definition\n');

      for (const source of ['startup', 'clear', 'compact'] as const) {
        expect(hookPayload(source, base).additional_context).toContain('Cursor memory sentinel');
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
