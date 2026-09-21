/**
 * A recording, scriptable stand-in for a runtime CLI (`docker`, or whatever
 * an out-of-tree driver shells).
 *
 * This exists so driver tests can drive a real spec through real realization
 * logic and assert on what the driver *did*, rather than on what its source
 * text looks like.
 */
import type { Cli, SupervisedProcess } from './cli.js';

export interface FakeCall {
  args: string[];
  input?: string;
  /** Position in one sequence shared with `start()`, so ordering is assertable. */
  seq: number;
}

export class FakeSupervisedProcess implements SupervisedProcess {
  readonly exitCbs: Array<(code: number | null) => void> = [];
  readonly stderrCbs: Array<(line: string) => void> = [];
  readonly stdoutCbs: Array<(line: string) => void> = [];
  killed = false;

  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
  }
  onStderr(cb: (line: string) => void): void {
    this.stderrCbs.push(cb);
  }
  onStdout(cb: (line: string) => void): void {
    this.stdoutCbs.push(cb);
  }
  kill(): void {
    this.killed = true;
  }

  emitStderr(line: string): void {
    for (const cb of this.stderrCbs) cb(line);
  }
  emitStdout(chunk: string): void {
    for (const cb of this.stdoutCbs) cb(chunk);
  }
  emitExit(code: number | null): void {
    for (const cb of this.exitCbs) cb(code);
  }
}

export class FakeCli implements Cli {
  readonly calls: FakeCall[] = [];
  readonly started: Array<{ args: string[]; proc: FakeSupervisedProcess; seq: number }> = [];
  #seq = 0;
  /** Matched in order against the joined argv; first hit wins. */
  responses: Array<{ match: RegExp; output?: string; throws?: Error | string }> = [];

  constructor(readonly bin = 'fake') {}

  run(args: string[], opts?: { input?: string }): string {
    this.calls.push({ args, input: opts?.input, seq: this.#seq++ });
    const joined = args.join(' ');
    for (const response of this.responses) {
      if (!response.match.test(joined)) continue;
      if (response.throws) {
        throw response.throws instanceof Error ? response.throws : new Error(response.throws);
      }
      return response.output ?? '';
    }
    return '';
  }

  start(args: string[]): SupervisedProcess {
    const proc = new FakeSupervisedProcess();
    this.started.push({ args, proc, seq: this.#seq++ });
    return proc;
  }

  /** Every argv this CLI was asked to run, joined — convenient for assertions. */
  joined(): string[] {
    return this.calls.map((c) => c.args.join(' '));
  }

  callMatching(pattern: RegExp): FakeCall | undefined {
    return this.calls.find((c) => pattern.test(c.args.join(' ')));
  }
}
