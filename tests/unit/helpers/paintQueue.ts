import type { PaintQueue } from "../../../src/io/paintQueue";

/** Resolves once the queue is empty. */
export async function idle(q: PaintQueue): Promise<void> {
  while (q.size) await new Promise((r) => setTimeout(r, 5));
}
