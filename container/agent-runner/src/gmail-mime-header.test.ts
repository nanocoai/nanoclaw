import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

import { encodeMimeHeader } from '../../skills/nanoco-gw/scripts/encode-mime-header.mjs';

const SCRIPT = path.join(import.meta.dir, '..', '..', 'skills', 'nanoco-gw', 'scripts', 'encode-mime-header.mjs');

function decode(value: string): string {
  return value
    .split('\r\n ')
    .map((word) => {
      const match = word.match(/^=\?UTF-8\?B\?(.+)\?=$/);
      return match ? Buffer.from(match[1]!, 'base64').toString('utf8') : word;
    })
    .join('');
}

describe('encodeMimeHeader', () => {
  it('round-trips international and folded header text', () => {
    for (const value of ['Header ñ — 😀', 'כותרת — שלום', 'Unicode ñ — '.repeat(20)]) {
      const encoded = encodeMimeHeader(value);
      expect(decode(encoded)).toBe(value);
      expect(encoded.split('\r\n ').every((line) => line.length <= 75)).toBe(true);
    }
  });

  it('can encode a display name without changing its address', () => {
    const displayText = 'Display ñ — 😀';
    const address = 'sender@example.com';
    const encodedName = encodeMimeHeader(displayText);

    expect(decode(encodedName)).toBe(displayText);
    expect(`From: ${encodedName} <${address}>`).toEndWith(`<${address}>`);
  });

  it('passes ASCII through and rejects header injection', () => {
    expect(encodeMimeHeader('Plain subject')).toBe('Plain subject');
    expect(() => encodeMimeHeader('Hello\r\nBcc: attacker@example.com')).toThrow('line breaks');
  });

  it('works as the stdin CLI used by the skill', () => {
    expect(execFileSync(process.execPath, [SCRIPT], { input: 'Header ñ — 😀', encoding: 'utf8' })).toContain(
      '=?UTF-8?B?',
    );
    expect(spawnSync(process.execPath, [SCRIPT], { input: 'bad\nheader' }).status).not.toBe(0);
  });
});
