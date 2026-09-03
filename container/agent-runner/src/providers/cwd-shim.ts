/**
 * Launch-directory fallback for provider runtimes that cannot set a spawn
 * cwd on a stdio MCP server. Current consumers: claude (the Agent SDK's
 * McpStdioServerConfig has no cwd field, checked against 0.3.197) and
 * opencode (its local MCP entry is a bare argv array). Codex consumes cwd
 * natively and never calls this. When a runtime gains native cwd support,
 * delete its call site and pass the value through; when the last call site
 * goes, delete this file and its test.
 *
 * The wrap launches through /bin/sh so the process can chdir before exec.
 * cwd, command, and args travel as positional parameters ($0, $1, $2…), never
 * interpolated into the shell string, so hostile values cannot inject shell
 * syntax. cwd arrives absolute (resolved by plugin-mcp.ts), so `cd` cannot
 * misread it as a flag.
 *
 * Twin-patched at this same path on the providers registry branch (donor-
 * branch doctrine); keep the two copies byte-identical.
 */
import type { McpServerConfig } from './types.js';

/** The wrap as one argv, for runtimes configured with a bare argv array (opencode). */
export function cwdWrappedArgv(cwd: string, command: string, args: string[]): string[] {
  return ['/bin/sh', '-c', 'cd "$0" && exec "$@"', cwd, command, ...args];
}

export function shimCwd(config: McpServerConfig): McpServerConfig {
  if (config.type === 'http' || !config.cwd) return config;
  const { cwd, ...server } = config;
  const [command, ...args] = cwdWrappedArgv(cwd, config.command, config.args ?? []);
  return { ...server, command, args };
}
