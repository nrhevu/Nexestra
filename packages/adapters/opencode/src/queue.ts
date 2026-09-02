/**
 * Tiny push/pull queue bridging the SSE callback world to `run()`'s
 * `AsyncIterable<HarnessEvent>`.
 */
export class AsyncQueue<T> {
  #items: T[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  push(...items: T[]): void {
    if (this.#closed || items.length === 0) return;
    this.#items.push(...items);
    this.#flush();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#flush();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get size(): number {
    return this.#items.length;
  }

  /** Yield everything pushed, then return once `close()` has been called. */
  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.#items.length > 0) {
        const item = this.#items.shift();
        if (item !== undefined) yield item;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  #flush(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
