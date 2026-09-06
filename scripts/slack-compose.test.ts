import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySkill, fullyApplied } from './skill-apply.js';
import { parseDirectives, validate } from './skill-directives.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'slack-compose-')); roots.push(root);
  mkdirSync(join(root, 'src/channels'), { recursive: true });
  writeFileSync(join(root, 'src/channels/index.ts'), '// channels\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  return root;
}
const skill = join(process.cwd(), '.claude/skills/add-slack');

describe('native Slack composition boundary', () => {
  it('composes the actual declared payload without asking, storing or resolving a Slack identity', async () => {
    const root = scratch();
    const commands: string[] = [];
    const result = await applySkill(skill, root, {
      inputs: { mode: 'compose' },
      resolveRemote: () => 'offline-payload',
      resolveInput: async () => { throw new Error('composition asked for runtime input'); },
      onEvent: async (event) => { if (event.type === 'operator') throw new Error('runtime operator effect'); },
      // External source/package/build executors are observed, never executed.
      // No stub answer is supplied for auth.test or conversations.open.
      exec: (command) => {
        if (/curl|slack\.com|auth\.test|conversations\.open|restart\.sh/.test(command)) {
          throw new Error('runtime/network effect during composition');
        }
        commands.push(command);
      },
    });
    expect(fullyApplied(result)).toBe(true);
    expect(result.vars).toEqual({ mode: 'compose' });
    expect(result.operatorMessages).toEqual([]);
    expect(result.journal.some((entry) => entry.op === 'set-env')).toBe(false);
    expect(existsSync(join(root, '.env'))).toBe(false);
    expect(readFileSync(join(root, 'src/channels/index.ts'), 'utf8')).toContain("import './slack.js';");
    expect(commands.some((command) => command.includes('src/channels/slack.ts'))).toBe(true);
    expect(commands).toContain('pnpm add @chat-adapter/slack@4.29.0');
    expect(commands).toContain('pnpm run build');
    expect(commands.some((command) => command.includes('vitest run'))).toBe(true);
  });

  it('omitted mode still enters installation and cannot complete without actual credential inputs', async () => {
    const requested: string[] = [];
    const result = await applySkill(skill, scratch(), {
      inputs: { connection: 'socket' }, resolveRemote: () => 'offline-payload',
      resolveInput: async (name) => { requested.push(name); return undefined; },
      exec: (command) => { if (/curl|slack\.com/.test(command)) throw new Error('missing credentials reached network'); },
    });
    expect(result.vars.mode).toBe('install');
    expect(requested).not.toContain('mode');
    expect(requested).toEqual(['bot_token', 'app_token', 'owner_handle']);
    expect(fullyApplied(result)).toBe(false);
    expect(result.journal.some((entry) => entry.op === 'set-env')).toBe(false);
  });
});

describe('authored prompt defaults', () => {
  async function apply(declaration: string, inputs: Record<string, string> = {}) {
    const root = scratch(); const dir = join(root, 'skill'); mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), `\`\`\`nc:prompt ${declaration}\nSelect a mode.\n\`\`\`\n`);
    return applySkill(dir, root, { inputs, resolveInput: async () => { throw new Error('unexpected question'); } });
  }
  it('normalizes and validates defaults just like explicit values', async () => {
    expect((await apply('mode default:INSTALL normalize:lower validate:^install$')).vars).toEqual({ mode: 'install' });
    expect(fullyApplied(await apply('mode default:invalid validate:^install$'))).toBe(false);
    expect(fullyApplied(await apply('mode default:install validate:^install$', { mode: 'invalid' }))).toBe(false);
  });
  it('refuses secret defaults in lint and actual application, even with an explicit input', async () => {
    const declaration = 'token secret default:forbidden-default';
    expect(validate(parseDirectives(`\`\`\`nc:prompt ${declaration}\nToken.\n\`\`\`\n`)).length).toBeGreaterThan(0);
    for (const inputs of [{}, { token: 'explicit-test-only-value' }]) {
      const result = await apply(declaration, inputs);
      expect(fullyApplied(result)).toBe(false);
      expect(JSON.stringify(result)).not.toContain('forbidden-default');
      expect(result.vars).toEqual({});
    }
  });
});
