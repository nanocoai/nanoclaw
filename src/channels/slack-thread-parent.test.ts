import { describe, it, expect, vi } from 'vitest';

import { channelFromPlatformId, tsFromThreadId, createThreadParentFetcher } from './slack-thread-parent.js';

describe('Slack thread-parent id parsers', () => {
  it('extracts channel id from a slack platform_id', () => {
    expect(channelFromPlatformId('slack:C02CJGH9T')).toBe('C02CJGH9T');
  });

  it('rejects non-Slack platform ids', () => {
    expect(channelFromPlatformId('telegram:123')).toBeNull();
    expect(channelFromPlatformId('slack:')).toBeNull();
    expect(channelFromPlatformId('')).toBeNull();
  });

  it('extracts the bare ts from a slack thread_id', () => {
    expect(tsFromThreadId('slack:C02CJGH9T:1778005926.008039', 'C02CJGH9T')).toBe('1778005926.008039');
  });

  it('rejects thread_ids that do not match the channel', () => {
    expect(tsFromThreadId('slack:C0OTHER:1778005926.008039', 'C02CJGH9T')).toBeNull();
    expect(tsFromThreadId('telegram:foo:bar', 'C02CJGH9T')).toBeNull();
    expect(tsFromThreadId('slack:C02CJGH9T:', 'C02CJGH9T')).toBeNull();
  });
});

describe('createThreadParentFetcher', () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  it('returns the parent message with bot_profile name resolved without extra calls', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        messages: [
          {
            ts: '1778005926.008039',
            bot_id: 'B123',
            bot_profile: { name: 'Andy' },
            text: 'Eter 3.0.1 is ready.',
          },
        ],
      }),
    );

    const fetchThreadParent = createThreadParentFetcher({ botToken: 'xoxb-test', fetch });
    const result = await fetchThreadParent('slack:C02CJGH9T', 'slack:C02CJGH9T:1778005926.008039');

    expect(result).toEqual({
      id: '1778005926.008039',
      sender: 'Andy',
      text: 'Eter 3.0.1 is ready.',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain('conversations.replies');
    expect(url).toContain('channel=C02CJGH9T');
    expect(url).toContain('ts=1778005926.008039');
  });

  it('resolves user display name via users.info when only `user` is present', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [{ ts: '1778005926.008039', user: 'U02CJGH91', text: 'hello' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          user: { real_name: 'Jacob Gorban', name: 'jacob', profile: { display_name: 'jacob' } },
        }),
      );

    const fetchThreadParent = createThreadParentFetcher({ botToken: 'xoxb-test', fetch });
    const result = await fetchThreadParent('slack:C02CJGH9T', 'slack:C02CJGH9T:1778005926.008039');

    expect(result).toEqual({
      id: '1778005926.008039',
      sender: 'jacob',
      text: 'hello',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain('users.info');
  });

  it('caches name resolutions across invocations', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [{ ts: '1.0', user: 'U1', text: 'first' }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, user: { real_name: 'Real Name' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [{ ts: '2.0', user: 'U1', text: 'second' }],
        }),
      );

    const fetchThreadParent = createThreadParentFetcher({ botToken: 'xoxb-test', fetch });
    await fetchThreadParent('slack:C0', 'slack:C0:1.0');
    await fetchThreadParent('slack:C0', 'slack:C0:2.0');

    // Two replies calls + one users.info call. Second invocation reuses the
    // cached name and skips users.info.
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('returns null when Slack reports an error', async () => {
    const warn = vi.fn();
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'channel_not_found' }));
    const fetchThreadParent = createThreadParentFetcher({ botToken: 'xoxb-test', fetch, log: warn });

    const result = await fetchThreadParent('slack:C02CJGH9T', 'slack:C02CJGH9T:1.0');
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when the parent ts does not match the requested ts (sanity guard)', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        // Slack returned a different message — reject rather than seed wrong context.
        messages: [{ ts: '9.9', user: 'U1', text: 'mismatched' }],
      }),
    );
    const fetchThreadParent = createThreadParentFetcher({ botToken: 'xoxb-test', fetch });
    const result = await fetchThreadParent('slack:C02CJGH9T', 'slack:C02CJGH9T:1.0');
    expect(result).toBeNull();
  });

  it('returns null when the parent has no text', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        messages: [{ ts: '1.0', user: 'U1', text: '' }],
      }),
    );
    const fetchThreadParent = createThreadParentFetcher({ botToken: 'xoxb-test', fetch });
    expect(await fetchThreadParent('slack:C0', 'slack:C0:1.0')).toBeNull();
  });

  it('returns null when ids are not Slack-shaped (cross-adapter safety)', async () => {
    const fetch = vi.fn();
    const fetchThreadParent = createThreadParentFetcher({ botToken: 'xoxb-test', fetch });

    expect(await fetchThreadParent('telegram:123', 'telegram:123:abc')).toBeNull();
    expect(await fetchThreadParent('slack:C0', 'slack:OTHER:1.0')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('truncates very long parent text', async () => {
    const longText = 'x'.repeat(10_000);
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        messages: [{ ts: '1.0', user: 'U1', text: longText, username: 'someone' }],
      }),
    );
    const fetchThreadParent = createThreadParentFetcher({ botToken: 'xoxb-test', fetch });
    const result = await fetchThreadParent('slack:C0', 'slack:C0:1.0');
    expect(result?.text.length).toBe(4000);
  });

  it('fails open when fetch throws', async () => {
    const warn = vi.fn();
    const fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const fetchThreadParent = createThreadParentFetcher({ botToken: 'xoxb-test', fetch, log: warn });

    expect(await fetchThreadParent('slack:C0', 'slack:C0:1.0')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
