import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';

import { resolveApproverBindingStdin } from './approver-binding-stdin.js';

describe('NanoCo approver binding stdin transport', () => {
  it('moves a bounded binding document into the internal CLI frame', async () => {
    const args: Record<string, unknown> = { 'binding-stdin': true };
    await resolveApproverBindingStdin(
      'nanoco-approver-bindings-set',
      args,
      Readable.from(['{"issuer":"https://idp.example.com"}']),
    );
    expect(args).toEqual({ spec: '{"issuer":"https://idp.example.com"}' });
  });

  it('rejects another command, an empty body, or an oversized body', async () => {
    await expect(
      resolveApproverBindingStdin(
        'groups-create',
        { 'binding-stdin': true },
        Readable.from(['{}']),
      ),
    ).rejects.toThrow(/only valid/);
    await expect(
      resolveApproverBindingStdin(
        'nanoco-approver-bindings-set',
        { 'binding-stdin': true },
        Readable.from([]),
      ),
    ).rejects.toThrow(/empty/);
    await expect(
      resolveApproverBindingStdin(
        'nanoco-approver-bindings-set',
        { 'binding-stdin': true },
        Readable.from(['x'.repeat(4097)]),
      ),
    ).rejects.toThrow(/too large/);
  });
});
