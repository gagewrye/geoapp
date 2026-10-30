/** Resolves in a new task, so the browser can render first (spec 028): a MessageChannel post, which, unlike setTimeout, isn't clamped to 4 ms. */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    // a port per yield, closed once used, so no open port keeps the page (or a test run) alive
    port1.onmessage = () => { port1.close(); resolve(); };
    port2.postMessage(null);
  });
}

/** Spec 028: main-thread work started by one task stops once this many ms have passed in it, and the rest waits for the next task. */
export const TASK_BUDGET_MS = 8;

/** The clock and the yield a budgeted loop uses; tests pass fakes. */
export type Budget = { now: () => number; yieldTask: () => Promise<void> };
export const browserBudget: Budget = { now: () => performance.now(), yieldTask: yieldToBrowser };
