/**
 * Per-session log sinks.
 *
 * Agent containers run with `--rm`, so whatever the agent-runner writes to
 * stderr is gone the moment the container exits. The driver forwards those
 * lines to the host log at debug and keeps a short tail for a non-zero exit —
 * a session that hangs, or exits 0 having done nothing, leaves no trace at the
 * default level. A sink sees every line of a started session's output, which
 * is what an install needs to keep its own persistent per-session log.
 *
 * None is registered by default. Drivers call `openSessionLog` when they begin
 * supervising a session's process and feed it that process's lines.
 */
import { log } from '../log.js';
import type { SessionKey } from './types.js';

export interface SessionLogWriter {
  write(line: string): void;
  /** The supervised process exited; release anything held open. */
  close?(): void;
}

/**
 * Called once per started session process. `runtimeName` is the driver's name
 * for the process (the container name for docker). Return nothing to skip it.
 */
export type SessionLogSink = (key: SessionKey, runtimeName: string) => SessionLogWriter | undefined;

const sinks = new Set<SessionLogSink>();

/** Returns an unregister function. */
export function registerSessionLogSink(sink: SessionLogSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/**
 * Fan one session's output out to every registered sink, or null when none
 * wants it. A throwing sink is dropped with a warning: these calls run inside
 * the supervision process's stream handlers, where an escaped error would take
 * the host down.
 */
export function openSessionLog(key: SessionKey, runtimeName: string): Required<SessionLogWriter> | null {
  const writers: SessionLogWriter[] = [];
  for (const sink of sinks) {
    try {
      const writer = sink(key, runtimeName);
      if (writer) writers.push(writer);
    } catch (err) {
      log.warn('Session log sink failed to open', { runtimeName, err });
    }
  }
  if (writers.length === 0) return null;

  const call = (writer: SessionLogWriter, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      writers.splice(writers.indexOf(writer), 1);
      log.warn('Session log sink failed; dropping it for this session', { runtimeName, err });
    }
  };
  return {
    write(line) {
      for (const writer of [...writers]) call(writer, () => writer.write(line));
    },
    close() {
      for (const writer of [...writers]) call(writer, () => writer.close?.());
      writers.length = 0;
    },
  };
}
