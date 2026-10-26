import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-image-sending skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: add-image-sending');
    expect(content).toContain('version: 1.0.0');
  });

  it('has all files declared in modifies', () => {
    const expected = [
      'modify/src/types.ts',
      'modify/src/channels/whatsapp.ts',
      'modify/src/channels/whatsapp.test.ts',
      'modify/src/ipc.ts',
      'modify/src/index.ts',
      'modify/container/agent-runner/src/ipc-mcp-stdio.ts',
    ];

    for (const rel of expected) {
      expect(fs.existsSync(path.join(skillDir, rel))).toBe(true);
    }
  });

  it('has intent files for all modified files', () => {
    const expected = [
      'modify/src/types.ts.intent.md',
      'modify/src/channels/whatsapp.ts.intent.md',
      'modify/src/channels/whatsapp.test.ts.intent.md',
      'modify/src/ipc.ts.intent.md',
      'modify/src/index.ts.intent.md',
      'modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md',
    ];

    for (const rel of expected) {
      expect(fs.existsSync(path.join(skillDir, rel))).toBe(true);
    }
  });

  it('modified types.ts adds sendImage to Channel interface', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/src/types.ts'),
      'utf-8',
    );

    expect(content).toContain('sendImage?');
    expect(content).toContain('jid: string, buffer: Buffer, caption?: string');
    // Core interface members preserved
    expect(content).toContain('sendMessage(jid: string, text: string)');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('setTyping?');
  });

  it('modified whatsapp.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/src/channels/whatsapp.ts'),
      'utf-8',
    );

    // Core class preserved
    expect(content).toContain('class WhatsAppChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('async disconnect()');
    expect(content).toContain('async setTyping(');
    expect(content).toContain('async syncGroupMetadata(');
    expect(content).toContain('private async translateJid(');
    expect(content).toContain('private async flushOutgoingQueue(');
  });

  it('modified whatsapp.ts includes sendImage implementation', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/src/channels/whatsapp.ts'),
      'utf-8',
    );

    expect(content).toContain('async sendImage(jid: string, buffer: Buffer, caption?: string)');
    expect(content).toContain("{ image: buffer, caption: prefixedCaption }");
    expect(content).toContain("WA disconnected, cannot send image");
    expect(content).toContain('ASSISTANT_HAS_OWN_NUMBER ? caption');
  });

  it('modified whatsapp.test.ts includes sendImage tests', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/src/channels/whatsapp.test.ts'),
      'utf-8',
    );

    expect(content).toContain("describe('sendImage'");
    expect(content).toContain('sends image with prefixed caption');
    expect(content).toContain('sends image without caption');
    expect(content).toContain('drops image silently when disconnected');
  });

  it('modified whatsapp.test.ts preserves all existing test sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/src/channels/whatsapp.test.ts'),
      'utf-8',
    );

    expect(content).toContain("describe('connection lifecycle'");
    expect(content).toContain("describe('authentication'");
    expect(content).toContain("describe('reconnection'");
    expect(content).toContain("describe('message handling'");
    expect(content).toContain("describe('LID to JID translation'");
    expect(content).toContain("describe('outgoing message queue'");
    expect(content).toContain("describe('group metadata sync'");
    expect(content).toContain("describe('ownsJid'");
    expect(content).toContain("describe('setTyping'");
    expect(content).toContain("describe('channel properties'");
  });

  it('modified ipc.ts adds sendImage to IpcDeps and handles image type', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/src/ipc.ts'),
      'utf-8',
    );

    expect(content).toContain('sendImage?');
    expect(content).toContain("data.type === 'image'");
    expect(content).toContain('data.imageBase64');
    expect(content).toContain('Buffer.from(data.imageBase64');
    expect(content).toContain('IPC image sent');
    expect(content).toContain('sendImage not supported by channel');
  });

  it('modified index.ts wires sendImage into startIpcWatcher', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/src/index.ts'),
      'utf-8',
    );

    expect(content).toContain('sendImage: (jid, buffer, caption)');
    expect(content).toContain('channel.sendImage(jid, buffer, caption)');
    expect(content).toContain('Channel does not support sendImage');
  });

  it('modified ipc-mcp-stdio.ts adds image_path to send_message tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/container/agent-runner/src/ipc-mcp-stdio.ts'),
      'utf-8',
    );

    expect(content).toContain('image_path');
    expect(content).toContain("type: 'image'");
    expect(content).toContain('imageBase64');
    expect(content).toContain('buffer.toString(\'base64\')');
    expect(content).toContain('mimeTypes');
  });
});
