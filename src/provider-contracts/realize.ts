import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { materializeTemplateSkills } from '../group-skills.js';
import { log } from '../log.js';
import { writeAtomic } from '../migrate-claude-memory-settings.js';
import { BASE_INSTRUCTIONS_PATH, type ProjectDocSpec } from '../project-doc-compose.js';

import {
  describeRegisteredProviderFileTransformers,
  getProviderFileTransformer,
  type ProviderFileDiagnostic,
  type ProviderFileTransformer,
} from './file-transformers.js';
import {
  type ProviderFileTransformerId,
  type ProviderHostContract,
  type ProviderSkillBackingLocation,
  type ProviderStateVolume,
} from './registry.js';

/**
 * The host file a contract's project document is rendered from. Every
 * contract renders from core's canonical instruction template; a contract
 * declares facts for it, never a document of its own.
 */
export function providerDocumentSourcePath(projectRoot: string, contract: ProviderHostContract): string | undefined {
  if (contract.projectDocument === undefined) return undefined;
  return path.resolve(projectRoot, BASE_INSTRUCTIONS_PATH);
}

// Core-owned: the canonical instruction template is protected unconditionally;
// no provider contract switches this on or off.
export function protectedProviderDocumentSourcePaths(projectRoot: string): string[] {
  return [path.resolve(projectRoot, BASE_INSTRUCTIONS_PATH)];
}

export function providerProjectDocSpec(contract: ProviderHostContract): ProjectDocSpec | undefined {
  if (contract.projectDocument === undefined) return undefined;
  const { fileName, instructions, maxBytes } = contract.projectDocument;
  return {
    fileName,
    ...(instructions ? { instructions } : {}),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

export function providerStateVolumePath(
  volume: ProviderStateVolume,
  agentGroupId: string,
  sessionDirectory?: string,
): string {
  return resolveWithinRoot(providerStateVolumeRoot(volume, agentGroupId, sessionDirectory), volume.directory);
}

function providerStateVolumeRoot(volume: ProviderStateVolume, agentGroupId: string, sessionDirectory?: string): string {
  if (volume.scope === 'session') {
    if (!sessionDirectory) throw new Error(`Session directory required for provider state volume '${volume.id}'`);
    return path.resolve(sessionDirectory);
  }
  return path.resolve(DATA_DIR, 'v2-sessions', agentGroupId);
}

/** Realize the group-lifetime portion of a declared provider contract. */
export function initializeProviderGroupSurfaces(
  provider: string,
  contract: ProviderHostContract,
  agentGroupId: string,
  groupDir: string,
): string[] {
  const initialized: string[] = [];
  const volumes = new Map(contract.stateVolumes.map((volume) => [volume.id, volume]));

  for (const volume of contract.stateVolumes) {
    if (volume.scope !== 'group') continue;
    const hostPath = providerStateVolumePath(volume, agentGroupId);
    const existed = fs.existsSync(hostPath);
    ensureDirectoryWithinRoot(providerStateVolumeRoot(volume, agentGroupId), hostPath);
    if (!existed) initialized.push(volume.directory);
  }

  for (const file of contract.files) {
    if (file.prepare.when === 'group-init') initializeFile(provider, file, volumes, agentGroupId, initialized);
  }

  for (const backing of contract.skillBackings) {
    if (backing.location.kind === 'state-volume') {
      const volume = volumes.get(backing.location.volumeId);
      if (!volume) throw new Error(`Provider skill backing references unknown volume '${backing.location.volumeId}'`);
      if (volume.scope !== 'group') continue;
    }
    const skillsPath = providerSkillDirectory(backing, volumes, agentGroupId, groupDir);
    const existed = fs.existsSync(skillsPath);
    ensureDirectoryWithinRoot(
      skillBackingContainmentRoot(backing.location, volumes, agentGroupId, groupDir),
      skillsPath,
    );
    if (!existed) initialized.push(`${path.basename(skillsPath)}/`);
  }

  return initialized;
}

export interface ProviderSpawnRealization {
  skillBackingPaths: Map<string, string>;
  contribution: import('../providers/provider-container-registry.js').ProviderContainerContribution;
}

/** Realize every-spawn provider surfaces in the order derived from their resources. */
export async function realizeProviderSpawnSurfaces(
  _provider: string,
  contract: ProviderHostContract,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory: string,
  selectedSkills: readonly string[],
  actions: {
    legacyOverlay: () => Promise<import('../providers/provider-container-registry.js').ProviderContainerContribution>;
    composeProjectDocument: (spec: ProjectDocSpec) => Promise<void>;
  },
): Promise<ProviderSpawnRealization> {
  const volumes = new Map(contract.stateVolumes.map((volume) => [volume.id, volume]));
  const paths = new Map<string, string>();
  // A registered legacy adapter still contributes env exactly as before this
  // contract existed; only its mounts are dropped, since core now realizes
  // every declared surface. Nothing in the contract switches this on or off.
  const overlay = await actions.legacyOverlay();
  const contribution = overlay.env ? { env: overlay.env } : {};

  for (const volume of contract.stateVolumes) {
    const hostPath = providerStateVolumePath(volume, agentGroupId, sessionDirectory);
    ensureDirectoryWithinRoot(providerStateVolumeRoot(volume, agentGroupId, sessionDirectory), hostPath);
  }

  for (const file of contract.files) {
    if (file.prepare.when === 'every-spawn') prepareSpawnFile(file, volumes, agentGroupId, sessionDirectory);
  }

  for (const backing of contract.skillBackings) {
    const backingRoot = skillBackingPath(backing.location, volumes, agentGroupId, groupDir, sessionDirectory);
    const skillsPath = resolveWithinRoot(backingRoot, backing.skillsSubdirectory);
    paths.set(backing.id, backingRoot);
    ensureDirectoryWithinRoot(
      skillBackingContainmentRoot(backing.location, volumes, agentGroupId, groupDir, sessionDirectory),
      skillsPath,
    );
    syncSharedSkillLinks(skillsPath, selectedSkills, backing.conflictDiagnostics === 'warn');
    if (backing.templateCopies === 'copy') {
      materializeTemplateSkills(agentGroupId, skillsPath);
    }
  }

  const spec = providerProjectDocSpec(contract);
  if (spec) await actions.composeProjectDocument(spec);

  return { skillBackingPaths: paths, contribution };
}

function initializeFile(
  provider: string,
  file: ProviderHostContract['files'][number],
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  initialized: string[],
): void {
  const volume = volumes.get(file.volumeId);
  if (!volume) throw new Error(`Provider prepared file references unknown volume '${file.volumeId}'`);
  const volumePath = providerStateVolumePath(volume, agentGroupId);
  const filePath = resolveWithinRoot(volumePath, file.relativePath);
  if (!fs.existsSync(filePath)) {
    if (file.prepare.operation !== 'create-if-missing') return;
    fs.writeFileSync(filePath, file.prepare.content, { flag: 'wx' });
    initialized.push(file.relativePath);
    return;
  }
  // Reconciliation runs at the moment the file is prepared, so the prepare
  // variant is the only schedule there is.
  if (file.reconcile === undefined || file.prepare.when !== 'group-init') return;
  const transformerProvider = file.reconcile.transformerProvider ?? provider;
  const transformer = providerFileTransformer(file.reconcile.transformer);
  try {
    const result = transformer.transform(fs.readFileSync(filePath, 'utf-8'), filePath);
    emitDiagnostics(result.diagnostics);
    if (result.kind === 'replace') {
      writeAtomic(filePath, result.content);
      initialized.push(`${file.relativePath} (reconciled ${providerName(transformerProvider)} settings)`);
    }
  } catch (err) {
    emitDiagnostic(transformer.mapIoFailure(err, filePath));
  }
}

function providerFileTransformer(name: ProviderFileTransformerId): ProviderFileTransformer {
  const transformer = getProviderFileTransformer(name);
  if (transformer === undefined) {
    throw new Error(
      `Unknown provider file transformer '${name}'; registered transformers: ${describeRegisteredProviderFileTransformers()}`,
    );
  }
  return transformer;
}

function prepareSpawnFile(
  file: ProviderHostContract['files'][number],
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  sessionDirectory: string,
): void {
  const volume = volumes.get(file.volumeId);
  if (!volume) throw new Error(`Provider prepared file references unknown volume '${file.volumeId}'`);
  const volumePath = providerStateVolumePath(volume, agentGroupId, sessionDirectory);
  const filePath = resolveWithinRoot(volumePath, file.relativePath);
  if (file.prepare.operation === 'append-open-close') {
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
    fs.closeSync(fs.openSync(filePath, flags));
  }
}

function providerSkillDirectory(
  backing: ProviderHostContract['skillBackings'][number],
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
): string {
  return resolveWithinRoot(
    skillBackingPath(backing.location, volumes, agentGroupId, groupDir),
    backing.skillsSubdirectory,
  );
}

function skillBackingPath(
  location: ProviderSkillBackingLocation,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory?: string,
): string {
  if (location.kind === 'group-directory') {
    return resolveWithinRoot(groupDir, location.directory, location.subdirectory);
  }
  const volume = volumes.get(location.volumeId);
  if (!volume) throw new Error(`Provider skill backing references unknown volume '${location.volumeId}'`);
  return resolveWithinRoot(providerStateVolumePath(volume, agentGroupId, sessionDirectory), location.subdirectory);
}

function skillBackingContainmentRoot(
  location: ProviderSkillBackingLocation,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory?: string,
): string {
  if (location.kind === 'group-directory') return path.resolve(groupDir);
  const volume = volumes.get(location.volumeId);
  if (!volume) throw new Error(`Provider skill backing references unknown volume '${location.volumeId}'`);
  return providerStateVolumePath(volume, agentGroupId, sessionDirectory);
}

/**
 * Reconcile the shared-skill symlinks in one skills directory: drop links no
 * longer selected, add missing ones pointing at the container's /app/skills.
 * Also the body of the legacy Claude path (`syncSkillSymlinks` in
 * container-runner.ts), which wraps it with mkdir + skill-selection lookup.
 */
export function syncSharedSkillLinks(
  skillsDir: string,
  desiredSkills: readonly string[],
  warnOnConflict: boolean,
): void {
  const desired = new Set(desiredSkills);
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desired.has(entry)) fs.unlinkSync(entryPath);
  }

  for (const skill of desiredSkills) {
    const linkPath = path.join(skillsDir, skill);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(linkPath);
    } catch {
      /* missing */
    }
    if (!entry) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    } else if (!entry.isSymbolicLink() && warnOnConflict) {
      log.warn(
        'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        { skill, path: linkPath },
      );
    }
  }
}

function resolveWithinRoot(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Provider contract path escapes its resolved root: '${segments.join('/')}'`);
  }
  return resolved;
}

function ensureDirectoryWithinRoot(root: string, directory: string): void {
  // Lexical containment only: like the legacy path, symlinks placed by the
  // operator (relocated state, shared skills) are followed, not rejected.
  resolveWithinRoot(root, path.relative(path.resolve(root), path.resolve(directory)));
  fs.mkdirSync(directory, { recursive: true });
}

function emitDiagnostics(diagnostics: readonly ProviderFileDiagnostic[] | undefined): void {
  for (const diagnostic of diagnostics ?? []) emitDiagnostic(diagnostic);
}

function emitDiagnostic(diagnostic: ProviderFileDiagnostic): void {
  log[diagnostic.level](diagnostic.message, diagnostic.fields);
}

function providerName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
