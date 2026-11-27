/**
 * scripts/lib/marketplace-source-validator.ts — schema validation for
 * `extraKnownMarketplaces` source variants.
 *
 * Mirrors the SDK's typed schema (eight variants). Used by
 * /add-marketplace and /install-plugin --source to reject malformed
 * source specs before they hit `container.json` (and from there, the
 * SDK at next spawn — where the failure mode is harder to diagnose).
 */
import type { ExtraKnownMarketplaceSource } from '../../src/container-config.js';

export type ValidationResult = { ok: true; source: ExtraKnownMarketplaceSource } | { ok: false; error: string };

const KNOWN_SOURCE_TYPES = new Set([
  'url',
  'github',
  'git',
  'npm',
  'file',
  'directory',
  'hostPattern',
  'pathPattern',
  'settings',
]);

/**
 * Validate an arbitrary value as an `ExtraKnownMarketplaceSource`. Returns
 * either a typed source or a human-readable error. Defensive against
 * non-object inputs and unknown source types.
 */
export function validateMarketplaceSource(input: unknown): ValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'source must be an object' };
  }
  const sourceType = input.source;
  if (typeof sourceType !== 'string') {
    return { ok: false, error: 'source.source must be a string' };
  }
  if (!KNOWN_SOURCE_TYPES.has(sourceType)) {
    return {
      ok: false,
      error: `unknown source type "${sourceType}"; expected one of: ${[...KNOWN_SOURCE_TYPES].join(', ')}`,
    };
  }

  switch (sourceType) {
    case 'url':
      if (typeof input.url !== 'string' || !input.url) {
        return { ok: false, error: 'url source: missing required `url` string' };
      }
      if (input.headers !== undefined && !isStringRecord(input.headers)) {
        return { ok: false, error: 'url source: `headers` must be Record<string, string>' };
      }
      return {
        ok: true,
        source: { source: 'url', url: input.url, headers: input.headers as Record<string, string> | undefined },
      };

    case 'github':
      if (typeof input.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(input.repo)) {
        return { ok: false, error: 'github source: `repo` must be in `owner/repo` format' };
      }
      return {
        ok: true,
        source: {
          source: 'github',
          repo: input.repo,
          ref: optionalString(input.ref),
          path: optionalString(input.path),
          sparsePaths: optionalStringArray(input.sparsePaths),
        },
      };

    case 'git':
      if (typeof input.url !== 'string' || !input.url) {
        return { ok: false, error: 'git source: missing required `url` string' };
      }
      return {
        ok: true,
        source: {
          source: 'git',
          url: input.url,
          ref: optionalString(input.ref),
          path: optionalString(input.path),
          sparsePaths: optionalStringArray(input.sparsePaths),
        },
      };

    case 'npm':
      if (typeof input.package !== 'string' || !input.package) {
        return { ok: false, error: 'npm source: missing required `package` string' };
      }
      return { ok: true, source: { source: 'npm', package: input.package } };

    case 'file':
      if (typeof input.path !== 'string' || !input.path) {
        return { ok: false, error: 'file source: missing required `path` string' };
      }
      return { ok: true, source: { source: 'file', path: input.path } };

    case 'directory':
      if (typeof input.path !== 'string' || !input.path) {
        return { ok: false, error: 'directory source: missing required `path` string' };
      }
      return { ok: true, source: { source: 'directory', path: input.path } };

    case 'hostPattern':
      if (typeof input.hostPattern !== 'string' || !input.hostPattern) {
        return { ok: false, error: 'hostPattern source: missing required `hostPattern` regex' };
      }
      return { ok: true, source: { source: 'hostPattern', hostPattern: input.hostPattern } };

    case 'pathPattern':
      if (typeof input.pathPattern !== 'string' || !input.pathPattern) {
        return { ok: false, error: 'pathPattern source: missing required `pathPattern` regex' };
      }
      return { ok: true, source: { source: 'pathPattern', pathPattern: input.pathPattern } };

    case 'settings':
      if (typeof input.name !== 'string' || !input.name) {
        return { ok: false, error: 'settings source: missing required `name` string' };
      }
      if (!Array.isArray(input.plugins)) {
        return { ok: false, error: 'settings source: `plugins` must be an array' };
      }
      return { ok: true, source: { source: 'settings', name: input.name, plugins: input.plugins } };
  }

  return { ok: false, error: `unhandled source type "${sourceType}"` };
}

/**
 * Convenience helper that throws on validation failure. Use in CLI
 * orchestrator scripts where we want the error to bubble up as a
 * non-zero exit with a clear message.
 */
export function parseMarketplaceSource(input: unknown): ExtraKnownMarketplaceSource {
  const result = validateMarketplaceSource(input);
  if (!result.ok) {
    throw new Error(`Invalid marketplace source: ${result.error}`);
  }
  return result.source;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every((value) => typeof value === 'string');
}

function optionalString(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error('expected string or undefined');
  return v;
}

function optionalStringArray(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
    throw new Error('expected string[] or undefined');
  }
  return v as string[];
}
