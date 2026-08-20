import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_TRANSACTION_WATCHDOG_MS = 10_000;

export interface TransactionScope<TConnection> {
  connection: TConnection;
  depth: number;
  closed: boolean;
  savepointSequence: number;
}

export class TransactionScopeStore<TConnection> {
  private readonly storage = new AsyncLocalStorage<TransactionScope<TConnection>>();

  current(): TransactionScope<TConnection> | undefined {
    return this.storage.getStore();
  }

  run<T>(scope: TransactionScope<TConnection>, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(scope, fn);
  }

  assertOpen(scope: TransactionScope<TConnection>): void {
    if (scope.closed) {
      throw new Error('Central DB transaction scope is closed; an async continuation escaped its callback');
    }
  }

  nextSavepoint(scope: TransactionScope<TConnection>): string {
    this.assertOpen(scope);
    scope.savepointSequence += 1;
    return `nanoclaw_sp_${scope.savepointSequence}`;
  }
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
}

export async function withTransactionWatchdog<T>(
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_TRANSACTION_WATCHDOG_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Central DB transaction exceeded ${timeoutMs}ms watchdog`));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
