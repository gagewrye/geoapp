import { expect, type Page } from "@playwright/test";
import { jumpTo, message, openRaster, paintMode, rgbFixture, selectClass, stroke, tiff, toScreen } from "./helpers";

// Helpers for race-opens.tester.spec.ts: overlapping raster opens, held at the file read.

export const W_A: [number, number] = [13.005, 45.005], E_B: [number, number] = [17.005, 44.505];
export const info = (page: Page) => page.locator("#raster-info");

/** Two short strokes at zoom 6: `first` at 13E, `second` at 17E. */
export async function paintPair(page: Page, first: number, second: number) {
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, W_A), b = await toScreen(page, E_B);
  await selectClass(page, first);
  await stroke(page, [a, { x: a.x + 30, y: a.y + 20 }, { x: a.x + 60, y: a.y }]);
  await selectClass(page, second);
  await stroke(page, [b, { x: b.x + 30, y: b.y - 20 }, { x: b.x + 60, y: b.y }]);
}

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
  await paintMode(page);
}
