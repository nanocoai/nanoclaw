import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

import { parseArgs } from './cli-agent.js';

describe('parseArgs', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  it('parses --display-name', () => {
    const result = parseArgs(['--display-name', 'Alice']);
    expect(result.displayName).toBe('Alice');
    expect(result.agentName).toBeUndefined();
    expect(result.folder).toBeUndefined();
  });

  it('parses all three flags', () => {
    const result = parseArgs([
      '--display-name', 'Alice',
      '--agent-name', 'Andy',
      '--folder', 'cli-with-alice',
    ]);
    expect(result).toEqual({ displayName: 'Alice', agentName: 'Andy', folder: 'cli-with-alice' });
  });

  it('accepts flags in any order', () => {
    const result = parseArgs([
      '--folder', 'mydir',
      '--agent-name', 'Andy',
      '--display-name', 'Alice',
    ]);
    expect(result.displayName).toBe('Alice');
    expect(result.agentName).toBe('Andy');
    expect(result.folder).toBe('mydir');
  });

  it('calls process.exit(2) when --display-name is missing', () => {
    parseArgs(['--agent-name', 'Andy']);
    expect(process.exit).toHaveBeenCalledWith(2);
  });

  it('calls process.exit(2) for empty args', () => {
    parseArgs([]);
    expect(process.exit).toHaveBeenCalledWith(2);
  });
});
