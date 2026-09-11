import { describe, expect, it } from 'vitest';

import './index.js';
import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  getProviderHostContract,
  hasDeclaredProviderContract,
  listProviderHostContractNames,
  registerProviderHostContract,
  type ProviderHostContract,
} from './registry.js';

function emptyContract(): ProviderHostContract {
  return {
    seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
    projectDocument: {
      fileName: 'AGENTS.md',
      containerPath: '/workspace/agent/AGENTS.md',
      mountClass: 'group-state',
    },
    stateVolumes: [],
    skillBackings: [],
    skillViews: [],
    files: [],
    commands: { nativeAdmin: [], nativeFiltered: [] },
  };
}

const missing = Symbol('missing');

function cloneContract<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function claudeContractWith(path: string, value: unknown | typeof missing): ProviderHostContract {
  const contract = cloneContract(getProviderHostContract('claude')!);
  const parts = path.split('.');
  let target = contract as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const field = parts.at(-1)!;
  if (value === missing) delete target[field];
  else target[field] = value;
  return contract;
}

function contractName(field: string, suffix: string): string {
  return `invalid-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

/** Claude's contract plus one bind view of its skills backing, for view-field checks. */
function viewContract(): ProviderHostContract {
  const contract = cloneContract(getProviderHostContract('claude')!);
  contract.skillViews = [
    {
      backingId: 'claude-skills',
      containerPath: '/workspace/agent/.claude-skills',
      mode: 'ro',
      mountClass: 'group-state',
    },
  ];
  return contract;
}

function viewContractWith(path: string, value: unknown): ProviderHostContract {
  const contract = viewContract();
  const parts = path.split('.');
  let target = contract as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
  return contract;
}

describe('provider host contracts', () => {
  it('loads the complete Claude base declaration from the separate contract barrel', () => {
    const contract = getProviderHostContract('claude');

    expect(contract).toBeDefined();
    expect(contract?.projectDocument).toMatchObject({
      fileName: 'CLAUDE.md',
      containerPath: '/workspace/agent/CLAUDE.md',
    });
    expect(contract?.stateVolumes).toEqual([
      expect.objectContaining({ id: 'claude-home', directory: '.claude-shared', scope: 'group' }),
    ]);
    expect(contract?.skillBackings).toEqual([
      expect.objectContaining({ id: 'claude-skills', templateCopies: 'in-place' }),
    ]);
    expect(contract?.files).toEqual([
      expect.objectContaining({
        id: 'claude-settings',
        prepare: expect.objectContaining({ operation: 'create-if-missing', when: 'group-init' }),
        reconcile: { transformer: 'claude-settings' },
      }),
    ]);
    expect(contract?.legacyHostAdapter).toBeUndefined();
    expect(contract?.seamVersion).toBe(PROVIDER_HOST_CONTRACT_SEAM_VERSION);
    expect(contract?.commands?.nativeFiltered).toContain('/remote-control');
  });

  it('keeps installed contracts data-only', () => {
    for (const name of listProviderHostContractNames()) {
      const contract = getProviderHostContract(name)!;
      expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
    }
  });

  it('keeps provider lookup case-insensitive and unknown providers undeclared', () => {
    expect(hasDeclaredProviderContract('CLAUDE')).toBe(true);
    expect(hasDeclaredProviderContract('not-installed')).toBe(false);
    expect(listProviderHostContractNames()).toContain('claude');
  });

  it('rejects duplicate declarations at registration', () => {
    const name = `duplicate-contract-${process.pid}`;
    const empty = emptyContract();
    registerProviderHostContract(name, empty);
    expect(() => registerProviderHostContract(name, empty)).toThrow(/already registered/);
  });

  it('rejects a malformed contract at registration and stores nothing', () => {
    const name = contractName('malformed', 'container-path');
    const contract = claudeContractWith('projectDocument.containerPath', 'workspace/agent/CLAUDE.md');

    expect(() => registerProviderHostContract(name, contract)).toThrow(/canonical absolute container path/);
    expect(hasDeclaredProviderContract(name)).toBe(false);
    expect(listProviderHostContractNames()).not.toContain(name);
  });

  it('rejects mixed-version provider contracts with an operator fix', () => {
    const contract = emptyContract();
    contract.seamVersion = 0;
    expect(() => registerProviderHostContract(contractName('seam-version', 'old'), contract)).toThrow(
      /run \/update-skills/,
    );
  });

  it('freezes the stored contract so later mutation attempts throw', () => {
    const name = `immutable-contract-${process.pid}`;
    registerProviderHostContract(name, emptyContract());

    const stored = getProviderHostContract(name)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.commands!.nativeAdmin)).toBe(true);
    expect(() => (stored.commands!.nativeAdmin as string[]).push('/later')).toThrow();
  });

  describe('inference.speedTiers', () => {
    it('is declared by Claude as standard and fast', () => {
      expect(getProviderHostContract('claude')?.inference?.speedTiers).toEqual(['standard', 'fast']);
    });

    it('is optional — a provider that declares nothing has no tiers', () => {
      const name = contractName('inference', 'absent');
      registerProviderHostContract(name, emptyContract());
      expect(getProviderHostContract(name)?.inference).toBeUndefined();
    });

    it('accepts provider-specific tier names and freezes them', () => {
      const name = contractName('inference', 'custom');
      registerProviderHostContract(name, { ...emptyContract(), inference: { speedTiers: ['eco', 'turbo-plus'] } });
      const tiers = getProviderHostContract(name)!.inference!.speedTiers;
      expect(tiers).toEqual(['eco', 'turbo-plus']);
      expect(Object.isFrozen(tiers)).toBe(true);
    });

    it.each([
      ['an empty list', [], /inference\.speedTiers must not be empty/],
      ['a non-array', 'fast', /inference\.speedTiers must be an array/],
      ['an uppercase tier', ['standard', 'Fast'], /inference\.speedTiers\[\] must be lowercase kebab-case/],
      ['a spaced tier', ['very fast'], /inference\.speedTiers\[\] must be lowercase kebab-case/],
      ['an empty tier', [''], /inference\.speedTiers\[\] must be lowercase kebab-case/],
      ['a non-string tier', [1], /inference\.speedTiers\[\] must be lowercase kebab-case/],
      ['a duplicate tier', ['fast', 'fast'], /inference\.speedTiers must be unique; duplicate 'fast'/],
    ])('rejects %s at registration and stores nothing', (_label, speedTiers, expected) => {
      const name = contractName(`inference-${_label}`, 'invalid');
      expect(() => registerProviderHostContract(name, claudeContractWith('inference.speedTiers', speedTiers))).toThrow(
        expected,
      );
      expect(hasDeclaredProviderContract(name)).toBe(false);
    });
  });

  it('requires a project document', () => {
    expect(() =>
      registerProviderHostContract(
        contractName('project-document', 'missing'),
        claudeContractWith('projectDocument', missing),
      ),
    ).toThrow(/projectDocument is required/);
  });

  it.each([
    [
      'host path in override files',
      () => ({
        ...emptyContract(),
        projectDocument: {
          fileName: 'AGENTS.md',
          containerPath: '/workspace/agent/AGENTS.md',
          mountClass: 'group-state' as const,
          instructions: { nativeOverrideFiles: ['/tmp/AGENTS.local.md'] },
        },
      }),
      /one file or directory name/,
    ],
    [
      'duplicate volume identity',
      () => ({
        ...emptyContract(),
        stateVolumes: [
          {
            id: 'state',
            directory: '.one',
            containerPath: '/one',
            scope: 'group' as const,
            mode: 'rw' as const,
            mountClass: 'group-state' as const,
          },
          {
            id: 'state',
            directory: '.two',
            containerPath: '/two',
            scope: 'session' as const,
            mode: 'rw' as const,
            mountClass: 'allowlisted-extra' as const,
          },
        ],
      }),
      /must be unique/,
    ],
    [
      'missing backing volume',
      () => ({
        ...emptyContract(),
        skillBackings: [
          {
            id: 'skills',
            location: { kind: 'state-volume' as const, volumeId: 'missing', subdirectory: 'skills' },
            skillsSubdirectory: 'skills',
            conflictDiagnostics: 'silent' as const,
            templateCopies: 'in-place' as const,
          },
        ],
      }),
      /references unknown/,
    ],
  ])('rejects %s at registration', (_label, makeContract, expected) => {
    const name = `invalid-${_label.toLowerCase().replaceAll(' ', '-')}-${process.pid}`;
    expect(() => registerProviderHostContract(name, makeContract())).toThrow(expected);
  });

  it.each([
    ['baseDocumentFile', 'CLAUDE.md'],
    ['extraSections', [{ name: 'Extra', body: 'Provider prose.' }]],
  ])('rejects the removed project-document key %s with an operator fix', (key, value) => {
    expect(() =>
      registerProviderHostContract(
        contractName(`removed-${key}`, 'stale'),
        claudeContractWith(`projectDocument.${key}`, value),
      ),
    ).toThrow(
      `.projectDocument.${key} is no longer part of the host contract; instructions are core-owned (run /update-skills)`,
    );
  });

  it.each([
    ['non-object facts', 'projectDocument.instructions', 'invalid', /instructions must be an object/],
    ['null skills facts', 'projectDocument.instructions', { nativeSkills: null }, /nativeSkills must be an object/],
    [
      'empty override files',
      'projectDocument.instructions',
      { nativeOverrideFiles: [] },
      /nativeOverrideFiles must be a non-empty array/,
    ],
    [
      'relative skills discovery path',
      'projectDocument.instructions',
      {
        nativeSkills: {
          discoveryPath: 'skills',
          sharedSource: '/app/skills',
          selfAuthoredHome: '~/.codex/skills',
          persistentRoots: ['~/.codex'],
        },
      },
      /nativeSkills\.discoveryPath/,
    ],
    [
      'empty persistent roots',
      'projectDocument.instructions',
      {
        nativeSkills: {
          discoveryPath: '/workspace/agent/.agents/skills',
          sharedSource: '/app/skills',
          selfAuthoredHome: '~/.codex/skills',
          persistentRoots: [],
        },
      },
      /persistentRoots must be a non-empty array/,
    ],
  ])('rejects malformed project-document instruction facts: %s', (_label, field, value, expected) => {
    expect(() =>
      registerProviderHostContract(
        contractName(`instruction-facts-${_label}`, 'invalid'),
        claudeContractWith(field, value),
      ),
    ).toThrow(expected);
  });

  it.each(['stateVolumes', 'skillBackings', 'skillViews', 'files'])('requires top-level host array %s', (field) => {
    expect(() =>
      registerProviderHostContract(contractName(`array-${field}`, 'wrong'), claudeContractWith(field, {})),
    ).toThrow(`.${field} must be an array`);
    expect(() =>
      registerProviderHostContract(contractName(`array-${field}`, 'missing'), claudeContractWith(field, missing)),
    ).toThrow(`.${field} must be an array`);
  });

  it.each([
    ['projectDocument.mountClass', 'claude.projectDocument.mountClass'],
    ['stateVolumes.0.scope', 'claude.stateVolumes.claude-home.scope'],
    ['stateVolumes.0.mode', 'claude.stateVolumes.claude-home.mode'],
    ['stateVolumes.0.mountClass', 'claude.stateVolumes.claude-home.mountClass'],
    ['skillBackings.0.location.kind', 'claude.skillBackings.claude-skills.location.kind'],
    ['skillBackings.0.conflictDiagnostics', 'claude.skillBackings.claude-skills.conflictDiagnostics'],
    ['skillBackings.0.templateCopies', 'claude.skillBackings.claude-skills.templateCopies'],
    ['files.0.prepare.operation', 'claude.files.claude-settings.prepare.operation'],
    ['files.0.prepare.when', 'claude.files.claude-settings.prepare.when'],
    ['commands.nativeAdmin', 'claude.commands.nativeAdmin'],
    ['commands.nativeFiltered', 'claude.commands.nativeFiltered'],
    ['inference', 'claude.inference'],
    ['inference.speedTiers', 'claude.inference.speedTiers'],
  ])('rejects invalid %s at registration', (path, field) => {
    expect(() =>
      registerProviderHostContract(contractName(path, 'invalid'), claudeContractWith(path, 'invalid')),
    ).toThrow(field.slice('claude'.length));
  });

  it.each([['legacyHostAdapter', 'claude.legacyHostAdapter']])('rejects invalid %s at registration', (path, field) => {
    expect(() =>
      registerProviderHostContract(contractName(path, 'invalid'), claudeContractWith(path, 'invalid')),
    ).toThrow(field.slice('claude'.length));
  });

  it.each([
    ['skillViews.0.mode', '.skillViews.claude-skills.mode'],
    ['skillViews.0.mountClass', '.skillViews.claude-skills.mountClass'],
    ['skillViews.0.containerPath', '.skillViews.claude-skills.containerPath'],
  ])('rejects invalid %s at registration', (path, field) => {
    expect(() =>
      registerProviderHostContract(contractName(path, 'invalid'), viewContractWith(path, 'invalid')),
    ).toThrow(field);
  });

  it('rejects a skill view whose container path collides with a state volume', () => {
    expect(() =>
      registerProviderHostContract(
        contractName('view-destination', 'duplicate'),
        viewContractWith('skillViews.0.containerPath', '/home/node/.claude'),
      ),
    ).toThrow(/container destinations must be unique/);
  });

  // Registration checks the shape of the transformer name only; that a name
  // resolves to a registered implementation is `assertProviderHostConformance`,
  // because contract and transformer modules load in no guaranteed order.
  it('rejects malformed reconcile transformer names', () => {
    expect(() =>
      registerProviderHostContract(
        contractName('reconcile-transform', 'invalid'),
        claudeContractWith('files.0.reconcile.transformer', 'Not Kebab Case'),
      ),
    ).toThrow(/reconcile\.transformer must be lowercase kebab-case/);
  });

  it('accepts a well-formed transformer name core does not know', () => {
    const name = contractName('reconcile-transform', 'unregistered');
    registerProviderHostContract(
      name,
      claudeContractWith('files.0.reconcile.transformer', 'payload-owned-transformer'),
    );

    expect(getProviderHostContract(name)?.files[0].reconcile?.transformer).toBe('payload-owned-transformer');
  });

  it('rejects invalid prepared-file content and reconciliation', () => {
    expect(() =>
      registerProviderHostContract(
        contractName('prepare-content', 'missing'),
        claudeContractWith('files.0.prepare.content', missing),
      ),
    ).toThrow(/files\.claude-settings\.prepare\.content/);
    // A gateway-owned file has nothing to reconcile: that rule is about the
    // prepare variant, which is the only place ownership is stated now.
    const appendReconcile = claudeContractWith('files.0.prepare', {
      operation: 'append-open-close',
      when: 'every-spawn',
    });
    expect(() => registerProviderHostContract(contractName('append-reconcile', 'kept'), appendReconcile)).toThrow(
      /reconcile must be omitted for append-open-close/,
    );
  });

  it('reconciles a prepared file on the schedule its prepare variant fixes', () => {
    const contract = getProviderHostContract('claude')!;
    // The reconciliation used to carry its own `when`, validated to equal this
    // one. Deleting it cannot change the schedule.
    expect(contract.files[0].prepare.when).toBe('group-init');
    expect(contract.files[0].reconcile).toBeDefined();
  });

  // Both fields had exactly one legal value across every implementer, so the
  // behavior they named is now core's: shared links are always synced and
  // prepared files take the process default mode. A payload still declaring
  // them is stale, and is told so rather than silently ignored.
  it.each([
    ['skillBackings.0.sharedLinks', true, /sharedLinks is no longer declared.*run \/update-skills/],
    ['files.0.prepare.mode', 'process-default', /prepare\.mode is no longer declared.*run \/update-skills/],
    ['files.0.prepare.mode', 0o600, /prepare\.mode is no longer declared.*run \/update-skills/],
  ])('rejects the stale %s key with an operator fix', (path, value, expected) => {
    expect(() =>
      registerProviderHostContract(contractName(path, `stale-${String(value)}`), claudeContractWith(path, value)),
    ).toThrow(expected);
  });

  it('rejects group-init prepared files in session volumes', () => {
    const contract = claudeContractWith('stateVolumes', [
      ...cloneContract(getProviderHostContract('claude')!.stateVolumes),
      {
        id: 'session-state',
        directory: 'session-state',
        containerPath: '/session-state',
        scope: 'session',
        mode: 'rw',
        mountClass: 'allowlisted-extra',
      },
    ]);
    contract.files = [
      ...contract.files,
      {
        id: 'session-file',
        volumeId: 'session-state',
        relativePath: 'state.json',
        prepare: { operation: 'create-if-missing', when: 'group-init', content: '{}\n' },
      },
    ];
    expect(() => registerProviderHostContract(contractName('session-group-init-file', 'invalid'), contract)).toThrow(
      /prepare cannot initialize session volume 'session-state'/,
    );
  });

  it.each([
    [
      'container path alias',
      'stateVolumes.0.containerPath',
      '/home/node//.claude',
      /canonical absolute container path/,
    ],
    ['relative dot alias', 'files.0.relativePath', './settings.json', /canonical relative path/],
    ['relative parent alias', 'files.0.relativePath', 'config/../settings.json', /canonical relative path/],
    ['leading relative parent', 'files.0.relativePath', '../settings.json', /canonical relative path/],
    ['backing relative parent', 'skillBackings.0.location.subdirectory', '../skills', /canonical relative path/],
    ['skills relative parent', 'skillBackings.0.skillsSubdirectory', '../skills', /canonical relative path/],
    ['relative slash alias', 'files.0.relativePath', 'config//settings.json', /canonical relative path/],
  ])('rejects noncanonical %s', (_label, field, value, expected) => {
    expect(() =>
      registerProviderHostContract(contractName(`path-${_label}`, 'invalid'), claudeContractWith(field, value)),
    ).toThrow(expected);
  });
});
