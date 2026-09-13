import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

describe('add-mem0-graph skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid SKILL.md with frontmatter', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: add-mem0-graph');
  });

  it('has a valid manifest.yaml with required fields', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = yaml.parse(content);
    expect(manifest.skill).toBe('add-mem0-graph');
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
    expect(manifest.core_version).toBeDefined();
    expect(manifest.adds).toBeDefined();
    expect(Array.isArray(manifest.adds)).toBe(true);
    expect(manifest.modifies).toBeDefined();
    expect(Array.isArray(manifest.modifies)).toBe(true);
  });

  it('has all files listed in manifest.adds in add/ directory', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
    for (const addedFile of manifest.adds) {
      const filePath = path.join(skillDir, 'add', addedFile);
      expect(
        fs.existsSync(filePath),
        `add/${addedFile} should exist`,
      ).toBe(true);
    }
  });

  it('has all files listed in manifest.modifies in modify/ directory', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
    for (const modifiedFile of manifest.modifies) {
      const filePath = path.join(skillDir, 'modify', modifiedFile);
      expect(
        fs.existsSync(filePath),
        `modify/${modifiedFile} should exist`,
      ).toBe(true);
    }
  });

  it('has intent files for all modified files', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
    for (const modifiedFile of manifest.modifies) {
      const intentPath = path.join(
        skillDir,
        'modify',
        `${modifiedFile}.intent.md`,
      );
      expect(
        fs.existsSync(intentPath),
        `modify/${modifiedFile}.intent.md should exist`,
      ).toBe(true);
    }
  });

  it('add/src/mem0-memory.ts exports required functions', () => {
    const memoryPath = path.join(skillDir, 'add', 'src', 'mem0-memory.ts');
    expect(fs.existsSync(memoryPath)).toBe(true);
    const content = fs.readFileSync(memoryPath, 'utf-8');

    expect(content).toContain('export async function initMemory');
    expect(content).toContain('export async function retrieveMemoryContext');
    expect(content).toContain('export async function searchMemories');
    expect(content).toContain('export async function addMemory');
    expect(content).toContain('export async function updateMemory');
    expect(content).toContain('export async function removeMemory');
    expect(content).toContain('export async function captureConversation');
  });

  it('add/services/mem0-bridge/app.py exists and contains expected endpoints', () => {
    const appPath = path.join(
      skillDir,
      'add',
      'services',
      'mem0-bridge',
      'app.py',
    );
    expect(fs.existsSync(appPath)).toBe(true);
    const content = fs.readFileSync(appPath, 'utf-8');

    expect(content).toContain('/health');
    expect(content).toContain('/search');
    expect(content).toContain('/add');
    expect(content).toContain('/update');
    expect(content).toContain('/delete');
    expect(content).toContain('/graph_search');
    expect(content).toContain('/history');
  });

  it('modify/src/config.ts contains MEM0_BRIDGE_URL', () => {
    const configPath = path.join(skillDir, 'modify', 'src', 'config.ts');
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('MEM0_BRIDGE_URL');
  });

  it('modify/src/index.ts contains initMemory and retrieveMemoryContext', () => {
    const indexPath = path.join(skillDir, 'modify', 'src', 'index.ts');
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('initMemory');
    expect(content).toContain('retrieveMemoryContext');
  });

  it('modify/src/ipc.ts contains processMemoryIpc', () => {
    const ipcPath = path.join(skillDir, 'modify', 'src', 'ipc.ts');
    expect(fs.existsSync(ipcPath)).toBe(true);
    const content = fs.readFileSync(ipcPath, 'utf-8');
    expect(content).toContain('processMemoryIpc');
  });

  it('modify/src/container-runner.ts contains memory directory creation', () => {
    const runnerPath = path.join(
      skillDir,
      'modify',
      'src',
      'container-runner.ts',
    );
    expect(fs.existsSync(runnerPath)).toBe(true);
    const content = fs.readFileSync(runnerPath, 'utf-8');
    expect(content).toContain('memory');
  });

  it('modify/container/agent-runner/src/ipc-mcp-stdio.ts contains memory_save tool', () => {
    const mcpPath = path.join(
      skillDir,
      'modify',
      'container',
      'agent-runner',
      'src',
      'ipc-mcp-stdio.ts',
    );
    expect(fs.existsSync(mcpPath)).toBe(true);
    const content = fs.readFileSync(mcpPath, 'utf-8');
    expect(content).toContain('memory_save');
  });
});
