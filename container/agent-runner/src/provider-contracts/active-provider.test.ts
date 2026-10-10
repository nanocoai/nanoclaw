import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, spyOn } from 'bun:test';

import type { MessageInRow } from '../db/messages-in.js';
import { categorizeMessage, isRunnerCommand } from '../formatter.js';
import { registerProvider } from '../providers/provider-registry.js';
import { uploadTrace } from '../upload-trace.js';
import { readProviderTrace } from './realize.js';
import { PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION, type ProviderRuntimeContract } from './registry.js';

// A session runs exactly one provider. The formatter's command lists and the
// /upload-trace lookup come from THAT provider's contract; a second registered
// contract (another installed payload) must never leak into a Claude session.

const OTHER = `other-native-${process.pid}`;
const OTHER_TRACE = `/nonexistent/${OTHER}/trace.jsonl`;

const otherContract: ProviderRuntimeContract = {
  seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  configuration: { executionPolicy: { constant: { boundary: 'container' } } },
  history: { readTrace: () => OTHER_TRACE },
  textDelivery: 'result',
  commands: { formatting: 'native', nativeAdmin: ['/other-admin'], nativeFiltered: ['/other-filtered'] },
};

registerProvider(OTHER, {
  create: () => ({
    registerMemorySessionHook: () => {},
    query: () => {
      throw new Error('unused');
    },
    isSessionInvalid: () => false,
  }),
  contract: otherContract,
});

function chat(text: string): MessageInRow {
  return {
    id: `m-${text}`,
    kind: 'chat',
    channel_type: 'discord',
    platform_id: 'chan-1',
    content: JSON.stringify({ sender: 'Alice', text }),
  } as unknown as MessageInRow;
}

describe('command lists come from the active provider only', () => {
  it('keeps the pre-contract lists for a provider with no contract', () => {
    // Before contracts existed the formatter hard-coded these for every
    // provider; a contractless payload must see exactly that, not nothing.
    const legacy = `no-contract-${process.pid}`;
    expect(categorizeMessage(chat('/compact'), legacy).category).toBe('admin');
    expect(categorizeMessage(chat('/context'), legacy).category).toBe('admin');
    expect(categorizeMessage(chat('/help'), legacy).category).toBe('filtered');
    expect(categorizeMessage(chat('/clear'), legacy).category).toBe('admin');
    expect(categorizeMessage(chat('/other-admin'), legacy).category).toBe('passthrough');
  });

  it("keeps Claude's own native commands for a Claude session", () => {
    expect(categorizeMessage(chat('/compact'), 'claude').category).toBe('admin');
    expect(categorizeMessage(chat('/help'), 'claude').category).toBe('filtered');
    expect(categorizeMessage(chat('/clear'), 'claude').category).toBe('admin');
    expect(categorizeMessage(chat('/upload-trace'), 'claude').category).toBe('admin');
  });

  it("does not pick up another registered contract's lists for a Claude session", () => {
    expect(categorizeMessage(chat('/other-admin'), 'claude').category).toBe('passthrough');
    expect(categorizeMessage(chat('/other-filtered'), 'claude').category).toBe('passthrough');
    // ...while the other provider's own session sees them.
    expect(categorizeMessage(chat('/other-admin'), OTHER).category).toBe('admin');
    expect(categorizeMessage(chat('/other-filtered'), OTHER).category).toBe('filtered');
    expect(categorizeMessage(chat('/compact'), OTHER).category).toBe('passthrough');
  });

  it('isRunnerCommand follows the same per-provider lists', () => {
    // Filtered commands are not runner commands; passthrough ones are.
    expect(isRunnerCommand(chat('/other-filtered'), OTHER)).toBe(false);
    expect(isRunnerCommand(chat('/other-filtered'), 'claude')).toBe(true);
  });
});

describe('/upload-trace reads the active provider trace only', () => {
  it("does not pick up another registered contract's trace for a Claude session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `active-provider-trace-${process.pid}-`));
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(root); // no Claude transcripts here
    try {
      expect(readProviderTrace(OTHER)).toBe(OTHER_TRACE);
      expect(readProviderTrace('claude')).toBeNull();
      expect(uploadTrace('claude')).toBe('No transcript to upload for this session yet.');
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
