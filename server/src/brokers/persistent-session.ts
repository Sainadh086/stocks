import { Mutex } from "../shared/storage.js";

export interface SessionLease<T> {
  value: T;
  isOpen(): boolean;
  persist(): Promise<void> | void;
  close(): Promise<void>;
}

/** Serialize broker workflows and reuse their authenticated transport.
 * A failed workflow is never replayed: it may already have placed an order.
 */
export class PersistentSession<T> {
  private readonly lock = new Mutex();
  private current: SessionLease<T> | null = null;
  private closing = false;
  constructor(
    private readonly open: () => Promise<SessionLease<T>>,
    private readonly broken: (error: unknown) => boolean,
  ) {}
  run<R>(action: (session: T) => Promise<R>): Promise<R> {
    return this.lock.run(async () => {
      if (this.closing)
        throw new Error("Broker session manager is shutting down.");
      if (this.current && !this.current.isOpen()) await this.retire();
      this.current ??= await this.open();
      const current = this.current;
      let failed = false;
      try {
        return await action(current.value);
      } catch (error) {
        failed = this.broken(error);
        throw error;
      } finally {
        if (failed || !current.isOpen()) await this.retire();
        else await current.persist();
      }
    });
  }
  private async retire() {
    const current = this.current;
    this.current = null;
    if (current) await current.close();
  }
  close(): Promise<void> {
    this.closing = true;
    return this.lock.run(() => this.retire());
  }
}
