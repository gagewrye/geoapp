import { afterEach, describe, expect, it, vi } from "vitest";
import { initialClasses } from "../../../src/core/classes";
import { emptyStore } from "../../../src/core/labelStore";
import { runExport } from "../../../src/ui/exportLabels";
import { fakeSource } from "../helpers/sources";

// Spec 055 scope 6 with spec 056 scope 6: a download may be cancelled or lost, so it never marks the session exported.
const written: number[] = [];
vi.mock("../../../src/io/sink", async (orig) => ({
  ...(await orig<typeof import("../../../src/io/sink")>()),
  canPickFolder: () => false,
  downloadSink: async () => {
    let n = 0;
    return { write: async (d: Uint8Array) => { n += d.length; }, close: async () => { written.push(n); }, abort: async () => {}, size: async () => n };
  },
}));
afterEach(() => { written.length = 0; });

describe("the download path", () => {
  it("exports the whole file and says so, but never calls exported", async () => {
    const { source } = fakeSource({ width: 600, height: 300 }, () => 1);
    const said: string[] = [], exports: number[] = [];
    await runExport({
      imagery: source, store: emptyStore(600, 300), classes: initialClasses(), base: null, startIn: null, imageryFile: null,
      mask: () => null, waitCopy: async () => {}, prompt: () => null, confirm: () => true,
      say: (t) => { said.push(t); }, error: (e) => String(e), exported: (at) => { exports.push(at); }, now: () => 42,
    });
    expect(written).toHaveLength(1);
    expect(said.at(-1)).toBe("Labels exported.");
    expect(exports).toEqual([]);
  });
});
