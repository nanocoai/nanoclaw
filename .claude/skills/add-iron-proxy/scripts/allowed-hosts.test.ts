import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateAllowedHost } from '../payload/src/gateway-providers/iron-proxy-allowlist.js';
import { readAllowedHosts, statePaths } from './setup.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function projectWith(contents: string): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-allowlist-'));
  roots.push(root);
  const file = statePaths(root).allowedHosts;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return { root, file };
}

function readWithWarnings(entries: unknown): { hosts: string[]; warnings: string[]; file: string } {
  const { root, file } = projectWith(JSON.stringify(entries));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hosts = readAllowedHosts(root);
  return { hosts, warnings: warn.mock.calls.map(([message]) => String(message)), file };
}

describe('Iron Proxy allowed-hosts file', () => {
  it('keeps valid hosts when the file also holds a host:port entry', () => {
    const { hosts, warnings, file } = readWithWarnings(['api.example.com', 'host.docker.internal:11434']);
    expect(hosts).toEqual(['api.example.com']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
    expect(warnings[0]).toContain('"host.docker.internal:11434"');
    expect(warnings[0]).toContain('Iron only reaches HTTPS on 443; use the bare host name "host.docker.internal"');
  });

  it.each([
    ['https://api.example.com', 'host names, not URLs; use the bare host name "api.example.com"'],
    ['api.example.com/v1', 'cannot contain a path; use the bare host name "api.example.com"'],
    ['', 'the entry is empty'],
    ['   ', 'the entry is empty'],
  ])('skips %j with a fix', (entry, fix) => {
    const { hosts, warnings } = readWithWarnings([entry, 'api.example.com']);
    expect(hosts).toEqual(['api.example.com']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(fix);
  });

  it('skips non-string entries', () => {
    const { hosts, warnings } = readWithWarnings([42, 'api.example.com']);
    expect(hosts).toEqual(['api.example.com']);
    expect(warnings[0]).toContain('entries must be strings');
  });

  it('keeps wildcard hosts and folds duplicates without warning', () => {
    const { hosts, warnings } = readWithWarnings([
      '*.example.com',
      'API.example.com',
      ' api.example.com ',
      '*.example.com',
    ]);
    expect(hosts).toEqual(['*.example.com', 'api.example.com']);
    expect(warnings).toEqual([]);
  });

  it.each([['{"hosts":[]}'], ['"api.example.com"'], ['not json']])(
    'fails on a file that is not an array: %s',
    (contents) => {
      const { root, file } = projectWith(contents);
      expect(() => readAllowedHosts(root)).toThrow(
        `Iron Proxy allowed-hosts file must be a JSON array of host names: ${file}`,
      );
    },
  );

  it('returns nothing when the file does not exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-allowlist-'));
    roots.push(root);
    expect(readAllowedHosts(root)).toEqual([]);
  });
});

describe('adding an allowed host', () => {
  it('rejects an invalid host with the same fix', () => {
    expect(() => validateAllowedHost('host.docker.internal:11434')).toThrow(
      'Invalid allowed host "host.docker.internal:11434": Iron only reaches HTTPS on 443; use the bare host name "host.docker.internal"',
    );
    expect(() => validateAllowedHost('https://x.example.com/path')).toThrow('use the bare host name "x.example.com"');
    expect(() => validateAllowedHost('')).toThrow('the entry is empty');
  });

  it('normalizes a valid host and keeps wildcards', () => {
    expect(validateAllowedHost(' API.Example.com ')).toBe('api.example.com');
    expect(validateAllowedHost('*.example.com')).toBe('*.example.com');
  });
});
