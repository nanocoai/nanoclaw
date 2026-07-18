/**
 * The zip is written by our own in-process writer (no `zip` binary), so this
 * test parses the output with an independent minimal reader: EOCD → central
 * directory → local headers → stored data. If the writer emits a structure
 * Teams (or any unzip tool) would reject, these assertions go red.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTeamsAppPackage } from './teams-manifest.js';

const APP_ID = '11111111-2222-3333-4444-555555555555';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ParsedEntry {
  name: string;
  crc: number;
  data: Buffer;
}

/** Independent stored-entry zip reader — deliberately shares no code with the writer. */
function readZip(zip: Buffer): ParsedEntry[] {
  // No archive comment is written, so EOCD is exactly the last 22 bytes.
  const eocd = zip.subarray(zip.length - 22);
  expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
  const entryCount = eocd.readUInt16LE(10);
  let pos = eocd.readUInt32LE(16); // central directory offset

  const entries: ParsedEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    expect(zip.readUInt16LE(pos + 10)).toBe(0); // stored, no compression
    const crc = zip.readUInt32LE(pos + 16);
    const size = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('ascii');

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(zip.readUInt32LE(localOffset + 14)).toBe(crc);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({ name, crc, data: zip.subarray(dataStart, dataStart + size) });

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function build(outDir: string) {
  return buildTeamsAppPackage({
    appId: APP_ID,
    shortName: 'TestBot',
    longDescription: 'TestBot assistant for the manifest test.',
    websiteUrl: 'https://nanoclaw.example.test',
    outDir,
  });
}

describe('buildTeamsAppPackage', () => {
  // Built in beforeAll (not at describe-collection time) so a writer regression
  // fails the tests that own the assertions instead of erroring the whole suite.
  let outDir: string;
  let rscDir: string;
  let result: ReturnType<typeof build>;
  let zip: Buffer;
  let entries: ParsedEntry[];

  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-manifest-'));
    rscDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-manifest-rsc-'));
    result = build(outDir);
    zip = fs.readFileSync(result.zipPath);
    entries = readZip(zip);
  });

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(rscDir, { recursive: true, force: true });
  });

  it('packages exactly manifest.json + both icons, flat', () => {
    expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'outline.png', 'color.png']);
  });

  it('stores each entry byte-identical to the loose file, with a correct CRC', () => {
    const loose: Record<string, string> = {
      'manifest.json': result.manifestPath,
      'outline.png': result.outlinePath,
      'color.png': result.colorPath,
    };
    for (const entry of entries) {
      expect(entry.data.equals(fs.readFileSync(loose[entry.name]))).toBe(true);
      // zlib.crc32 is public API from Node 20.15 — cross-check when present.
      if (typeof zlib.crc32 === 'function') {
        expect(entry.crc).toBe(zlib.crc32(entry.data));
      }
    }
  });

  it('writes a valid manifest wired to the app id', () => {
    const manifest = JSON.parse(entries[0].data.toString('utf8'));
    expect(manifest.id).toBe(APP_ID);
    expect(manifest.bots[0].botId).toBe(APP_ID);
    expect(manifest.validDomains).toEqual(['nanoclaw.example.test']);
    expect(manifest.icons).toEqual({ outline: 'outline.png', color: 'color.png' });
  });

  it('leaves no template placeholder values in the rendered manifest', () => {
    const raw = entries[0].data.toString('utf8');
    expect(raw).not.toContain('00000000-0000-0000-0000-000000000000');
    expect(raw).not.toContain('nanoclaw.invalid');
  });

  it('emits real PNGs for both icons', () => {
    expect(entries[1].data.subarray(0, 8).equals(PNG_SIG)).toBe(true);
    expect(entries[2].data.subarray(0, 8).equals(PNG_SIG)).toBe(true);
  });

  it('is deterministic and idempotent across rebuilds', () => {
    const again = build(outDir);
    expect(fs.readFileSync(again.zipPath).equals(zip)).toBe(true);
  });

  it('adds RSC permissions and bumps the version when rsc is set', () => {
    const rscResult = buildTeamsAppPackage({
      appId: APP_ID,
      shortName: 'TestBot',
      longDescription: 'TestBot assistant for the manifest test.',
      websiteUrl: 'https://nanoclaw.example.test',
      outDir: rscDir,
      rsc: true,
    });
    const manifest = JSON.parse(fs.readFileSync(rscResult.manifestPath, 'utf8'));
    expect(manifest.version).toBe('1.1.0');
    expect(manifest.authorization.permissions.resourceSpecific).toEqual([
      { name: 'ChannelMessage.Read.Group', type: 'Application' },
      { name: 'ChatMessage.Read.Chat', type: 'Application' },
    ]);
    // RSC consent binds to webApplicationInfo.id — required alongside the block above.
    expect(manifest.webApplicationInfo).toEqual({ id: APP_ID, resource: 'https://notapplicable' });
  });
});
