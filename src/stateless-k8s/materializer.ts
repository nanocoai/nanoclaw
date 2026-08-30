import fs from 'node:fs';
import path from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const groupId = required('NANOCO_COMPOSER_GROUP_ID');
  const sessionId = required('NANOCO_COMPOSER_SESSION_ID');
  const sourceRoot = required('NANOCO_COMPOSER_SOURCE_ROOT');
  const groupsRoot = required('NANOCLAW_GROUPS_DIR');
  const context = JSON.parse(Buffer.from(required('NANOCO_COMPOSER_CONTEXT_B64'), 'base64url').toString('utf8')) as unknown;
  const projectDocument = JSON.parse(
    Buffer.from(required('NANOCO_COMPOSER_PROJECT_DOC_B64'), 'base64url').toString('utf8'),
  ) as import('../providers/provider-container-registry.js').ProviderProjectDocument;
  const contribution = JSON.parse(
    Buffer.from(required('NANOCO_COMPOSER_PROVIDER_CONTRIBUTION_B64'), 'base64url').toString('utf8'),
  ) as import('../providers/provider-container-registry.js').ProviderContainerContribution;

  process.chdir(sourceRoot);
  const { CENTRAL_DB_PATH } = await import('../config.js');
  const connection = await import('../db/connection.js');
  await connection.initDb(CENTRAL_DB_PATH, { role: 'tool' });
  try {
    const { getAgentGroup } = await import('../db/agent-groups.js');
    const group = await getAgentGroup(groupId);
    if (!group) throw new Error(`agent group not found: ${groupId}`);

    fs.mkdirSync(groupsRoot, { recursive: true });
    const groupLink = path.join(groupsRoot, group.folder);
    if (!fs.lstatSync(groupLink, { throwIfNoEntry: false })) fs.symlinkSync('/workspace/agent', groupLink);

    const { materializeContainerJson } = await import('../container-config.js');
    const { composeGroupProjectDoc } = await import('../project-doc-compose.js');
    const { writeSessionContext } = await import('../session-manager.js');

    const config = await materializeContainerJson(groupId);
    const groupDir = path.join(groupsRoot, group.folder);
    for (const fixed of ['plugins', 'plugin-data']) fs.mkdirSync(path.join(groupDir, fixed), { recursive: true });
    await composeGroupProjectDoc(group, groupDir, projectDocument);
    materializeProviderState(contribution, config.skills, sourceRoot, groupDir);
    writeSessionContext(groupId, sessionId, context);
    seedHeartbeat();

    process.stdout.write(`${JSON.stringify({ materialized: { groupId, sessionId } })}\n`);
  } finally {
    await connection.closeDb();
  }
}

/**
 * Seed the agent's readiness heartbeat, absorbing what `heartbeat-init` used to
 * do as its own container. Placing a file before the agent starts IS
 * composition, and the composer already writes the agent's tree — a dedicated
 * container to run two shell builtins bought nothing.
 *
 * The two properties the probe depends on are preserved exactly: the CONTENT is
 * the container start time (liveness reads it as the spawn-time fallback), and
 * the MTIME is epoch 0 — the sentinel meaning "the agent has never beaten",
 * which is what readiness tests. Writing then back-dating, in that order,
 * matters: the write sets mtime to now.
 */
function seedHeartbeat(): void {
  const file = path.join('/heartbeat', '.heartbeat');
  try {
    fs.writeFileSync(file, `${Date.now()}`, { mode: 0o600 });
    fs.utimesSync(file, new Date(0), new Date(0));
  } catch (error) {
    // A tier that composes no heartbeat volume is not a materialization failure.
    process.stderr.write(`heartbeat seed skipped: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function materializeProviderState(
  contribution: import('../providers/provider-container-registry.js').ProviderContainerContribution,
  selected: string[] | 'all',
  sourceRoot: string,
  groupDir: string,
): void {
  const destination = (containerPath: string): string => {
    if (containerPath === '/workspace/agent') return groupDir;
    if (containerPath.startsWith('/workspace/agent/')) return path.join(groupDir, containerPath.slice('/workspace/agent/'.length));
    for (const state of contribution.stateVolumes ?? []) {
      if (containerPath === state.containerPath || containerPath.startsWith(`${state.containerPath}/`)) {
        return path.join('/materialized/provider-state', state.name, containerPath.slice(state.containerPath.length));
      }
    }
    if (path.posix.basename(containerPath) === '.agents') return path.join(groupDir, '.agents');
    throw new Error(`provider path has no declared volume: ${containerPath}`);
  };

  for (const seed of contribution.seedFiles ?? []) {
    if (seed.owner !== 'materializer') continue;
    const file = destination(seed.containerPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, seed.content, { mode: seed.mode ?? 0o600 });
  }

  const runtimeSkills = path.join(sourceRoot, 'container', 'skills');
  const selectedSkills = selected === 'all' ? fs.readdirSync(runtimeSkills).sort() : selected;
  const templateSkills = path.join(groupDir, '.claude-shared', 'skills');
  for (const view of contribution.skillViews ?? []) {
    const viewRoot = destination(view.containerPath);
    const skillsDir = path.posix.basename(view.containerPath) === 'skills' ? viewRoot : path.join(viewRoot, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    if (view.mode === 'rw' && fs.existsSync(templateSkills)) {
      for (const entry of fs.readdirSync(templateSkills)) {
        const source = path.join(templateSkills, entry);
        if (!fs.statSync(source).isDirectory()) continue;
        fs.cpSync(source, path.join(skillsDir, entry), { recursive: true, force: false });
      }
    }
    for (const skill of selectedSkills) {
      const link = path.join(skillsDir, skill);
      if (!fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(`/app/skills/${skill}`, link);
    }
  }
}

void main().catch((error) => {
  console.error(`session materializer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
