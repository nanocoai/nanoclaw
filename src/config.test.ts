/**
 * Unit tests for numeric env-var parsing in src/config.ts.
 *
 * CONTAINER_TIMEOUT, CONTAINER_MAX_OUTPUT_SIZE, and IDLE_TIMEOUT are parsed
 * with parseInt(), which returns NaN on non-numeric input (e.g. "30min", or a
 * blank-but-set value). When NaN reaches setTimeout() Node clamps it to 1ms,
 * which would kill every container the instant it started. The fix wraps each
 * with Math.max(1, parseInt(...) || DEFAULT) so the parsed value is always a
 * finite positive integer — matching the idiom already applied to
 * MAX_MESSAGES_PER_PROMPT and MAX_CONCURRENT_CONTAINERS in the same file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NUMERIC_ENV_VARS = [
  { name: 'CONTAINER_TIMEOUT', exportName: 'CONTAINER_TIMEOUT', defaultValue: 1800000 },
  { name: 'CONTAINER_MAX_OUTPUT_SIZE', exportName: 'CONTAINER_MAX_OUTPUT_SIZE', defaultValue: 10485760 },
  { name: 'IDLE_TIMEOUT', exportName: 'IDLE_TIMEOUT', defaultValue: 1800000 },
] as const;

async function loadConfig(): Promise<typeof import('./config.js')> {
  // Reset the module registry so the next `import('./config.js')` re-evaluates
  // the module body — which is where the parseInt(...) reads of process.env
  // happen. Vite's dynamic-import resolver rejects query-string busting, so
  // we go through vi.resetModules() instead.
  vi.resetModules();
  return await import('./config.js');
}

describe('numeric env var parsing (#1916)', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of NUMERIC_ENV_VARS) {
      originalEnv[v.name] = process.env[v.name];
      delete process.env[v.name];
    }
  });

  afterEach(() => {
    for (const v of NUMERIC_ENV_VARS) {
      if (originalEnv[v.name] === undefined) {
        delete process.env[v.name];
      } else {
        process.env[v.name] = originalEnv[v.name];
      }
    }
  });

  for (const v of NUMERIC_ENV_VARS) {
    describe(v.name, () => {
      it('uses the documented default when unset', async () => {
        const config = await loadConfig();
        expect(config[v.exportName]).toBe(v.defaultValue);
      });

      it('accepts a valid positive integer string', async () => {
        process.env[v.name] = '60000';
        const config = await loadConfig();
        expect(config[v.exportName]).toBe(60000);
      });

      it('falls back to the default on non-numeric input', async () => {
        process.env[v.name] = 'abc';
        const config = await loadConfig();
        expect(config[v.exportName]).toBe(v.defaultValue);
      });

      it('falls back to the default on blank-but-set value', async () => {
        process.env[v.name] = '';
        const config = await loadConfig();
        expect(config[v.exportName]).toBe(v.defaultValue);
      });

      it('clamps zero up to 1 (never returns a non-positive value)', async () => {
        process.env[v.name] = '0';
        const config = await loadConfig();
        expect(config[v.exportName]).toBe(v.defaultValue);
      });

      it('clamps negative input up to 1 (never returns a non-positive value)', async () => {
        process.env[v.name] = '-5';
        const config = await loadConfig();
        expect(config[v.exportName]).toBe(1);
      });

      it('returns a finite positive integer for every code path', async () => {
        for (const value of ['abc', '', '0', '-5', '60000', 'NaN', '1e3.5']) {
          process.env[v.name] = value;
          const config = await loadConfig();
          const result = config[v.exportName];
          expect(Number.isFinite(result)).toBe(true);
          expect(result).toBeGreaterThan(0);
        }
      });
    });
  }
});
