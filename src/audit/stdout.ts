/** Bounded best-effort stdout copy. PostgreSQL remains the authority. */
interface AuditOutput {
  write(value: string): boolean;
  on(event: 'drain', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

const MAX_QUEUED_RECORDS = 512;
const MAX_QUEUED_BYTES = 1024 * 1024;

export class AuditStdoutSink {
  private blocked = false;
  private broken = false;
  private queued: string[] = [];
  private queuedBytes = 0;
  private dropped = 0;
  private warnedAt = 0;

  constructor(
    private readonly output: AuditOutput,
    private readonly warnings: { write(value: string): unknown },
  ) {
    output.on('drain', () => this.flush());
    output.on('error', (error: Error) => {
      this.broken = true;
      this.warn(`Host audit stdout copy failed: ${(error as NodeJS.ErrnoException).code || error.name}`);
      this.dropQueued();
    });
  }

  writeCanonical(line: string): void {
    const record = `${line}\n`;
    if (this.broken) {
      this.noteDrop();
      return;
    }
    if (this.blocked) {
      this.enqueue(record);
      return;
    }
    this.writeNow(record);
  }

  shutdown(): void {
    if (this.broken) return;
    this.broken = true;
    this.dropQueued();
  }

  flush(): void {
    if (this.broken) return;
    this.blocked = false;
    while (!this.blocked && this.queued.length > 0) {
      const record = this.queued.shift()!;
      this.queuedBytes -= Buffer.byteLength(record);
      this.writeNow(record);
    }
  }

  private writeNow(record: string): void {
    try {
      // false means this record is buffered by Node; stop adding more until drain.
      this.blocked = this.output.write(record) === false;
    } catch (error) {
      this.broken = true;
      this.warn(`Host audit stdout copy failed: ${error instanceof Error ? error.name : 'unknown'}`);
      this.noteDrop();
    }
  }

  private enqueue(record: string): void {
    const bytes = Buffer.byteLength(record);
    if (this.queued.length >= MAX_QUEUED_RECORDS || this.queuedBytes + bytes > MAX_QUEUED_BYTES) {
      this.noteDrop();
      return;
    }
    this.queued.push(record);
    this.queuedBytes += bytes;
  }

  private dropQueued(): void {
    const count = this.queued.length;
    this.queued = [];
    this.queuedBytes = 0;
    for (let index = 0; index < count; index++) this.noteDrop();
  }

  private noteDrop(): void {
    this.dropped++;
    if (this.dropped === 1 || (this.dropped & (this.dropped - 1)) === 0) {
      this.warn(`Host audit stdout copies dropped: ${this.dropped}`);
    }
  }

  private warn(message: string): void {
    if (this.warnedAt === this.dropped && this.dropped !== 0) return;
    this.warnedAt = this.dropped;
    try {
      this.warnings.write(`${message}\n`);
    } catch {
      // PostgreSQL remains authoritative even when both process streams fail.
    }
  }
}

const STDOUT_SINK = Symbol.for('nanoclaw.host-audit.stdout-sink');
const processGlobal = globalThis as typeof globalThis & {
  [STDOUT_SINK]?: AuditStdoutSink;
};

export const auditStdout =
  processGlobal[STDOUT_SINK] ??= new AuditStdoutSink(process.stdout, process.stderr);

export function shutdownAuditStdout(): void {
  auditStdout.shutdown();
}
