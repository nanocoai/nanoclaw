/**
 * Commander 协议辅助：artifacts 路径白名单校验。
 *
 * 子群上报的 artifacts 是宿主机绝对路径，不允许任意路径（否则可报
 * `~/.ssh/id_rsa` 等敏感文件，即便非恶意也是泄漏面）。host 对每个路径
 * path.resolve 规范化后做白名单前缀校验 + 敏感子路径黑名单兜底。
 */

import path from 'path';

/** 即使落在白名单根内，命中这些子路径段也拒绝 */
const SENSITIVE_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.config'];

/**
 * 校验单个 artifact 路径是否落在白名单内。
 * @param artifact 待校验路径（可为相对，会被 resolve）
 * @param allowedRoots 允许的根目录绝对路径数组（如 group workspace / 项目根 / /tmp/nanoclaw-artifacts）
 * @returns 合法返回规范化后的绝对路径，非法返回 null
 */
export function validateArtifactPath(
  artifact: string,
  allowedRoots: string[],
): string | null {
  if (typeof artifact !== 'string' || artifact.trim() === '') return null;

  const resolved = path.resolve(artifact);

  // 白名单前缀校验：加 path.sep 防 `/tmp/nanoclaw-artifacts-evil` 这类前缀绕过；
  // 允许 resolved === root 本身（理论上不太会，但不拦）。
  const hitRoot = allowedRoots.some((root) => {
    if (!root) return false;
    const normRoot = path.resolve(root);
    return resolved === normRoot || resolved.startsWith(normRoot + path.sep);
  });
  if (!hitRoot) return null;

  // 敏感子路径黑名单兜底（小写比较：macOS 默认大小写不敏感，防 .SSH/.Aws 绕过）
  const segments = resolved.split(path.sep).map((seg) => seg.toLowerCase());
  if (segments.some((seg) => SENSITIVE_SEGMENTS.includes(seg))) return null;
  // .env 文件（含 .env.local 等变体）
  if (segments.some((seg) => seg === '.env' || seg.startsWith('.env.')))
    return null;

  return resolved;
}

/**
 * 批量校验 artifacts，分流为合法（记账本）与非法（降级纯文本备注）。
 */
export function partitionArtifacts(
  artifacts: string[] | undefined,
  allowedRoots: string[],
): { valid: string[]; rejected: string[] } {
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const a of artifacts || []) {
    const ok = validateArtifactPath(a, allowedRoots);
    if (ok) valid.push(ok);
    else rejected.push(a);
  }
  return { valid, rejected };
}
