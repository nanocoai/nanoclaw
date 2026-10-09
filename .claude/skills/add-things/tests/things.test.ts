import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('things skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: things');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('THINGS_AUTH_TOKEN');
  });

  it('has all files declared in adds', () => {
    const skillMd = path.join(skillDir, 'add', 'container', 'skills', 'things', 'SKILL.md');
    expect(fs.existsSync(skillMd)).toBe(true);

    const content = fs.readFileSync(skillMd, 'utf-8');
    expect(content).toContain('things_list');
    expect(content).toContain('things_search');
    expect(content).toContain('things_add');
    expect(content).toContain('things_update');
    expect(content).toContain('things_delete');
  });

  it('has all files declared in modifies', () => {
    const ipcFile = path.join(skillDir, 'modify', 'src', 'ipc.ts');
    const mcpFile = path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts');

    expect(fs.existsSync(ipcFile)).toBe(true);
    expect(fs.existsSync(mcpFile)).toBe(true);
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(path.join(skillDir, 'modify', 'src', 'ipc.ts.intent.md')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts.intent.md'),
      ),
    ).toBe(true);
  });

  it('has setup documentation', () => {
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);

    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('ossianhempel/tap');
    expect(content).toContain('things3-cli');
    expect(content).toContain('THINGS_AUTH_TOKEN');
    expect(content).toContain('Phase 1');
    expect(content).toContain('Phase 2');
    expect(content).toContain('Phase 3');
    expect(content).toContain('Phase 4');
  });

  it('modified ipc.ts includes Things CLI integration', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'ipc.ts'),
      'utf-8',
    );

    // New imports
    expect(content).toContain('spawnSync');
    expect(content).toContain('readEnvFile');

    // Things binary constant
    expect(content).toContain('THINGS_BIN');
    expect(content).toContain('/opt/homebrew/bin/things');

    // Host-side handler
    expect(content).toContain('things-requests');
    expect(content).toContain('things-responses');
    expect(content).toContain('executeThingsCommand');
    expect(content).toContain('THINGS_AUTH_TOKEN');

    // Atomic write pattern
    expect(content).toContain('.tmp');
    expect(content).toContain('renameSync');
  });

  it('modified ipc.ts preserves all existing IPC functionality', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'ipc.ts'),
      'utf-8',
    );

    // Core IPC watcher functions
    expect(content).toContain('startIpcWatcher');
    expect(content).toContain('processTaskIpc');
    expect(content).toContain('IpcDeps');

    // Existing message handling
    expect(content).toContain('messages');
    expect(content).toContain('sendMessage');

    // Task types
    expect(content).toContain('schedule_task');
    expect(content).toContain('pause_task');
    expect(content).toContain('resume_task');
    expect(content).toContain('cancel_task');
    expect(content).toContain('register_group');
    expect(content).toContain('refresh_groups');
  });

  it('modified ipc-mcp-stdio.ts includes Things MCP tools', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
      'utf-8',
    );

    // Directory constants
    expect(content).toContain('THINGS_REQUESTS_DIR');
    expect(content).toContain('THINGS_RESPONSES_DIR');
    expect(content).toContain('things-requests');
    expect(content).toContain('things-responses');

    // Shared helper
    expect(content).toContain('thingsRequest');

    // All five tools
    expect(content).toContain("'things_list'");
    expect(content).toContain("'things_search'");
    expect(content).toContain("'things_add'");
    expect(content).toContain("'things_update'");
    expect(content).toContain("'things_delete'");

    // Polling with timeout
    expect(content).toContain('10000');
    expect(content).toContain('200');
    expect(content).toContain('deadline');
  });

  it('modified ipc-mcp-stdio.ts preserves all existing MCP tools', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
      'utf-8',
    );

    // Existing tools preserved
    expect(content).toContain("'send_message'");
    expect(content).toContain("'schedule_task'");
    expect(content).toContain("'list_tasks'");
    expect(content).toContain("'pause_task'");
    expect(content).toContain("'resume_task'");
    expect(content).toContain("'cancel_task'");
    expect(content).toContain("'register_group'");

    // Core structure preserved
    expect(content).toContain('McpServer');
    expect(content).toContain('StdioServerTransport');
    expect(content).toContain('writeIpcFile');
    expect(content).toContain("IPC_DIR = '/workspace/ipc'");
    expect(content).toContain('server.connect(transport)');
  });

  it('things_list tool supports all required views', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
      'utf-8',
    );

    // View enum values
    expect(content).toContain("'today'");
    expect(content).toContain("'inbox'");
    expect(content).toContain("'upcoming'");
    expect(content).toContain("'anytime'");
    expect(content).toContain("'someday'");
    expect(content).toContain("'logbook'");
    expect(content).toContain("'projects'");
    expect(content).toContain("'areas'");
    expect(content).toContain("'tags'");

    // Filter options
    expect(content).toContain('project');
    expect(content).toContain('area');
    expect(content).toContain('tag');
    expect(content).toContain('limit');
    expect(content).toContain('--json');
  });

  it('things_update tool supports all update operations', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
      'utf-8',
    );

    // Update fields
    expect(content).toContain('append_notes');
    expect(content).toContain('add_tags');
    expect(content).toContain('completed');
    expect(content).toContain('canceled');
    expect(content).toContain('deadline');
    expect(content).toContain('--completed');
    expect(content).toContain('--canceled');
  });

  it('container skill SKILL.md has correct frontmatter', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'skills', 'things', 'SKILL.md'),
      'utf-8',
    );

    // YAML frontmatter with correct tool names
    expect(content).toContain('name: things');
    expect(content).toContain('mcp__nanoclaw__things_list');
    expect(content).toContain('mcp__nanoclaw__things_search');
    expect(content).toContain('mcp__nanoclaw__things_add');
    expect(content).toContain('mcp__nanoclaw__things_update');
    expect(content).toContain('mcp__nanoclaw__things_delete');
  });
});
