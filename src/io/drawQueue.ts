import { TASK_BUDGET_MS, type Budget } from "./yieldTask";

/** Filled tiles waiting to be drawn: nearest the view's centre first, TASK_BUDGET_MS of work a task, then a yield (spec 028). */
export class DrawQueue<T extends { key: string }> {
  private ready: T[] = [];
  /** The view's tiles by key, centre first: the draw order. */
  order = new Map<string, number>();
  private draining = false;

  constructor(private readonly draw: (t: T) => void, readonly budget: Budget) {}

  get size(): number { return this.ready.length; }

  push(t: T): void { this.ready.push(t); }

  /** Removes and returns the waiting tiles `pick` selects. */
  take(pick: (t: T) => boolean): T[] {
    const out = this.ready.filter(pick);
    this.ready = this.ready.filter((t) => !pick(t));
    return out;
  }

  /** Draws waiting tiles, yielding to the browser whenever TASK_BUDGET_MS have passed since `start` in this task. */
  async drain(start: number): Promise<void> {
    if (this.draining) return; // the drain already running picks the new tiles up
    this.draining = true;
    try {
      while (this.ready.length) {
        if (this.budget.now() - start >= TASK_BUDGET_MS) {
          await this.budget.yieldTask();
          start = this.budget.now();
          continue;
        }
        this.draw(this.next());
      }
    } finally {
      this.draining = false;
    }
  }

  /** Removes and returns the waiting tile nearest the view's centre. */
  private next(): T {
    let best = 0;
    const rank = (t: T) => this.order.get(t.key) ?? Infinity;
    for (let i = 1; i < this.ready.length; i++) if (rank(this.ready[i]!) < rank(this.ready[best]!)) best = i;
    return this.ready.splice(best, 1)[0]!;
  }
}
