import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('webhook skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: webhook');
    expect(content).toContain('version: 1.0.0');
  });

  it('has all files declared in adds', () => {
    const addFile = path.join(skillDir, 'add', 'src', 'channels', 'webhook.ts');
    expect(fs.existsSync(addFile)).toBe(true);

    const content = fs.readFileSync(addFile, 'utf-8');
    expect(content).toContain('class WebhookChannel');
    expect(content).toContain('implements Channel');

    const testFile = path.join(skillDir, 'add', 'src', 'channels', 'webhook.test.ts');
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('WebhookChannel'");
  });

  it('has all files declared in modifies', () => {
    const indexFile = path.join(skillDir, 'modify', 'src', 'index.ts');
    const configFile = path.join(skillDir, 'modify', 'src', 'config.ts');
    const routingTestFile = path.join(skillDir, 'modify', 'src', 'routing.test.ts');

    expect(fs.existsSync(indexFile)).toBe(true);
    expect(fs.existsSync(configFile)).toBe(true);
    expect(fs.existsSync(routingTestFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain('WebhookChannel');
    expect(indexContent).toContain('WEBHOOK_PORT');
    expect(indexContent).toContain('WEBHOOK_ONLY');
    expect(indexContent).toContain('findChannel');
    expect(indexContent).toContain('channels: Channel[]');

    const configContent = fs.readFileSync(configFile, 'utf-8');
    expect(configContent).toContain('WEBHOOK_PORT');
    expect(configContent).toContain('WEBHOOK_HOST');
    expect(configContent).toContain('WEBHOOK_TOKEN');
    expect(configContent).toContain('WEBHOOK_CONNECTOR_URL');
    expect(configContent).toContain('WEBHOOK_ONLY');
  });

  it('has intent files for modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'index.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'config.ts.intent.md'))).toBe(true);
  });

  it('modified index.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    expect(content).toContain('function loadState()');
    expect(content).toContain('function saveState()');
    expect(content).toContain('function registerGroup(');
    expect(content).toContain('function getAvailableGroups()');
    expect(content).toContain('function processGroupMessages(');
    expect(content).toContain('function runAgent(');
    expect(content).toContain('function startMessageLoop()');
    expect(content).toContain('function recoverPendingMessages()');
    expect(content).toContain('function ensureContainerSystemRunning()');
    expect(content).toContain('async function main()');
    expect(content).toContain('_setRegisteredGroups');
    expect(content).toContain('isDirectRun');
  });

  it('modified index.ts includes webhook channel creation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    expect(content).toContain('const channels: Channel[] = []');
    expect(content).toContain('if (!WEBHOOK_ONLY)');
    expect(content).toContain('if (WEBHOOK_PORT)');
    expect(content).toContain('new WebhookChannel(');
  });

  it('modified config.ts preserves all existing exports', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'config.ts'),
      'utf-8',
    );

    expect(content).toContain('export const ASSISTANT_NAME');
    expect(content).toContain('export const POLL_INTERVAL');
    expect(content).toContain('export const TRIGGER_PATTERN');
    expect(content).toContain('export const CONTAINER_IMAGE');
    expect(content).toContain('export const DATA_DIR');
    expect(content).toContain('export const TIMEZONE');

    expect(content).toContain('export const WEBHOOK_PORT');
    expect(content).toContain('export const WEBHOOK_HOST');
    expect(content).toContain('export const WEBHOOK_TOKEN');
    expect(content).toContain('export const WEBHOOK_CONNECTOR_URL');
    expect(content).toContain('export const WEBHOOK_ONLY');
  });

  it('modified routing.test.ts includes webhook JID tests', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'routing.test.ts'),
      'utf-8',
    );

    expect(content).toContain('Webhook JID: starts with wh:');
    expect(content).toContain('wh:');
  });
});
