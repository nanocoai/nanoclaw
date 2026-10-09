import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-github-copilot-sdk skill package', () => {
  const skillDir = path.resolve(__dirname, '..');
  const projectRoot = path.resolve(skillDir, '..', '..', '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: add-github-copilot-sdk');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('GITHUB_TOKEN');
    expect(content).toContain('test:');
  });

  it('has all files declared in modifies', () => {
    const modifiedFiles = [
      'container/agent-runner/package.json',
      'container/Dockerfile',
      'container/agent-runner/src/index.ts',
      'src/container-runner.ts',
    ];

    for (const file of modifiedFiles) {
      const overlayPath = path.join(skillDir, 'modify', file);
      expect(fs.existsSync(overlayPath), `modify/${file} should exist`).toBe(true);
    }
  });

  it('has intent docs for all modified files', () => {
    const modifiedFiles = [
      'container/agent-runner/package.json',
      'container/Dockerfile',
      'container/agent-runner/src/index.ts',
      'src/container-runner.ts',
    ];

    for (const file of modifiedFiles) {
      const intentPath = path.join(skillDir, 'modify', `${file}.intent.md`);
      expect(fs.existsSync(intentPath), `modify/${file}.intent.md should exist`).toBe(true);

      const content = fs.readFileSync(intentPath, 'utf-8');
      expect(content).toContain('## What changed');
      expect(content).toContain('## Key sections');
      expect(content).toContain('## Invariants');
      expect(content).toContain('## Must-keep');
    }
  });

  it('does not use unsupported manifest fields', () => {
    const content = fs.readFileSync(path.join(skillDir, 'manifest.yaml'), 'utf-8');
    expect(content).not.toContain('npm_removed');
    expect(content).not.toContain('env_removed');
  });

  it('has a SKILL.md with technical preview warning', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('Technical Preview');
    expect(skillMd).toContain('copilot-sdk');
    expect(skillMd).toContain('Always refer to the cloned SDK repository');
  });

  it('has a SKILL.md with SDK API reference', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    // Key reference sections
    expect(skillMd).toContain('## SDK API Reference');
    expect(skillMd).toContain('### CopilotClient');
    expect(skillMd).toContain('### SessionConfig');
    expect(skillMd).toContain('### CopilotSession');
    expect(skillMd).toContain('### Tool Definition');
    expect(skillMd).toContain('### Session Events');
    expect(skillMd).toContain('### PreToolUse Hook');
  });

  it('has a SKILL.md with architecture notes and gotchas', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('## Architecture Notes');
    expect(skillMd).toContain('### Authentication Flow');
    expect(skillMd).toContain('### Token Isolation');
    expect(skillMd).toContain('### Session Persistence');
    expect(skillMd).toContain('### Gotchas');

    // Key gotchas that prevent real bugs
    expect(skillMd).toContain('Default timeout is 60s');
    expect(skillMd).toContain('Permissions default to deny');
    expect(skillMd).toContain('CLI inherits parent env by default');
    expect(skillMd).toContain('MCP servers require `tools` field');
    expect(skillMd).toContain('/proc/environ');
    expect(skillMd).toContain('permissionDecision');
  });

  it('has a SKILL.md with Claude SDK comparison and rollback', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    expect(skillMd).toContain('## Key Differences from Claude Agent SDK');
    expect(skillMd).toContain('## Rollback');
    expect(skillMd).toContain('git checkout');
  });
});

describe('add-github-copilot-sdk applied changes', () => {
  const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');

  describe('container/agent-runner/package.json', () => {
    const content = fs.readFileSync(
      path.join(projectRoot, 'container', 'agent-runner', 'package.json'),
      'utf-8',
    );

    it('has @github/copilot-sdk dependency', () => {
      expect(content).toContain('@github/copilot-sdk');
    });

    it('does not have claude-agent-sdk dependency', () => {
      expect(content).not.toContain('claude-agent-sdk');
      expect(content).not.toContain('@anthropic-ai');
    });
  });

  describe('container/Dockerfile', () => {
    const content = fs.readFileSync(
      path.join(projectRoot, 'container', 'Dockerfile'),
      'utf-8',
    );

    it('installs gh CLI', () => {
      expect(content).toContain('gh');
      expect(content).toContain('githubcli');
    });

    it('does not install claude-code', () => {
      expect(content).not.toContain('claude-code');
      expect(content).not.toContain('@anthropic-ai');
    });

    it('pipes stdin directly to Node (no temp file)', () => {
      expect(content).toContain('exec node');
      expect(content).not.toContain('cat > /tmp/input.json');
      expect(content).toContain('never written to disk');
    });

    it('references Copilot SDK in comments', () => {
      expect(content).toContain('Copilot SDK');
      expect(content).not.toContain('Claude Agent SDK');
    });
  });

  describe('container/agent-runner/src/index.ts', () => {
    const content = fs.readFileSync(
      path.join(projectRoot, 'container', 'agent-runner', 'src', 'index.ts'),
      'utf-8',
    );

    it('imports from @github/copilot-sdk', () => {
      expect(content).toContain("from '@github/copilot-sdk'");
    });

    it('does not import from claude-agent-sdk', () => {
      expect(content).not.toContain('claude-agent-sdk');
      expect(content).not.toContain('@anthropic-ai');
    });

    it('uses CopilotClient and CopilotSession', () => {
      expect(content).toContain('CopilotClient');
      expect(content).toContain('CopilotSession');
      expect(content).toContain('new CopilotClient');
    });

    it('passes githubToken to CopilotClient constructor', () => {
      expect(content).toContain('githubToken');
      expect(content).toContain('new CopilotClient({');
    });

    it('does not set secrets on process.env', () => {
      // Secrets should be extracted from containerInput.secrets, not set globally
      expect(content).not.toMatch(/process\.env\.(GITHUB_TOKEN|GH_TOKEN|COPILOT_SDK_AUTH_TOKEN)\s*=/);
    });

    it('does not write secrets to temp file', () => {
      // No reference to /tmp/input.json for writing (reading/blocking is OK)
      expect(content).not.toContain("fs.unlinkSync('/tmp/input.json')");
    });

    it('uses sendAndWait with adequate timeout', () => {
      expect(content).toContain('sendAndWait');
      expect(content).toContain('600_000');
    });

    it('uses approve-all for headless permission handling', () => {
      expect(content).toContain('onPermissionRequest');
      expect(content).toMatch(/kind.*approved/);
    });

    it('passes minimal env to CopilotClient', () => {
      expect(content).toContain('minimalEnv');
      expect(content).toContain("env: minimalEnv");
      // Only HOME, PATH, NODE_OPTIONS, LANG
      expect(content).toContain("HOME: '/home/node'");
    });

    it('scrubs secrets after client.start()', () => {
      expect(content).toContain('delete containerInput.secrets');
      expect(content).toContain('delete process.env.COPILOT_SDK_AUTH_TOKEN');
      expect(content).toContain('delete process.env.GITHUB_TOKEN');
      expect(content).toContain('delete process.env.GH_TOKEN');
    });

    it('has onPreToolUse hook for secret stripping', () => {
      expect(content).toContain('onPreToolUse');
      expect(content).toContain('COPILOT_SDK_AUTH_TOKEN');
      expect(content).toContain('unset');
    });

    it('blocks /proc/environ reads in Bash commands', () => {
      expect(content).toContain('/proc/');
      expect(content).toContain('environ');
      expect(content).toContain('permissionDecision');
    });

    it('blocks file reads of sensitive paths', () => {
      expect(content).toContain('SENSITIVE_PATH_PATTERNS');
      expect(content).toContain('ReadFile');
      expect(content).toContain('read_file');
    });

    it('computes secret env vars dynamically from secrets keys', () => {
      expect(content).toContain('ALWAYS_STRIP_VARS');
      expect(content).toContain('Object.keys(containerInput.secrets');
    });

    it('has onSessionEnd hook for crash-safe archiving', () => {
      expect(content).toContain('onSessionEnd');
      expect(content).toContain('archiveFn');
    });

    it('listens for compaction events', () => {
      expect(content).toContain('session.compaction_start');
    });

    it('uses configDir for session persistence', () => {
      expect(content).toContain("configDir: '/home/node/.copilot'");
    });

    it('discovers skillDirectories from /workspace/skills', () => {
      expect(content).toContain('skillDirectories');
      expect(content).toContain('/workspace/skills');
    });

    it('configures MCP server with tools wildcard', () => {
      expect(content).toContain("tools: ['*']");
    });

    it('uses systemMessage with append mode', () => {
      expect(content).toContain("mode: 'append'");
    });

    it('uses forceStop as fallback in error path', () => {
      expect(content).toContain('forceStop');
      expect(content).toContain('Promise.race');
    });

    it('logs errors from client.stop()', () => {
      expect(content).toContain('stopErrors');
      expect(content).toContain('Shutdown warning');
    });

    it('loads CLAUDE.md from extra directories', () => {
      expect(content).toContain('/workspace/extra');
      expect(content).toContain('extraClaudeMd');
    });

    it('archives conversation as markdown', () => {
      expect(content).toContain('archiveConversation');
      expect(content).toContain('/workspace/group/conversations');
    });

    it('uses session event type narrowing for archive', () => {
      expect(content).toContain("event.type === 'user.message'");
      expect(content).toContain("event.type === 'assistant.message'");
    });
  });

  describe('src/container-runner.ts', () => {
    const content = fs.readFileSync(
      path.join(projectRoot, 'src', 'container-runner.ts'),
      'utf-8',
    );

    it('mounts .copilot directory for session persistence', () => {
      expect(content).toContain('.copilot');
      expect(content).toContain("/home/node/.copilot'");
    });

    it('does not mount .claude directory', () => {
      expect(content).not.toContain("'/home/node/.claude'");
      expect(content).not.toContain("'.claude'");
    });

    it('does not write Claude settings.json', () => {
      expect(content).not.toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
      expect(content).not.toContain('CLAUDE_CODE_ADDITIONAL_DIRECTORIES');
      expect(content).not.toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
    });

    it('mounts skills directory as read-only', () => {
      expect(content).toContain("/workspace/skills'");
      expect(content).toContain('readonly: true');
    });

    it('reads GITHUB_TOKEN and GH_TOKEN secrets', () => {
      expect(content).toContain('GITHUB_TOKEN');
      expect(content).toContain('GH_TOKEN');
    });

    it('does not read Claude/Anthropic secrets', () => {
      expect(content).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(content).not.toContain('ANTHROPIC_API_KEY');
    });
  });

  describe('cross-file consistency', () => {
    it('configDir in index.ts matches mount path in container-runner.ts', () => {
      const indexTs = fs.readFileSync(
        path.join(projectRoot, 'container', 'agent-runner', 'src', 'index.ts'),
        'utf-8',
      );
      const runnerTs = fs.readFileSync(
        path.join(projectRoot, 'src', 'container-runner.ts'),
        'utf-8',
      );

      // Both must reference the same container path
      expect(indexTs).toContain('/home/node/.copilot');
      expect(runnerTs).toContain('/home/node/.copilot');
    });

    it('skills mount path matches discovery path', () => {
      const indexTs = fs.readFileSync(
        path.join(projectRoot, 'container', 'agent-runner', 'src', 'index.ts'),
        'utf-8',
      );
      const runnerTs = fs.readFileSync(
        path.join(projectRoot, 'src', 'container-runner.ts'),
        'utf-8',
      );

      // container-runner mounts to /workspace/skills, index.ts reads from /workspace/skills
      expect(runnerTs).toContain('/workspace/skills');
      expect(indexTs).toContain('/workspace/skills');
    });

    it('secret names in container-runner match index.ts extraction', () => {
      const indexTs = fs.readFileSync(
        path.join(projectRoot, 'container', 'agent-runner', 'src', 'index.ts'),
        'utf-8',
      );
      const runnerTs = fs.readFileSync(
        path.join(projectRoot, 'src', 'container-runner.ts'),
        'utf-8',
      );

      // container-runner reads these from .env
      expect(runnerTs).toContain('GITHUB_TOKEN');
      expect(runnerTs).toContain('GH_TOKEN');

      // index.ts extracts the same keys from the secrets dict
      expect(indexTs).toContain('secrets.GITHUB_TOKEN');
      expect(indexTs).toContain('secrets.GH_TOKEN');
    });
  });
});
