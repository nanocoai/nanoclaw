import { describe, expect, it } from 'vitest';

import { partitionArtifacts, validateArtifactPath } from './commander.js';

const roots = ['/repo/groups/sub3', '/repo/nine', '/tmp/nanoclaw-artifacts'];

describe('validateArtifactPath', () => {
  it('白名单内路径通过', () => {
    expect(validateArtifactPath('/repo/nine/diff.patch', roots)).toBe(
      '/repo/nine/diff.patch',
    );
    expect(
      validateArtifactPath('/tmp/nanoclaw-artifacts/x.txt', roots),
    ).toBe('/tmp/nanoclaw-artifacts/x.txt');
    expect(validateArtifactPath('/repo/groups/sub3/out.md', roots)).toBe(
      '/repo/groups/sub3/out.md',
    );
  });

  it('白名单外路径拒绝', () => {
    expect(validateArtifactPath('/etc/passwd', roots)).toBeNull();
    expect(validateArtifactPath('/Users/x/secret', roots)).toBeNull();
  });

  it('前缀绕过被拦截（path.sep 校验）', () => {
    // /tmp/nanoclaw-artifacts-evil 不应命中 /tmp/nanoclaw-artifacts
    expect(
      validateArtifactPath('/tmp/nanoclaw-artifacts-evil/x', roots),
    ).toBeNull();
  });

  it('敏感子路径黑名单兜底（即使在白名单根内）', () => {
    expect(
      validateArtifactPath('/repo/nine/.ssh/id_rsa', roots),
    ).toBeNull();
    expect(
      validateArtifactPath('/repo/nine/.aws/credentials', roots),
    ).toBeNull();
    expect(validateArtifactPath('/repo/nine/.env', roots)).toBeNull();
    expect(
      validateArtifactPath('/repo/nine/sub/.env.local', roots),
    ).toBeNull();
    expect(
      validateArtifactPath('/repo/nine/.config/secret', roots),
    ).toBeNull();
  });

  it('敏感段大小写不敏感（macOS 防 .SSH/.Aws 绕过）', () => {
    expect(validateArtifactPath('/repo/nine/.SSH/id_rsa', roots)).toBeNull();
    expect(
      validateArtifactPath('/repo/nine/.AWS/credentials', roots),
    ).toBeNull();
    expect(validateArtifactPath('/repo/nine/.ENV', roots)).toBeNull();
  });

  it('空/非法输入返回 null', () => {
    expect(validateArtifactPath('', roots)).toBeNull();
    expect(validateArtifactPath('   ', roots)).toBeNull();
  });

  it('../ 逃逸经 resolve 后落在白名单外被拒', () => {
    expect(
      validateArtifactPath('/repo/nine/../../etc/passwd', roots),
    ).toBeNull();
  });
});

describe('partitionArtifacts', () => {
  it('分流合法与非法', () => {
    const { valid, rejected } = partitionArtifacts(
      ['/repo/nine/a.patch', '/etc/passwd', '/repo/nine/.ssh/id_rsa'],
      roots,
    );
    expect(valid).toEqual(['/repo/nine/a.patch']);
    expect(rejected).toEqual(['/etc/passwd', '/repo/nine/.ssh/id_rsa']);
  });

  it('undefined 返回空', () => {
    expect(partitionArtifacts(undefined, roots)).toEqual({
      valid: [],
      rejected: [],
    });
  });
});
