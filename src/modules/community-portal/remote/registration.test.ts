/**
 * The module's registrations against the real composed tree: the sandbox
 * lifecycle hooks the address registration listens on, and the remote
 * verbs on `ncl sandboxes`.
 */
import { describe, expect, it } from 'vitest';

import { assertSandboxHook, assertSandboxVerb } from '../../../code-mode/contract.js';
import '../../../cli/resources/sandboxes.js';
import '../index.js';
import { REMOTE_ADDRESS_HOOK } from './index.js';

describe('community-portal registrations on code mode', () => {
  it('listens on sandbox creation and removal for the address', () => {
    expect(() => assertSandboxHook('created', REMOTE_ADDRESS_HOOK)).not.toThrow();
    expect(() => assertSandboxHook('removed', REMOTE_ADDRESS_HOOK)).not.toThrow();
  });

  it('extends ncl sandboxes with the remote verbs', () => {
    for (const verb of ['remote enable', 'remote disable', 'remote status', 'remote keys list'])
      expect(() => assertSandboxVerb(verb)).not.toThrow();
  });
});
