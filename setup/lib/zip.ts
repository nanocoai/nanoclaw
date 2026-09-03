/**
 * Minimal in-process ZIP writer — needs no external dep and no `zip` binary
 * on the host (minimal Linux images often lack one).
 *
 * Entries are stored uncompressed (method 0): callers package a few tiny
 * files, and stored entries keep the output trivially small and
 * byte-deterministic (fixed 1980-01-01 timestamp), which tests rely on.
 * ASCII entry names only; no zip64 — fine below 4 GB and 65k entries.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

// DOS-format date for 1980-01-01: bits 15–9 year-1980, 8–5 month, 4–0 day.
const ZIP_DOS_DATE = (1 << 5) | 1;

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'ascii');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(0, 8); // compression method: stored
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0, 10); // compression method: stored
    central.writeUInt16LE(ZIP_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // offset of local header
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end-of-central-directory signature
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset

  return Buffer.concat([...locals, centralDir, eocd]);
}

// Precompute the CRC-32 table per the ZIP spec. zlib.crc32 only became
// public API in Node 20.15/22.2, so we roll our own rather than gamble on
// the host's Node version.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
