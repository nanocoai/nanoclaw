/**
 * The device-code link comes from the sign-in provider's reply, so the opener
 * must hand it to a browser as one argument and never to a shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openInBrowser, printDeviceCard } from './registry-login.js';

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
    host.commands.add('xdg-open');
    openInBrowser(url);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still opens a valid link with & or %2F on macOS, where open gets it as one argument', () => {
    onPlatform('darwin');
    const url = 'https://auth.example.invalid/device?user_code=ABCD-EFGH&state=a%2Fb';
    openInBrowser(url);
    expect(spawn).toHaveBeenCalledWith('open', [url], expect.anything());
  });

  it.each(['file:///Applications/Calculator.app', 'http://auth.example.invalid/device', '-a Calculator', 'not a url'])(
    'opens nothing for a link that is not https: %s',
    (url) => {
      onPlatform('darwin');
      openInBrowser(url);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('still opens a valid link with & or %2F on Linux outside WSL, where xdg-open gets it as one argument', () => {
    onPlatform('linux');
    host.commands.add('xdg-open');
    const url = 'https://auth.example.invalid/device?user_code=ABCD-EFGH&state=a%2Fb';
    openInBrowser(url);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('xdg-open', [url], expect.anything());
  });

  it.each([
    [` ${PLAIN}`, PLAIN],
    [`\t${PLAIN}`, PLAIN],
    ['https://auth.example.invalid/dev\nice', 'https://auth.example.invalid/device'],
    ['https:auth.example.invalid', 'https://auth.example.invalid/'],
  ])('hands the opener the parsed link, not the raw text: %j', (raw, href) => {
    onPlatform('darwin');
    openInBrowser(raw);
    expect(spawn).toHaveBeenLastCalledWith('open', [href], expect.anything());
    onPlatform('linux');
    host.commands.add('xdg-open');
    openInBrowser(raw);
    expect(spawn).toHaveBeenLastCalledWith('xdg-open', [href], expect.anything());
  });

  it('checks the parsed link for shell characters on WSL, and opens that', () => {
    onPlatform('linux');
    host.wsl = true;
    host.commands.add('wslview');
    openInBrowser(` ${PLAIN}`);
    expect(spawn).toHaveBeenCalledWith('wslview', [PLAIN], expect.anything());
  });

  it('returns true once an opener is started', () => {
    onPlatform('darwin');
    expect(openInBrowser(PLAIN)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('returns false and starts nothing for a link that is not https', () => {
    onPlatform('darwin');
    expect(openInBrowser('http://auth.example.invalid/device')).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns false and starts nothing on WSL for a link with shell characters', () => {
    onPlatform('linux');
    host.wsl = true;
    host.commands.add('xdg-open');
    expect(openInBrowser('https://auth.example.invalid/device?user_code=ABCD&calc')).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns false when there is no opener to start', () => {
    onPlatform('linux');
    host.wsl = true;
    expect(openInBrowser(PLAIN)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns false when the opener cannot be started', () => {
    onPlatform('darwin');
    spawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    expect(openInBrowser(PLAIN)).toBe(false);
  });
});

describe('printDeviceCard', () => {
  const device = {
    deviceCode: 'device-code',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://auth.example.invalid/device',
    expiresInS: 300,
    expiresAt: new Date(0).toISOString(),
    intervalS: 5,
  };
  const OPENING = 'Your browser should open on its own';

  function card(headless: boolean, opened: boolean): string {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printDeviceCard(device, headless, opened);
    const text = String(log.mock.calls[0][0]);
    log.mockRestore();
    return text;
  }

  it('tells the user to open the link themselves when no browser was opened', () => {
    const text = card(false, false);
    expect(text).toContain("Couldn't open a browser here — open that link yourself.");
    expect(text).not.toContain(OPENING);
    expect(text).not.toContain('No browser on this machine');
  });

  it('says the browser should open only when one was started', () => {
    expect(card(false, true)).toContain(OPENING);
  });

  it('keeps the headless wording when the machine has no display', () => {
    expect(card(true, false)).toContain('No browser on this machine — open that link on your phone or laptop.');
  });
});
