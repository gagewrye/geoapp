import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../../../src/ui/messages";
import { initSmartLoad } from "../../../src/ui/smartLoad";

// Spec 055 criterion 6 and scope 4 (tester): the worker's own no-WebGPU answer, a worker crash, a throwing adapter,
// a press during a load, and a retry that succeeds.
vi.mock("../../../src/io/modelCache", async (orig) => ({
  ...(await orig<typeof import("../../../src/io/modelCache")>()),
  cachedAll: async () => false,
  pruneCache: async () => {},
  fetchCached: async () => new Uint8Array(1),
}));

const reply = vi.hoisted(() => ({ next: [] as ("no-webgpu" | "ok" | "crash" | "fail")[] }));
class ScriptedWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  postMessage(msg: { id: number }) {
    const r = reply.next.shift() ?? "ok";
    queueMicrotask(() => {
      if (r === "crash") this.onerror?.({ message: "" });
      else if (r === "fail") this.onmessage?.({ data: { id: msg.id, ok: false, error: "ORT failed" } });
      else this.onmessage?.({ data: { id: msg.id, ok: true, value: r } });
    });
  }
  terminate() {}
}

const gpuOk = { requestAdapter: async () => ({ features: { has: (f: string) => f === "shader-f16" } }) };

function setup() {
  const d = {
    alert: vi.fn<(t: string) => void>(),
    log: vi.fn<(e: unknown) => void>(),
    confirm: vi.fn(() => true),
    progress: { busy: vi.fn(), step: vi.fn(), hide: vi.fn() },
    cancel: { hidden: true, onclick: null } as unknown as HTMLButtonElement,
  };
  return { d, load: initSmartLoad({ hook: () => null, ...d }) };
}

describe("ensure() edges", () => {
  beforeEach(() => { vi.stubGlobal("navigator", { gpu: gpuOk }); vi.stubGlobal("Worker", ScriptedWorker); reply.next = []; });
  afterEach(() => vi.unstubAllGlobals());

  it("no WebGPU in the worker: one popup, one log, 'no-webgpu', and the bar hidden", async () => {
    reply.next = ["no-webgpu"];
    const { d, load } = setup();
    expect(await load.ensure()).toBe("no-webgpu");
    expect(d.alert.mock.calls).toEqual([[MESSAGES.smartUnavailable]]);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.progress.hide).toHaveBeenCalled();
    expect(d.cancel.hidden).toBe(true);
  });

  it("a worker crash (onerror with no message): one popup, one log", async () => {
    reply.next = ["crash"];
    const { d, load } = setup();
    expect(await load.ensure()).toBe("cancelled");
    expect(d.alert.mock.calls).toEqual([[MESSAGES.smartUnavailable]]);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.log.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("requestAdapter throwing counts as no WebGPU: one popup, one log, no confirm", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => { throw new Error("gpu lost"); } } });
    const { d, load } = setup();
    expect(await load.ensure()).toBe("no-webgpu");
    expect(d.alert).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("a null adapter counts as no WebGPU", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => null } });
    const { d, load } = setup();
    expect(await load.ensure()).toBe("no-webgpu");
    expect(d.alert).toHaveBeenCalledTimes(1);
  });

  it("a press while a failing load runs adds no second popup or log", async () => {
    reply.next = ["fail"];
    const { d, load } = setup();
    const [a, b] = await Promise.all([load.ensure(), load.ensure()]);
    expect([a, b]).toEqual(["cancelled", "cancelled"]);
    expect(d.alert).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledTimes(1);
  });

  it("after a failure, a later press retries and succeeds with no popup or log", async () => {
    reply.next = ["fail", "ok"];
    const { d, load } = setup();
    expect(await load.ensure()).toBe("cancelled");
    expect(await load.ensure()).toBe("ok");
    expect(d.alert).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(load.current()).not.toBeNull();
    expect(await load.ensure()).toBe("ok");
    expect(d.confirm).toHaveBeenCalledTimes(2);
  });
});
