import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Where the composer records the digest of the project document it wrote. */
const GOVERNED_DOC_RECORD = '.nanoco-governed-doc';

/**
 * Report a project document that changed since the composer last wrote it.
 *
 * The governed template is the source of truth for an agent's instructions,
 * and the composer rewrites the document from it on every wake — so drift
 * never survives a session boundary. What was missing is that a mid-session
 * edit was SILENT: the agent could rewrite its own standing instructions, run
 * a whole session on them, and nothing anywhere said so.
 *
 * Comparing against a recorded digest, rather than against the freshly
 * composed text, is what keeps this quiet: a legitimate recomposition (new
 * skills, changed config, edited persona) moves the composed text and is not
 * reported, while a document that no longer matches what the composer last
 * wrote is.
 *
 * Detection, not prevention: the record lives beside the document in the
 * group's own workspace, so an agent that means to cover its tracks can.
 * Preventing the edit needs a read-only mount at the provider's own document
 * path, which a Kata guest reads as empty — the constraint that produced this
 * design.
 */
function reportGovernedDocDrift(groupDir: string, fileName: string): void {
  const doc = path.join(groupDir, fileName);
  const record = path.join(groupDir, `${GOVERNED_DOC_RECORD}.sha256`);
  try {
    if (!fs.existsSync(doc) || !fs.existsSync(record)) return;
    const current = crypto.createHash('sha256').update(fs.readFileSync(doc)).digest('hex');
    const written = fs.readFileSync(record, 'utf8').trim();
    if (written && written !== current) {
      process.stderr.write(
        `governed project document drifted: ${fileName} is ${current.slice(0, 12)}, ` +
          `composer last wrote ${written.slice(0, 12)} — restoring from the template\n`,
      );
    }
  } catch {
    // Never fail a wake over an audit line.
  }
}

/** Record what the composer just wrote, so the next wake can detect an edit. */
function recordGovernedDoc(groupDir: string, fileName: string): void {
  try {
    const doc = path.join(groupDir, fileName);
    if (!fs.existsSync(doc)) return;
    const digest = crypto.createHash('sha256').update(fs.readFileSync(doc)).digest('hex');
    fs.writeFileSync(path.join(groupDir, `${GOVERNED_DOC_RECORD}.sha256`), `${digest}\n`, { mode: 0o600 });
  } catch {
    // Never fail a wake over an audit line.
  }
}

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
    reportGovernedDocDrift(groupDir, projectDocument.fileName);
    await composeGroupProjectDoc(group, groupDir, projectDocument);
    recordGovernedDoc(groupDir, projectDocument.fileName);
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
  const directory = '/heartbeat';
  const file = path.join(directory, '.heartbeat');
  // A tier that composes no heartbeat volume genuinely has nothing to seed.
  // That is the ONLY tolerated outcome: catching everything meant a real
  // failure looked identical to an absent volume, and one did. On nancy-v3
  // the agent's mount surfaced as
  //   drwxrwsrwt  /workspace/.heartbeat
  // because kubelet materialises a `subPath` it cannot find as a DIRECTORY —
  // so the file could never be written, `EISDIR` was swallowed, readiness
  // silently lost its sentinel, and nothing said a word for days.
  if (!fs.existsSync(directory)) {
    process.stderr.write('heartbeat seed skipped: no heartbeat volume composed\n');
    return;
  }
  fs.writeFileSync(file, `${Date.now()}`, { mode: 0o600 });
  fs.utimesSync(file, new Date(0), new Date(0));
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
