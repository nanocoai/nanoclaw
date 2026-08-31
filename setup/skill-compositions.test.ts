import { describe, expect, it } from 'vitest';

import { getSkillCompanions, registerSkillCompanions } from './skill-compositions.js';

describe('skill composition registry', () => {
  it('stores ordered companions by full skill name without channel semantics', () => {
    registerSkillCompanions('add-sample-tool', [
      { skill: 'sample-runtime', branch: 'providers' },
      { skill: 'sample-helper' },
    ]);

    expect(getSkillCompanions('add-sample-tool')).toEqual([
      { skill: 'sample-runtime', branch: 'providers' },
      { skill: 'sample-helper' },
    ]);
  });
});
