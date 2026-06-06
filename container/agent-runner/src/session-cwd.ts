import fs from 'fs';
import path from 'path';

export interface SessionTranscriptInfo {
  transcriptPath: string;
  projectEntry: string;
  projectDir: string;
}

export function encodeClaudeProjectPath(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

export function findSessionTranscriptInfo(
  configDir: string | undefined,
  sessionId: string | undefined,
): SessionTranscriptInfo | undefined {
  if (!configDir || !sessionId) return undefined;
  const projectsDir = path.join(configDir, 'projects');
  if (!fs.existsSync(projectsDir)) return undefined;

  for (const entry of fs.readdirSync(projectsDir)) {
    const projectDir = path.join(projectsDir, entry);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(transcriptPath)) {
      return {
        transcriptPath,
        projectEntry: entry,
        projectDir,
      };
    }
  }
  return undefined;
}

export function findSessionTranscript(
  configDir: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  return findSessionTranscriptInfo(configDir, sessionId)?.transcriptPath;
}

export function readTranscriptCwd(
  transcriptPath: string | undefined,
): string | undefined {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return undefined;
  const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n').reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { cwd?: unknown };
      if (typeof parsed.cwd === 'string' && parsed.cwd.trim()) return parsed.cwd;
    } catch {
      // 跳过损坏行，继续读更早的 transcript 记录。
    }
  }
  return undefined;
}

export function resolveQueryCwdForSession(input: {
  configDir?: string;
  sessionId?: string;
  defaultCwd: string;
  candidateCwds?: Array<string | undefined>;
}): {
  cwd: string;
  transcriptPath?: string;
  projectEntry?: string;
  projectCwd?: string;
  transcriptCwd?: string;
  usedProjectCwd: boolean;
  usedTranscriptCwd: boolean;
} {
  const transcriptInfo = findSessionTranscriptInfo(input.configDir, input.sessionId);
  const transcriptCwd = readTranscriptCwd(transcriptInfo?.transcriptPath);
  const candidateCwds = [input.defaultCwd, ...(input.candidateCwds || [])]
    .filter((cwd): cwd is string => Boolean(cwd?.trim()))
    .map((cwd) => path.resolve(cwd));
  const uniqueCandidateCwds = Array.from(new Set(candidateCwds));
  const projectCwd = transcriptInfo
    ? uniqueCandidateCwds.find((cwd) => encodeClaudeProjectPath(cwd) === transcriptInfo.projectEntry)
    : undefined;
  if (projectCwd && fs.existsSync(projectCwd)) {
    return {
      cwd: projectCwd,
      transcriptPath: transcriptInfo?.transcriptPath,
      projectEntry: transcriptInfo?.projectEntry,
      projectCwd,
      transcriptCwd,
      usedProjectCwd: true,
      usedTranscriptCwd: false,
    };
  }
  if (transcriptCwd && transcriptCwd !== input.defaultCwd && fs.existsSync(transcriptCwd)) {
    return {
      cwd: transcriptCwd,
      transcriptPath: transcriptInfo?.transcriptPath,
      projectEntry: transcriptInfo?.projectEntry,
      projectCwd,
      transcriptCwd,
      usedProjectCwd: false,
      usedTranscriptCwd: true,
    };
  }
  return {
    cwd: input.defaultCwd,
    transcriptPath: transcriptInfo?.transcriptPath,
    projectEntry: transcriptInfo?.projectEntry,
    projectCwd,
    transcriptCwd,
    usedProjectCwd: false,
    usedTranscriptCwd: false,
  };
}
