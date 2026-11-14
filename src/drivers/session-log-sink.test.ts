import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../log.js';

import { openSessionLog, registerSessionLogSink } from './session-log-sink.js';
import type { SessionKey } from './types.js';

const key: SessionKey = { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openSessionLog', () => {
  it('returns null when no sink is registered', () => {
    expect(openSessionLog(key, 'ncl-spike-s1')).toBeNull();
  });

  it('returns null once the only sink is unregistered', () => {
    const unregister = registerSessionLogSink(() => ({ write: vi.fn() }));
    unregister();
    expect(openSessionLog(key, 'ncl-spike-s1')).toBeNull();
  });

  it('returns null when every sink declines the session', () => {
    const unregister = registerSessionLogSink(() => undefined);
    try {
      expect(openSessionLog(key, 'ncl-spike-s1')).toBeNull();
    } finally {
      unregister();
    }
  });

  it('fans lines out to every sink and drops one that throws', () => {
    const good: string[] = [];
    const unregisterBad = registerSessionLogSink(() => ({
      write: () => {
        throw new Error('disk full');
      },
    }));
    const unregisterGood = registerSessionLogSink(() => ({ write: (line) => good.push(line) }));
    try {
      const writer = openSessionLog(key, 'ncl-spike-s1')!;
      writer.write('one');
      writer.write('two');
      writer.close();

      expect(good).toEqual(['one', 'two']);
      expect(log.warn).toHaveBeenCalledOnce();
    } finally {
      unregisterBad();
      unregisterGood();
    }
  });

  it('skips a sink whose factory throws', () => {
    const unregister = registerSessionLogSink(() => {
      throw new Error('cannot open');
    });
    try {
      expect(openSessionLog(key, 'ncl-spike-s1')).toBeNull();
      expect(log.warn).toHaveBeenCalledWith('Session log sink failed to open', expect.anything());
    } finally {
      unregister();
    }
  });
});
