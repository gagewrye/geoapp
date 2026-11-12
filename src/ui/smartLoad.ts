import { hasWebGpu, loadSegmenter, modelCached, type Segmenter } from "../io/segmenter";
import { MESSAGES } from "./messages";

type Deps = {
  /** e2e: a Segmenter set on __geoapp.segmenter replaces the model, its download and the WebGPU check. */
  hook: () => Segmenter | null;
  confirm: (text: string) => boolean;
  /** Spec 055: a load failure is one popup, and its cause goes to the log. */
  alert: (text: string) => void;
  log: (e: unknown) => void;
  /** Spec 019's bar. */
  progress: { busy(): void; step(done: number, total: number): void; hide(): void };
  cancel: HTMLButtonElement;
};

/** Smart select's first use (spec 046 scope 2, spec 055): WebGPU check, the download confirm, then the download and load with progress and Cancel. */
export function initSmartLoad({ hook, confirm, alert, log, progress, cancel }: Deps) {
  let segmenter: Segmenter | null = null;
  let loading = false;
  return {
    /** The Segmenter, once loaded. */
    current: (): Segmenter | null => hook() ?? segmenter,
    /** Loads the model if needed: "ok" once Smart can be selected; Cancel, a failure or a load already running give "cancelled". */
    async ensure(): Promise<"ok" | "no-webgpu" | "cancelled"> {
      if (hook() || segmenter) return "ok";
      if (loading) return "cancelled";
      loading = true;
      const ac = new AbortController();
      const unavailable = (cause: unknown) => { alert(MESSAGES.smartUnavailable); log(cause); };
      const noGpu = (where: string) => { unavailable(new Error(`no WebGPU adapter with shader-f16 ${where}`)); return "no-webgpu" as const; };
      let shown = false; // the bar and Cancel are ours only once the download starts
      try {
        // before any download: no adapter with shader-f16, no model
        if (!(await hasWebGpu())) return noGpu("in the page");
        if (!(await modelCached()) && !confirm(MESSAGES.smartDownload)) return "cancelled";
        cancel.onclick = () => ac.abort();
        cancel.hidden = false;
        shown = true;
        progress.busy();
        const r = await loadSegmenter((done, total) => (done < total ? progress.step(done, total) : progress.busy()), ac.signal);
        if (r === "no-webgpu") return noGpu("in the worker");
        segmenter = r;
        return "ok";
      } catch (e) {
        if (!ac.signal.aborted) unavailable(e);
        return "cancelled";
      } finally {
        loading = false;
        if (shown) { cancel.hidden = true; progress.hide(); }
      }
    },
  };
}

export type SmartLoad = ReturnType<typeof initSmartLoad>;
