/**
 * Block until a promise settles. Do not use for SeekDB I/O — Atomics.wait blocks
 * the main thread and async work never runs. SeekDB uses a worker thread instead.
 */
export function runSync<T>(promise: Promise<T>): T {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  let result: T | undefined;
  let error: unknown;

  void promise.then(
    (value) => {
      result = value;
      Atomics.store(view, 0, 1);
      Atomics.notify(view, 0);
    },
    (err) => {
      error = err;
      Atomics.store(view, 0, 1);
      Atomics.notify(view, 0);
    },
  );

  while (Atomics.load(view, 0) === 0) {
    Atomics.wait(view, 0, 0, 50);
  }

  if (error) throw error;
  return result as T;
}
