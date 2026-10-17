import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { execFileSync } from 'child_process';

import {
  cloneArgs,
  cloneRegistry,
  copyTemplate,
  ensureTemplateLocal,
  fetchTemplateIndex,
  listTemplatesFromDir,
  parseTemplateIndex,
  templateDescription,
  type ClonedRegistry,
} from './library.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-registry-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeTemplate(base: string, ref: string, manifest: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(base, ref), { recursive: true });
  fs.writeFileSync(
    path.join(base, ref, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: ref.split('/').pop(),
      ...manifest,
    }),
  );
}

/** A clone stand-in over a fixed source dir; records how often it ran. */
function fakeClone(source: string): { clone: () => Promise<ClonedRegistry>; calls: () => number } {
  let calls = 0;
  return {
    clone: async () => {
      calls++;
      const dir = fs.mkdtempSync(path.join(root, 'clone-'));
      fs.cpSync(source, dir, { recursive: true });
      return { dir, commit: 'c0ffee', cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
    calls: () => calls,
  };
}

describe('listTemplatesFromDir / copyTemplate', () => {
  it('finds nested templates by plugin.json, skipping dot folders, and copies one', () => {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(path.join(source, 'sales', 'sdr'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sales', 'sdr', 'plugin.json'), '{"name":"sdr"}');
    // A context/instructions.md INSIDE a plugin (the NanoClaw extension dir)
    // must not trip the legacy detection.
    fs.mkdirSync(path.join(source, 'sales', 'sdr', 'ai.nanoco.nanoclaw', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(source, 'sales', 'sdr', 'ai.nanoco.nanoclaw', 'context', 'instructions.md'),
      'Sell well.',
    );
    // A leftover fetch staging copy is never offered as a template.
    fs.mkdirSync(path.join(source, 'sales', '.sdr.fetch-abc123'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sales', '.sdr.fetch-abc123', 'plugin.json'), '{"name":"sdr"}');
    fs.mkdirSync(path.join(source, 'sales', '.sdr.fetch-abc123', 'ai.nanoco.nanoclaw', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(source, 'sales', '.sdr.fetch-abc123', 'ai.nanoco.nanoclaw', 'context', 'instructions.md'),
      'Leftover.',
    );

    expect(listTemplatesFromDir(source)).toEqual([{ ref: 'sales/sdr', name: 'sdr' }]);

    copyTemplate(source, 'sales/sdr', destination);
    expect(fs.readFileSync(path.join(destination, 'sales', 'sdr', 'plugin.json'), 'utf8')).toBe('{"name":"sdr"}');
    expect(() => copyTemplate(source, '../escape', destination)).toThrow('escapes the templates directory');
  });

  it('refuses to copy through a symlinked parent folder', () => {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(root, 'host', 'sdr'), { recursive: true });
    fs.writeFileSync(path.join(root, 'host', 'sdr', 'plugin.json'), '{"name":"sdr"}');
    fs.mkdirSync(source, { recursive: true });
    fs.symlinkSync(path.join(root, 'host'), path.join(source, 'sales'));

    expect(() => copyTemplate(source, 'sales/sdr', path.join(root, 'destination'))).toThrow(
      'leaves the template library',
    );
  });

  it('clones as data: symlinks as plain files, a fixed branch', () => {
    const args = cloneArgs('/tmp/x');
    expect(args.slice(0, 2)).toEqual(['-c', 'core.symlinks=false']);
    expect(args).toContain('--branch');
    expect(args.slice(-3)).toEqual(['--', 'https://github.com/nanocoai/nanoclaw-templates', '/tmp/x']);
  });

  it('runs git with symlinks off, no hooks and no LFS, and keeps git stderr out of the error', async () => {
    const bin = path.join(root, 'bin');
    const record = path.join(root, 'git-calls');
    fs.mkdirSync(bin);
    // A stand-in git: records each call, "clones" by making the target dir, answers rev-parse.
    fs.writeFileSync(
      path.join(bin, 'git'),
      [
        '#!/bin/sh',
        `printf '%s|LFS=%s\\n' "$*" "$GIT_LFS_SKIP_SMUDGE" >> '${record}'`,
        'case "$*" in *rev-parse*) echo c0ffee ;; *) mkdir -p "$(eval echo \\${$#})" ;; esac',
        'if [ -n "$FAIL_CLONE" ]; then echo "fatal: unable to access proxy.internal:3128" >&2; exit 128; fi',
      ].join('\n'),
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const clone = await cloneRegistry();
      clone.cleanup();
      const calls = fs.readFileSync(record, 'utf8').trim().split('\n');
      expect(calls[0]).toMatch(/^-c core\.symlinks=false -c core\.hooksPath=\/dev\/null clone .*\|LFS=1$/);
      expect(clone.commit).toBe('c0ffee');

      process.env.FAIL_CLONE = '1';
      const failure = await cloneRegistry().catch((err: Error) => err);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('Could not clone the template library');
    } finally {
      process.env.PATH = originalPath;
      delete process.env.FAIL_CLONE;
    }
  });

  it('keeps fetched templates out of git, but not the README', () => {
    const ignored = (p: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', p]);
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('templates/sales/sdr/plugin.json')).toBe(true);
    expect(ignored('templates/README.md')).toBe(false);
  });

  it('emits the migration error for a pre-plugin template layout', () => {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'sales', 'sdr', 'context'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sales', 'sdr', 'context', 'instructions.md'), 'Sell well.');

    expect(() => listTemplatesFromDir(source)).toThrow(/predate the plugin format.*sales\/sdr.*Re-fetch/s);
  });
});

describe('templateDescription', () => {
  it("reads the manifest's description, and is undefined without one", () => {
    const base = path.join(root, 'templates');
    writeTemplate(base, 'sales/sdr', { description: 'Books meetings' });
    writeTemplate(base, 'ops/bare');

    expect(templateDescription('sales/sdr', base)).toBe('Books meetings');
    expect(templateDescription('ops/bare', base)).toBeUndefined();
    expect(templateDescription('missing/one', base)).toBeUndefined();
  });

  it('does not read a manifest through a symlink', () => {
    const base = path.join(root, 'templates');
    writeTemplate(path.join(root, 'outside'), 'x/real', { description: 'Outside the templates dir' });
    fs.mkdirSync(path.join(base, 'sales', 'sdr'), { recursive: true });
    fs.symlinkSync(
      path.join(root, 'outside', 'x', 'real', 'plugin.json'),
      path.join(base, 'sales', 'sdr', 'plugin.json'),
    );

    expect(templateDescription('sales/sdr', base)).toBeUndefined();
  });
});

describe('ensureTemplateLocal', () => {
  it('fetches a template that is not local, without leaving staging behind', async () => {
    const library = path.join(root, 'library');
    const base = path.join(root, 'templates');
    writeTemplate(library, 'sales/sdr', { description: 'Books meetings' });
    const { clone, calls } = fakeClone(library);

    const result = await ensureTemplateLocal('sales/sdr', { base, clone });

    expect(result).toEqual({ dir: path.join(base, 'sales', 'sdr'), fetched: true, commit: 'c0ffee' });
    expect(templateDescription('sales/sdr', base)).toBe('Books meetings');
    expect(fs.readdirSync(path.join(base, 'sales'))).toEqual(['sdr']);
    expect(calls()).toBe(1);
  });

  it('uses the local copy and never fetches when one exists', async () => {
    const base = path.join(root, 'templates');
    writeTemplate(base, 'sales/sdr', { description: 'Edited locally' });
    const { clone, calls } = fakeClone(path.join(root, 'unused'));

    expect(await ensureTemplateLocal('sales/sdr', { base, clone })).toEqual({
      dir: path.join(base, 'sales', 'sdr'),
      fetched: false,
    });
    expect(templateDescription('sales/sdr', base)).toBe('Edited locally');
    expect(calls()).toBe(0);
  });

  it('rejects a ref the library does not have, and writes nothing', async () => {
    const library = path.join(root, 'library');
    const base = path.join(root, 'templates');
    writeTemplate(library, 'sales/sdr');
    const { clone } = fakeClone(library);

    await expect(ensureTemplateLocal('sales/nope', { base, clone })).rejects.toThrow(
      '"sales/nope" is not in the template library',
    );
    expect(fs.existsSync(path.join(base, 'sales', 'nope'))).toBe(false);
  });

  it('refuses a library template with a symlink, and writes nothing', async () => {
    const library = path.join(root, 'library');
    const base = path.join(root, 'templates');
    writeTemplate(library, 'sales/sdr');
    fs.symlinkSync('/etc/hosts', path.join(library, 'sales', 'sdr', 'hosts'));
    const { clone } = fakeClone(library);

    await expect(ensureTemplateLocal('sales/sdr', { base, clone })).rejects.toThrow('symlink');
    expect(fs.existsSync(path.join(base, 'sales', 'sdr'))).toBe(false);
  });

  it('refuses a library template that does not parse, and writes nothing', async () => {
    const library = path.join(root, 'library');
    const base = path.join(root, 'templates');
    fs.mkdirSync(path.join(library, 'sales', 'sdr'), { recursive: true });
    fs.writeFileSync(path.join(library, 'sales', 'sdr', 'plugin.json'), '{"name":"NOT VALID"}');
    const { clone } = fakeClone(library);

    await expect(ensureTemplateLocal('sales/sdr', { base, clone })).rejects.toThrow('plugin.json');
    expect(fs.readdirSync(path.join(base, 'sales'))).toEqual([]);
  });

  it('rejects a malformed ref before cloning', async () => {
    const { clone, calls } = fakeClone(path.join(root, 'unused'));

    await expect(ensureTemplateLocal('../etc', { base: root, clone })).rejects.toThrow('Invalid template ref');
    expect(calls()).toBe(0);
  });
});

describe('the library index', () => {
  const index = {
    schema: 1,
    categories: {
      sales: [{ ref: 'sales/sdr', name: 'sdr', version: '1.0.0', description: 'Books meetings' }],
      data: [
        { ref: 'data/analyst', name: 'analyst', version: '1.0.0', description: 'Checks pipelines' },
        { ref: '../escape', name: 'bad', version: '1.0.0', description: 'Dropped' },
        { ref: 'data/no-description', name: 'nodesc' },
        { ref: 'data/no-name' },
      ],
    },
  };

  it('flattens the categories by ref, drops malformed entries, keeps a missing description as empty', () => {
    expect(parseTemplateIndex(index)).toEqual([
      { ref: 'data/analyst', name: 'analyst', description: 'Checks pipelines' },
      { ref: 'data/no-description', name: 'nodesc', description: '' },
      { ref: 'sales/sdr', name: 'sdr', description: 'Books meetings' },
    ]);
  });

  it('refuses an index schema it does not know', () => {
    expect(() => parseTemplateIndex({ schema: 2, categories: {} })).toThrow(/update NanoClaw/);
  });

  it('fetches the index, and reports an HTTP failure plainly', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(index))) as unknown as typeof fetch;
    expect((await fetchTemplateIndex(ok)).map((t) => t.ref)).toEqual([
      'data/analyst',
      'data/no-description',
      'sales/sdr',
    ]);

    const notFound = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchTemplateIndex(notFound)).rejects.toThrow('HTTP 404');
  });
});
