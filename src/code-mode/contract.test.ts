import { describe, expect, it } from 'vitest';

import { assertSandboxVerb } from './contract.js';
import '../cli/resources/sandboxes.js';

describe('assertSandboxVerb', () => {
  it('sees the trunk sandbox verbs through the real resource', () => {
    for (const verb of ['new', 'list', 'attach']) expect(() => assertSandboxVerb(verb)).not.toThrow();
    expect(() => assertSandboxVerb('remote enable')).toThrow('ncl sandboxes remote enable is not registered');
  });
});
