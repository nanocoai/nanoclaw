import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-container-image-variants skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: add-container-image-variants');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('src/types.ts');
    expect(content).toContain('src/container-runner.ts');
    expect(content).toContain('container/build.sh');
  });

  it('has all modified files', () => {
    for (const file of [
      'modify/src/types.ts',
      'modify/src/container-runner.ts',
      'modify/container/build.sh',
    ]) {
      expect(fs.existsSync(path.join(skillDir, file)), `missing: ${file}`).toBe(true);
    }
  });

  it('has intent files for all modified sources', () => {
    for (const file of [
      'modify/src/types.ts.intent.md',
      'modify/src/container-runner.ts.intent.md',
      'modify/container/build.sh.intent.md',
    ]) {
      expect(fs.existsSync(path.join(skillDir, file)), `missing: ${file}`).toBe(true);
    }
  });

  it('types.ts adds image field to ContainerConfig', () => {
    const content = fs.readFileSync(path.join(skillDir, 'modify/src/types.ts'), 'utf-8');
    expect(content).toContain('image?: string');
    expect(content).toContain('ContainerConfig');
    // Must keep existing fields
    expect(content).toContain('additionalMounts');
    expect(content).toContain('timeout');
  });

  it('container-runner.ts uses per-group image with fallback', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/src/container-runner.ts'),
      'utf-8',
    );
    expect(content).toContain('containerConfig?.image');
    expect(content).toContain('CONTAINER_IMAGE');
    // Fallback pattern
    expect(content).toMatch(/containerConfig\?\.image\s*\|\|\s*CONTAINER_IMAGE/);
  });

  it('build.sh discovers variant images', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/container/build.sh'),
      'utf-8',
    );
    // Multi-image logic
    expect(content).toContain('for dir in');
    expect(content).toContain('SKIP_DIRS');
    expect(content).toContain('nanoclaw-agent-');
    // Default image unchanged
    expect(content).toContain('nanoclaw-agent');
    // CONTAINER_RUNTIME override still works
    expect(content).toContain('CONTAINER_RUNTIME:-docker');
  });

  it('build.sh skips non-image directories', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify/container/build.sh'),
      'utf-8',
    );
    expect(content).toContain('agent-runner');
    expect(content).toContain('skills');
  });
});
