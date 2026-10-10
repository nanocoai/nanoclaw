import { describe, expect, it } from 'vitest';

import { PROJECT_NOTE, projectRows } from './flow.js';
import { buildRemovalPlan } from './plan.js';
import type { Inventory } from './scan.js';

describe('uninstall data group disclosure', () => {
  const projects = {
    names: ['gw-abcd1234'],
    containers: ['gw-abcd1234-web-1', 'gw-abcd1234-database-1'],
    volumes: ['gw-abcd1234_database'],
    networks: ['gw-abcd1234'],
  };

  it('lists the service containers the data group removes when the service group is kept', () => {
    const inv: Inventory = {
      slug: 'abcd1234',
      projectRoot: '/proj',
      containerRuntime: 'docker',
      service: { containerIds: [] },
      data: [],
      runtime: [],
      user: [],
      projects,
      notes: [],
    };
    const actions = buildRemovalPlan(inv, { service: false, data: true, user: false });
    expect(actions.map((a) => a.kind)).toEqual(['rm-project-residue']);
    expect(projectRows(projects)).toEqual([
      { what: 'Service containers', where: 'gw-abcd1234-web-1, gw-abcd1234-database-1' },
      { what: 'Service data volumes', where: 'gw-abcd1234_database' },
      { what: 'Service networks', where: 'gw-abcd1234' },
    ]);
    expect(PROJECT_NOTE).toContain('even if you keep group 1');
  });
});
