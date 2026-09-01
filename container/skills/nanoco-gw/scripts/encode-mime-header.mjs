import { pathToFileURL } from 'node:url';

const MAX_CHUNK_BYTES = 45; // 60 base64 chars + RFC 2047 wrapper stays below 75 chars.

export function encodeMimeHeader(value) {
  if (/\r|\n/.test(value)) throw new Error('MIME header values cannot contain line breaks');
  if (/^[\x20-\x7e]*$/.test(value)) return value;

  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (chunk && bytes + size > MAX_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);

  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join('\r\n ');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let value = '';
    process.stdin.setEncoding('utf8');
    for await (const part of process.stdin) value += part;
    process.stdout.write(encodeMimeHeader(value));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
