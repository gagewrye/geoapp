/** A progress bar (specs 019, 021): indeterminate, or windows done out of total. */
export function initProgress(bar: HTMLProgressElement) {
  return {
    /** Shown with no value: work whose progress isn't counted. */
    busy(): void {
      bar.removeAttribute("value");
      bar.hidden = false;
    },
    step(done: number, total: number): void {
      bar.max = total;
      bar.value = done;
      bar.hidden = false;
    },
    hide(): void {
      bar.hidden = true;
    },
  };
}
