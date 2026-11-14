import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelFileError } from "../../../src/io/modelCache";
import { MESSAGES } from "../../../src/ui/messages";
import { initSmartLoad } from "../../../src/ui/smartLoad";

// Spec 055 criterion 6: initSmartLoad with fake WebGPU, model files and worker.
const files = vi.hoisted(() => ({ fetch: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(1)) }));
vi.mock("../../../src/io/modelCache", async (orig) => ({
  ...(await orig<typeof import("../../../src/io/modelCache")>()),
  cachedAll: async () => false,
  pruneCache: async () => {},
  fetchCached: () => files.fetch(),
}));

/** A worker whose load replies with an error. */
class FailingWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage(msg: { id: number }) { queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: false, error: "ORT: session failed" } })); }
  terminate() {}
}

const gpu = (f16: boolean) => ({ requestAdapter: async () => ({ features: { has: (f: string) => f16 && f === "shader-f16" } }) });

function setup(confirmed = true) {
  const d = {
    alert: vi.fn<(t: string) => void>(),
    log: vi.fn<(e: unknown) => void>(),
    confirm: vi.fn(() => confirmed),
    progress: { busy: vi.fn(), step: vi.fn(), hide: vi.fn() },
    cancel: { hidden: true, onclick: null } as unknown as HTMLButtonElement,
  };
  const load = initSmartLoad({ hook: () => null, ...d });
  return { d, load };
}

describe("ensure() failures (criterion 6)", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { gpu: gpu(true) });
    vi.stubGlobal("Worker", FailingWorker);
    files.fetch = () => Promise.resolve(new Uint8Array(1));
  });
  afterEach(() => vi.unstubAllGlobals());

  const once = (d: ReturnType<typeof setup>["d"]) => {
    expect(d.alert.mock.calls).toEqual([[MESSAGES.smartUnavailable]]);
    expect(d.log).toHaveBeenCalledTimes(1);
  };

  it("no WebGPU: one popup, one log, no download confirm, and 'no-webgpu'", async () => {
    vi.stubGlobal("navigator", {});
    const { d, load } = setup();
    expect(await load.ensure()).toBe("no-webgpu");
    once(d);
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("no shader-f16 counts as no WebGPU", async () => {
    vi.stubGlobal("navigator", { gpu: gpu(false) });
    const { d, load } = setup();
    expect(await load.ensure()).toBe("no-webgpu");
    once(d);
  });

  it("a fetchCached rejection: one popup, its cause logged, and a later press retries", async () => {
    const cause = new ModelFileError("https://huggingface.co/x.onnx", "4271 bytes, expected 314925");
    files.fetch = () => Promise.reject(cause);
    const { d, load } = setup();
    expect(await load.ensure()).toBe("cancelled");
    once(d);
    expect(d.log).toHaveBeenCalledWith(cause);
    expect(d.progress.hide).toHaveBeenCalled();
    expect(d.cancel.hidden).toBe(true);
    await load.ensure();
    expect(d.confirm).toHaveBeenCalledTimes(2);
  });

  it("a worker load rejection: one popup, its cause logged", async () => {
    const { d, load } = setup();
    expect(await load.ensure()).toBe("cancelled");
    once(d);
    expect((d.log.mock.calls[0]![0] as Error).message).toBe("ORT: session failed");
  });

  it("Cancel calls none of them", async () => {
    let abort = () => {};
    files.fetch = () => new Promise((_, reject) => { abort = () => reject(new DOMException("Cancelled.", "AbortError")); });
    const { d, load } = setup();
    const r = load.ensure();
    await vi.waitFor(() => expect(d.cancel.onclick).toBeTypeOf("function"));
    await vi.waitFor(() => expect(d.progress.busy).toHaveBeenCalled());
    (d.cancel.onclick as () => void)();
    abort();
    expect(await r).toBe("cancelled");
    expect(d.alert).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it("declining the download confirm calls none of them", async () => {
    const { d, load } = setup(false);
    expect(await load.ensure()).toBe("cancelled");
    expect(d.alert).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });
});
