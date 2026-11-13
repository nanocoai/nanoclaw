/**
 * The device-code link comes from the sign-in provider's reply, so the opener
 * must hand it to a browser as one argument and never to a shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deviceLogin, openInBrowser, printDeviceCard } from './registry-login.js';

const spawn = vi.hoisted(() => vi.fn(() => ({ pid: 4242 as number | undefined, on: vi.fn(), unref: vi.fn() })));
const host = vi.hoisted(() => ({ wsl: false, commands: new Set<string>() }));

vi.mock('child_process', () => ({ spawn }));
vi.mock('./platform.js', () => ({
  commandExists: (name: string) => host.commands.has(name),
  isHeadless: () => false,
  isWSL: () => host.wsl,
}));
// The device poll waits the provider's interval before each request.
vi.mock('timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('timers/promises')>()),
  setTimeout: async () => undefined,
}));

const OPENING = 'Your browser should open on its own';
const NOT_OPENED = "Couldn't open a browser here — open that link yourself.";

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

  // A missing or unrunnable opener makes spawn return a child with no pid.
  it('returns false when the opener fails to start without throwing', () => {
    onPlatform('darwin');
    spawn.mockImplementationOnce(() => ({ pid: undefined, on: vi.fn(), unref: vi.fn() }));
    expect(openInBrowser(PLAIN)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
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

  function card(headless: boolean, opened: boolean): string {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printDeviceCard(device, headless, opened);
    const text = String(log.mock.calls[0][0]);
    log.mockRestore();
    return text;
  }

  it('tells the user to open the link themselves when no browser was opened', () => {
    const text = card(false, false);
    expect(text).toContain(NOT_OPENED);
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

describe('deviceLogin', () => {
  const IDP = {
    clientId: 'client_test',
    deviceEndpoint: 'https://auth.example.invalid/device_authorization',
    tokenEndpoint: 'https://auth.example.invalid/token',
  };
  const LINK = 'https://auth.example.invalid/device?user_code=ABCD-EFGH';

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === IDP.deviceEndpoint
          ? reply(200, {
              device_code: 'device-code',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://auth.example.invalid/device',
              verification_uri_complete: LINK,
              expires_in: 300,
              interval: 5,
            })
          : reply(400, { error: 'access_denied' }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function reply(status: number, body: unknown) {
    return { status, text: async () => JSON.stringify(body) };
  }

  // The first poll is declined, so the login stops after the card and never
  // reaches clientRecord(), which writes a host id under the real HOME.
  async function cardFromLogin(): Promise<string> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(deviceLogin('https://registry.example.invalid', IDP)).rejects.toThrow('declined');
      return log.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      log.mockRestore();
    }
  }

  it('tells the card a browser should open when the opener starts', async () => {
    onPlatform('darwin');
    const text = await cardFromLogin();
    expect(spawn).toHaveBeenCalledWith('open', [LINK], expect.anything());
    expect(text).toContain(OPENING);
    expect(text).not.toContain(NOT_OPENED);
  });

  it('tells the card no browser opened when the opener fails to start', async () => {
    onPlatform('darwin');
    spawn.mockImplementationOnce(() => ({ pid: undefined, on: vi.fn(), unref: vi.fn() }));
    const text = await cardFromLogin();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(text).toContain(NOT_OPENED);
    expect(text).not.toContain(OPENING);
  });
});
