/**
 * Wiring test for the Atomic Chat integration (host/vitest tree).
 *
 * This skill has no source reach-in to register its MCP server: the wiring is
 * the per-group entry in `container_configs.mcp_servers` that Phase 3 of
 * SKILL.md creates with `ncl groups config add-mcp-server`. So what has to be
 * guarded is the *contract* that entry depends on — three core facts and the
 * documented command that rides on them:
 *
 *   1. The registration payload SKILL.md documents is accepted by trunk's real
 *      `parseMcpServerConfig` (the ncl handler's parser) and survives
 *      `sanitizeStoredMcpServers` — the layer between the DB row and
 *      `container.json` — with its `env` intact. That env map is the only
 *      supported way to configure the server, so an entry that loses it is a
 *      dead integration.
 *   2. The agent-runner source really is mounted read-only at `/app/src`, which
 *      is what makes the documented `bun run /app/src/atomic-chat-mcp-stdio.ts`
 *      command resolve. Move that mount and every registered group breaks.
 *   3. The agent-runner really does merge `config.mcpServers` (i.e.
 *      container.json) into the provider's server map at boot. Drop that loop
 *      and the entry is stored but never reaches the agent.
 *
 * It also holds SKILL.md to the credential rule that made an earlier revision
 * of this skill destructive: no documented env value may be issuer-prefixed
 * credential material. That revision routed the token through the host's
 * container-env lane, where such a value is refused outright and denies every
 * spawn for the group — while documenting `ATOMIC_CHAT_API_KEY=sk-...` as the
 * example to copy. An MCP entry's env is NOT scanned, so the same paste is now
 * merely accepted and stored in the clear; this check is the only thing left
 * that objects, so it stays.
 *
 * The last check is applied state: the file the command points at exists in the
 * agent-runner tree. On a checkout where the skill has not been applied, that
 * one is expected to fail — it is the post-install verification.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

const ROOT = process.cwd();
const SKILL_MD = path.join(ROOT, '.claude', 'skills', 'add-atomic-chat-tool', 'SKILL.md');
const SERVER_FILE = 'atomic-chat-mcp-stdio.ts';

interface CoreConfigModule {
  parseMcpServerConfig: (input: Record<string, unknown>) => Record<string, unknown>;
  sanitizeStoredMcpServers: (raw: unknown, groupName: string) => Record<string, Record<string, unknown>>;
}
interface CoreDriverTypes {
  looksLikeCredential: (value: string) => boolean;
}

/** Import a core module by absolute path, so this file works from either the skill dir or src/. */
async function core<T>(relPath: string): Promise<T> {
  return (await import(pathToFileURL(path.join(ROOT, relPath)).href)) as T;
}

function sourceFile(relPath: string): ts.SourceFile {
  const p = path.join(ROOT, relPath);
  return ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
}

interface DocumentedRegistration {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The contents of every fenced code block in SKILL.md, continuations joined. */
function shellBlocks(): string[] {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const blocks: string[] = [];
  let open: string[] | undefined;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) {
      if (open) {
        blocks.push(open.join('\n'));
        open = undefined;
      } else {
        open = [];
      }
      continue;
    }
    open?.push(line);
  }
  return blocks.map((b) => b.replace(/\\\n\s*/g, ' '));
}

/**
 * Every `ncl groups config add-mcp-server` invocation SKILL.md documents, read
 * out of its fenced command blocks — prose mentions of the command are not
 * commands and must not be parsed as one.
 */
function documentedRegistrations(): DocumentedRegistration[] {
  const found: DocumentedRegistration[] = [];
  for (const line of shellBlocks().flatMap((b) => b.split('\n'))) {
    if (!line.includes('ncl groups config add-mcp-server')) continue;
    const flag = (name: string): string | undefined => {
      const m = new RegExp(`--${name}\\s+(?:'([^']*)'|"([^"]*)"|(\\S+))`).exec(line);
      return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    };
    const args = flag('args');
    const env = flag('env');
    found.push({
      name: flag('name') ?? '',
      command: flag('command') ?? '',
      args: args ? (JSON.parse(args) as string[]) : [],
      env: env ? (JSON.parse(env) as Record<string, string>) : {},
    });
  }
  return found;
}

describe('the registration SKILL.md documents', () => {
  const registrations = documentedRegistrations();

  it('documents at least one add-mcp-server command', () => {
    expect(registrations.length).toBeGreaterThan(0);
  });

  it('names the server atomic_chat and runs the copied server file', () => {
    for (const reg of registrations) {
      expect(reg.name).toBe('atomic_chat');
      expect(reg.command).toBe('bun');
      expect(reg.args).toEqual(['run', `/app/src/${SERVER_FILE}`]);
    }
  });

  it('is accepted by core parseMcpServerConfig as a stdio server, env preserved', async () => {
    const { parseMcpServerConfig } = await core<CoreConfigModule>('src/container-config.ts');
    for (const reg of registrations) {
      const parsed = parseMcpServerConfig({ command: reg.command, args: reg.args, env: reg.env });
      expect(parsed.command).toBe('bun');
      expect(parsed.args).toEqual(reg.args);
      expect(parsed.env).toEqual(reg.env);
      expect(parsed.type).toBeUndefined(); // stdio is the absence of a declared transport
    }
  });

  it('survives the stored-config sanitizer that gates container.json, env intact', async () => {
    const { sanitizeStoredMcpServers } = await core<CoreConfigModule>('src/container-config.ts');
    for (const reg of registrations) {
      const stored = { [reg.name]: { command: reg.command, args: reg.args, env: reg.env } };
      const sanitized = sanitizeStoredMcpServers(stored, 'wiring-test');
      expect(Object.keys(sanitized)).toEqual([reg.name]);
      expect(sanitized[reg.name].args).toEqual(reg.args);
      expect(sanitized[reg.name].env).toEqual(reg.env);
    }
  });

  it('documents no credential-shaped env value — such a value denies the spawn for the whole group', async () => {
    const { looksLikeCredential } = await core<CoreDriverTypes>('src/drivers/types.ts');
    const issuerPrefixed = /^(sk-|sk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA|eyJ)/;
    for (const reg of registrations) {
      for (const [key, value] of Object.entries(reg.env)) {
        expect(looksLikeCredential(value), `${key}=${value} is credential-shaped`).toBe(false);
        expect(issuerPrefixed.test(value), `${key}=${value} uses an issuer prefix`).toBe(false);
      }
    }
  });
});

describe('the core contracts the registration rides on', () => {
  it('mounts the agent-runner source read-only at /app/src', () => {
    const sf = sourceFile('src/container-runner.ts');

    // `const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src')`
    let srcVar: string | undefined;
    const findVar = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        /'agent-runner',\s*'src'/.test(node.initializer.getText(sf))
      ) {
        srcVar = node.name.text;
      }
      if (!srcVar) ts.forEachChild(node, findVar);
    };
    findVar(sf);
    expect(srcVar, "no variable holds path.join(..., 'agent-runner', 'src')").toBeDefined();

    // …pushed as a readonly mount whose containerPath is /app/src.
    let mount: ts.ObjectLiteralExpression | undefined;
    const findMount = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (name: string) =>
          node.properties.find(
            (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === name,
          );
        const hostPath = prop('hostPath');
        const containerPath = prop('containerPath');
        if (
          hostPath?.initializer.getText(sf) === srcVar &&
          containerPath &&
          ts.isStringLiteral(containerPath.initializer) &&
          containerPath.initializer.text === '/app/src'
        ) {
          mount = node;
        }
      }
      if (!mount) ts.forEachChild(node, findMount);
    };
    findMount(sf);
    expect(mount, 'agent-runner source is not mounted at /app/src').toBeDefined();
    const readonlyProp = mount?.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'readonly',
    );
    expect(readonlyProp?.initializer.kind).toBe(ts.SyntaxKind.TrueKeyword);
  });

  it('merges container.json mcpServers into the provider server map at boot', () => {
    const sf = sourceFile('container/agent-runner/src/index.ts');
    let merged = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isForOfStatement(node) &&
        /config\.mcpServers/.test(node.expression.getText(sf)) &&
        /mcpServers\[[A-Za-z_$][\w$]*\]\s*=/.test(node.statement.getText(sf))
      ) {
        merged = true;
      }
      if (!merged) ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(merged, 'index.ts no longer merges config.mcpServers into the mcpServers map').toBe(true);
  });
});

describe('applied state', () => {
  it('has the MCP server copied into the agent-runner tree, where /app/src points', () => {
    expect(fs.existsSync(path.join(ROOT, 'container', 'agent-runner', 'src', SERVER_FILE))).toBe(true);
  });
});
