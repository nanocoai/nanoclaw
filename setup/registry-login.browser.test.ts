/**
 * The device-code link comes from the sign-in provider's reply, so the opener
 * must hand it to a browser as one argument and never to a shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openInBrowser } from './registry-login.js';

const spawn = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })));
const host = vi.hoisted(() => ({ wsl: false, commands: new Set<string>() }));

vi.mock('child_process', () => ({ spawn }));
vi.mock('./platform.js', () => ({
  commandExists: (name: string) => host.commands.has(name),
  isHeadless: () => false,
  isWSL: () => host.wsl,
}));

const realPlatform = process.platform;
function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  spawn.mockClear();
  host.wsl = false;
  host.commands = new Set();
});

afterEach(() => {
  onPlatform(realPlatform);
});

describe('openInBrowser', () => {
  const PLAIN = 'https://auth.example.invalid/device?user_code=ABCD-EFGH';

  it('passes a plain https link to xdg-open as a single argument', () => {
    onPlatform('linux');
    host.commands.add('xdg-open');
    openInBrowser(PLAIN);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('xdg-open', [PLAIN], expect.anything());
  });

  it('passes a plain https link to wslview on WSL', () => {
    onPlatform('linux');
    host.wsl = true;
    host.commands.add('wslview');
    openInBrowser(PLAIN);
    expect(spawn).toHaveBeenCalledWith('wslview', [PLAIN], expect.anything());
  });

  it('opens nothing on WSL without xdg-open or wslview, instead of going through cmd.exe', () => {
    onPlatform('linux');
    host.wsl = true;
    openInBrowser(PLAIN);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    'https://auth.example.invalid/device?user_code=ABCD&calc',
    'https://auth.example.invalid/$(calc.exe)',
    'https://auth.example.invalid/`calc`',
    'https://auth.example.invalid/%PATH%',
    'https://auth.example.invalid/"|calc',
  ])('opens nothing on WSL for a link with shell characters: %s', (url) => {
    onPlatform('linux');
    host.wsl = true;
    host.commands.add('wslview');
    openInBrowser(url);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['file:///Applications/Calculator.app', 'http://auth.example.invalid/device', '-a Calculator', 'not a url'])(
    'opens nothing for a link that is not https: %s',
    (url) => {
      onPlatform('darwin');
      openInBrowser(url);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});
