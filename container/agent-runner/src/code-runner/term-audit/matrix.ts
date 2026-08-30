/**
 * Shared matrix bookkeeping for the term-audit runners. Two runners share it
 * — run.ts (the attach stack) and tmux-run.ts (the tmux terminal mode) — so
 * the parity comparison between them is row-name to row-name over identical
 * verdict vocabulary, printed identically.
 */
export type Verdict = 'PASS' | 'FAIL' | 'MANUAL';

export interface Row {
  name: string;
  verdict: Verdict;
  detail: string;
}

export class Matrix {
  readonly rows: Row[] = [];
  readonly notes: string[] = [];
  private readonly startedAt = Date.now();

  constructor(private readonly title: string) {}

  row(name: string, verdict: Verdict, detail: string): void {
    this.rows.push({ name, verdict, detail });
    console.log(`  … ${name}: ${verdict}`);
  }

  /** One matrix row per attempt: a thrown timeout is that row's FAIL, not the run's. */
  async attempt(name: string, fn: () => Promise<[Verdict, string]> | [Verdict, string]): Promise<void> {
    try {
      const [verdict, detail] = await fn();
      this.row(name, verdict, detail);
    } catch (error) {
      this.row(name, 'FAIL', (error as Error).message);
    }
  }

  note(...lines: string[]): void {
    this.notes.push(...lines);
  }

  print(): void {
    const width = Math.max(...this.rows.map((r) => r.name.length)) + 2;
    console.log(
      `\n== ${this.title} (${new Date().toISOString()}, ${Math.round(Date.now() - this.startedAt)}ms) ==`,
    );
    for (const r of this.rows) {
      console.log(`${r.name.padEnd(width)}${r.verdict.padEnd(8)}${r.detail}`);
    }
    console.log('\nnotes:');
    for (const n of this.notes) console.log(`  - ${n}`);
    const fails = this.rows.filter((r) => r.verdict === 'FAIL').length;
    const manual = this.rows.filter((r) => r.verdict === 'MANUAL').length;
    console.log(`\n${this.rows.length} rows: ${this.rows.length - fails - manual} PASS, ${fails} FAIL, ${manual} MANUAL`);
  }
}

export function fmt(ms: number): string {
  return `${Math.round(ms)}ms`;
}
