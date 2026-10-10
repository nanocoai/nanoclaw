import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveWaWebVersion, type SwJsLookup, type WaWebVersion } from './whatsapp-auth-version.js';

const TRACKER_PAGE = '<h2>Current Version</h2><a>2.3000.1049101571-alpha</a><a>2.3000.1049075336-alpha</a>';
const SW_JS: WaWebVersion = [2, 3000, 1049110567];
const BUNDLED: WaWebVersion = [2, 3000, 1027934701];

function stubTracker(answer: Response | Error): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  );
}

const swJs = (result: Awaited<ReturnType<SwJsLookup>>) => vi.fn<SwJsLookup>(async () => result);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveWaWebVersion', () => {
  it("uses the tracker's current version without asking web.whatsapp.com", async () => {
    stubTracker(new Response(TRACKER_PAGE));
    const lookup = swJs({ version: SW_JS, isLatest: true });

    await expect(resolveWaWebVersion(lookup)).resolves.toEqual([2, 3000, 1049101571]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('falls back to sw.js when the tracker answers 429, even if the page names a version', async () => {
    stubTracker(new Response(TRACKER_PAGE, { status: 429 }));

    await expect(resolveWaWebVersion(swJs({ version: SW_JS, isLatest: true }))).resolves.toEqual(SW_JS);
  });

  it("fails instead of using Baileys' bundled version when both lookups fail", async () => {
    stubTracker(new TypeError('fetch failed'));
    // What Baileys resolves with when sw.js fails: no throw, just its stale default.
    const lookup = swJs({ version: BUNDLED, isLatest: false });

    await expect(resolveWaWebVersion(lookup)).rejects.toThrow('Could not fetch current WhatsApp Web version');
  });
});
