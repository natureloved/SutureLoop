/**
 * Minimal async mutual exclusion.
 *
 * SutureLoop can be driven from several entry points at once: the CLI, the demo
 * server's `/api/v1/incidents/ingest` webhook (which fires remediation in the
 * background), and watch mode. Two concurrent healing sessions would rewrite the
 * same target file and race on the local telemetry queue file, so every
 * state-mutating section runs through one lock.
 *
 * Deliberately tiny: FIFO promise chain, no dependencies, no timeout (a stuck
 * holder is a bug to fix, not something to paper over by abandoning the lock).
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;

  /** Tasks queued but not yet settled. 1 means the lock is held. */
  get pending(): number {
    return this.queued;
  }

  /** Runs `fn` once every previously queued task has settled. */
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    this.queued += 1;
    const run = this.tail.then(fn, fn);
    // Keep the chain alive even when a task rejects, otherwise one failed
    // section would poison every queued section behind it.
    this.tail = run.then(
      () => {
        this.queued -= 1;
      },
      () => {
        this.queued -= 1;
      }
    );
    return run;
  }

  /** Resolves once the queue has drained. */
  async drain(): Promise<void> {
    await this.tail;
  }
}