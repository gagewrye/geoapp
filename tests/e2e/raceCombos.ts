import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { jumpTo, message, openRaster, rgbFixture, selectClass, stroke, tiff, toScreen, type Xy } from "./helpers";

// Helpers for the race-*.tester specs.
// Tester pass 3 (F9-F11 and the Classify busy fix): Train, Classify, Load model, AlphaEarth and
// overlapping raster opens in combination, with cancel and failure paths.

export const W_A: [number, number] = [13.005, 45.005], E_B: [number, number] = [17.005, 44.505];
export const trainBtn = (page: Page) => page.locator("#train");
export const classifyBtn = (page: Page) => page.locator("#classify");
export const info = (page: Page) => page.locator("#raster-info");

/** Two short strokes at zoom 6: `first` at 13E, `second` at 17E (as brush-train-snapshot.tester). */
export async function paintPair(page: Page, first: number, second: number) {
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, W_A), b = await toScreen(page, E_B);
  await selectClass(page, first);
  await stroke(page, [a, { x: a.x + 30, y: a.y + 20 }, { x: a.x + 60, y: a.y }]);
  await selectClass(page, second);
  await stroke(page, [b, { x: b.x + 30, y: b.y - 20 }, { x: b.x + 60, y: b.y }]);
}

/** A mouse stroke that doesn't wait for the paint queue. */
export async function rawStroke(page: Page, pts: Xy[], button: "left" | "right" = "left") {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down({ button });
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up({ button });
}

/**
 * A Save dialog that answers at once and records each export (base64, on close). With `holdNext`
 * set, the next export's first write waits for `go()`; `fail` makes that write throw instead.
 */
export async function savePicker(page: Page) {
  await page.addInitScript(() => {
    const g = (window as any).__save = { opened: 0, exports: [] as string[], holdNext: false, held: false, go: null as null | ((fail?: boolean) => void) };
    (window as any).showSaveFilePicker = async () => {
      g.opened++;
      const parts: Uint8Array[] = [];
      let first = g.holdNext;
      g.holdNext = false;
      return {
        createWritable: async () => ({
          write: async (d: Uint8Array) => {
            if (first) {
              first = false;
              g.held = true;
              const fail = await new Promise<boolean | undefined>((r) => { g.go = r; });
              g.held = false;
              if (fail) throw new Error("simulated write failure");
            }
            parts.push(d.slice());
          },
          close: async () => {
            let s = "";
            for (const p of parts) for (let i = 0; i < p.length; i += 0x8000) s += String.fromCharCode(...p.subarray(i, i + 0x8000));
            g.exports.push(btoa(s));
          },
          abort: async () => {},
        }),
      };
    };
  });
}
export const exportsDone = (page: Page) => page.evaluate(() => (window as any).__save.exports.length as number);
export const lastExport = (page: Page) => page.evaluate(() => (window as any).__save.exports.at(-1) as string);
export const holdNextExport = (page: Page) => page.evaluate(() => { (window as any).__save.holdNext = true; });
export const exportHeld = (page: Page) => page.evaluate(() => (window as any).__save.held as boolean);
export const releaseExport = (page: Page, fail = false) => page.evaluate((fail) => (window as any).__save.go(fail), fail);

/** Classify and export, unheld, and return the file's base64. */
export async function exportNow(page: Page): Promise<string> {
  const n = await exportsDone(page);
  await page.click("#classify");
  await expect(message(page)).toHaveText("Export complete.");
  await expect.poll(() => exportsDone(page)).toBe(n + 1);
  return lastExport(page);
}

export async function geo(b64: string) {
  const buf = Buffer.from(b64, "base64");
  const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)).getImage();
  return { size: [img.getWidth(), img.getHeight()], origin: img.getOrigin().slice(0, 2) };
}

export async function savedModel(page: Page): Promise<{ text: string; json: unknown }> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#save-model")]);
  const text = (await readFile((await dl.path())!)).toString("utf8");
  return { text, json: JSON.parse(text) };
}
export const loadModel = (page: Page, text: string) =>
  page.setInputFiles("#load-model", { name: "model.json", mimeType: "application/json", buffer: Buffer.from(text) });

/** Hold the open imagery's readWindow calls (Train and mask reads) until openGate. */
export const gateReads = (page: Page) => page.evaluate(() => {
  const s = (window as any).__geoapp.imagery();
  const read = s.readWindow.bind(s);
  const g = (window as any).__gate = { hold: true, calls: [] as (() => void)[], failNext: false };
  s.readWindow = (...a: unknown[]) => {
    if (!g.hold) return read(...a);
    return new Promise((res, rej) => { g.calls.push(() => (g.failNext ? rej(new Error("Read failed.")) : read(...a).then(res, rej))); });
  };
});
export const gatedCalls = (page: Page) => page.evaluate(() => (window as any).__gate.calls.length as number);
export const openGate = (page: Page, fail = false) => page.evaluate((fail) => {
  const g = (window as any).__gate;
  g.hold = false;
  g.failNext = fail;
  for (const go of g.calls.splice(0)) go();
}, fail);

/** Hold FileReader reads of one file name ("all", or "committed": once #raster-info names it), as raster-race.spec.ts. */
export async function fileGate(page: Page) {
  await page.addInitScript(() => {
    const g = (window as any).__files = { hold: new Map<string, string>(), waiting: [] as (() => void)[] };
    const slice = Blob.prototype.slice;
    Blob.prototype.slice = function (this: Blob, ...a: Parameters<Blob["slice"]>) {
      const b = slice.apply(this, a);
      (b as any).__name = (this as any).__name ?? (this as File).name;
      return b;
    };
    const read = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function (this: FileReader, b: Blob) {
      const name = (b as any).__name as string | undefined, mode = name && g.hold.get(name);
      const held = mode === "all" || (mode === "committed" && document.getElementById("raster-info")!.textContent!.startsWith(`${name}:`));
      if (held) g.waiting.push(() => read.call(this, b));
      else read.call(this, b);
    };
  });
}
export const holdFile = (page: Page, name: string, mode: "all" | "committed") =>
  page.evaluate(([name, mode]) => (window as any).__files.hold.set(name, mode), [name, mode] as const);
export const fileWaiting = (page: Page) => page.evaluate(() => (window as any).__files.waiting.length as number);
export const releaseFiles = (page: Page) => page.evaluate(() => {
  const g = (window as any).__files;
  g.hold.clear();
  for (const go of g.waiting.splice(0)) go();
});

/** 800 x 600, 3 bands, at 30..38E, 40..46N; band 1 is 200 west of 34E and 120 east of it. */
export const otherFixture = () => tiff("other.tif", 800, 600, 3, (b, c) => (b === 0 ? (c < 400 ? 200 : 120) : 150),
  { epsg: 4326, gt: [30, 0.01, 0, 46, 0, -0.01] });

export async function openRgb(page: Page) {
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}
