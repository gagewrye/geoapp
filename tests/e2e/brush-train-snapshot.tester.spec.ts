import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, jumpTo, labels, message, openApp, openRaster, rgbFixture, selectClass, settled, stroke, toScreen, type Xy } from "./helpers";

// Tester: spec 003 [C5] Train snapshot (F2). Paint, erase and new tiles while Train reads, Train
// while the paint queue waits, two Trains in a row, and a raster opened while Train reads.

/** Paint class 1 west and class 2 east of 15E around 45N at zoom 6 (as brush-train.spec.ts). */
async function paintTwo(page: Page) {
  await jumpTo(page, [15, 45], 6);
  const a = await toScreen(page, [13.005, 45.005]), b = await toScreen(page, [17.005, 44.505]);
  await stroke(page, [a, { x: a.x + 30, y: a.y + 20 }, { x: a.x + 60, y: a.y }]);
  await selectClass(page, 1);
  await stroke(page, [b, { x: b.x + 30, y: b.y - 20 }, { x: b.x + 60, y: b.y }]);
}

/** A mouse stroke that doesn't wait for the paint queue (its mask reads may be gated). */
async function rawStroke(page: Page, pts: Xy[], button: "left" | "right" = "left") {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down({ button });
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up({ button });
}

/**
 * Gate the imagery's reads: while `hold` is set each call waits in `calls` until released; with
 * `hold` off new calls pass straight through.
 */
const gate = (page: Page) => page.evaluate(() => {
  const s = (window as any).__geoapp.imagery();
  const read = s.readWindow.bind(s);
  const g = (window as any).__gate = { hold: true, calls: [] as { go: () => void; done: boolean }[] };
  s.readWindow = (...a: unknown[]) => {
    if (!g.hold) return read(...a);
    return new Promise((res, rej) => {
      const c = { done: false, go: () => { if (!c.done) { c.done = true; read(...a).then(res, rej); } } };
      g.calls.push(c);
    });
  };
});
const calls = (page: Page) => page.evaluate(() => (window as any).__gate.calls.length as number);
const release = (page: Page, i: number) => page.evaluate((i) => (window as any).__gate.calls[i].go(), i);
const openGate = (page: Page) => page.evaluate(() => {
  const g = (window as any).__gate;
  g.hold = false;
  for (const c of g.calls) c.go();
});

async function savedModel(page: Page): Promise<unknown> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#save-model")]);
  return JSON.parse((await readFile((await dl.path())!)).toString("utf8"));
}

async function setup(page: Page) {
  const errors = collectErrors(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintTwo(page);
  return errors;
}

test.describe("Train snapshot [C5] (tester)", () => {
  test("new tiles painted and pixels erased while Train reads: N and the model are the click's; Train is disabled while those mask reads wait and a scripted click does nothing", async ({ page }) => {
    const errors = await setup(page);
    const before = await labels(page);
    await page.click("#train"); // the run without edits
    await expect(message(page)).toHaveText(`Trained on ${before.size} pixels, 2 classes.`);
    const want = await savedModel(page);
    await gate(page);
    await page.click("#train");
    await expect.poll(() => calls(page)).toBe(1); // Train's first window
    // a new tile (512,256), north-east of the strokes, needs a mask read, which waits behind the gate
    await selectClass(page, 0);
    const nw = await toScreen(page, [16.205, 46.805]);
    await rawStroke(page, [nw, { x: nw.x + 40, y: nw.y + 10 }]);
    await expect.poll(() => calls(page)).toBe(2);
    await expect(page.locator("#train")).toBeDisabled();
    // part of class 2 erased (erase reads nothing)
    await selectClass(page, 1);
    const b = await toScreen(page, [17.005, 44.505]);
    await rawStroke(page, [b, { x: b.x + 20, y: b.y - 13 }], "right");
    await page.evaluate(() => (document.getElementById("train") as HTMLButtonElement).click()); // disabled: ignored
    await expect(message(page)).toHaveText("Training...");
    await openGate(page);
    await expect(message(page)).toHaveText(`Trained on ${before.size} pixels, 2 classes.`);
    expect(await savedModel(page)).toEqual(want);
    await settled(page);
    const after = await labels(page);
    expect(after.size).not.toBe(before.size);
    expect([...after.keys()].some((k) => { const [c, r] = k.split(",").map(Number); return c! >= 512 && r! < 512; })).toBe(true);
    await page.click("#train"); // the edits count for the next Train
    await expect(message(page)).toHaveText(`Trained on ${after.size} pixels, 2 classes.`);
    expect(errors).toEqual([]);
  });

  test("a stroke whose mask reads are pending, then Train once they apply: N includes that stroke", async ({ page }) => {
    const errors = await setup(page);
    await gate(page);
    const nw = await toScreen(page, [16.205, 46.805]);
    await rawStroke(page, [nw, { x: nw.x + 40, y: nw.y + 10 }]);
    await expect.poll(() => calls(page)).toBe(1);
    await expect(page.locator("#train")).toBeDisabled();
    const pending = await labels(page);
    await openGate(page);
    await settled(page);
    const all = await labels(page);
    expect(all.size).toBeGreaterThan(pending.size); // the queued cells applied after release
    await page.click("#train");
    await expect(message(page)).toHaveText(`Trained on ${all.size} pixels, 2 classes.`);
    expect(errors).toEqual([]);
  });

  test("Train clicked twice quickly: one result message, N is the labels, no error", async ({ page }) => {
    const errors = await setup(page);
    const n = (await labels(page)).size;
    await page.evaluate(() => { const t = document.getElementById("train") as HTMLButtonElement; t.click(); t.click(); });
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
    await page.waitForTimeout(300);
    await expect(message(page)).toHaveText(`Trained on ${n} pixels, 2 classes.`);
    expect(errors).toEqual([]);
  });

  // F9: Train is disabled from the click until its run ends, so runs never overlap and an older run
  // can't overwrite a newer one's model or message.
  test("two Trains in a row: a click while the first runs starts no run, and the second's model stands", async ({ page }) => {
    const errors = await setup(page);
    const n1 = (await labels(page)).size;
    await gate(page);
    await page.click("#train"); // run 1, on all the labels
    await expect.poll(() => calls(page)).toBe(1);
    await expect(page.locator("#train")).toBeDisabled();
    // erase part of class 2 (no reads), then try a second run on fewer pixels
    const b = await toScreen(page, [17.005, 44.505]);
    await rawStroke(page, [b, { x: b.x + 20, y: b.y - 13 }], "right");
    const n2 = (await labels(page)).size;
    expect(n2).toBeLessThan(n1);
    await page.evaluate(() => (document.getElementById("train") as HTMLButtonElement).click()); // disabled: ignored
    await page.waitForTimeout(300);
    expect(await calls(page)).toBe(1); // no second run read anything
    await expect(message(page)).toHaveText("Training...");
    await release(page, 0);
    await openGate(page);
    await expect(message(page)).toHaveText(`Trained on ${n1} pixels, 2 classes.`);
    await settled(page); // enabled again once run 1 ends
    const m1 = await savedModel(page);
    await page.click("#train"); // run 2, on the erased labels
    await expect(message(page)).toHaveText(`Trained on ${n2} pixels, 2 classes.`);
    const m2 = await savedModel(page);
    expect(m2).not.toEqual(m1);
    await page.waitForTimeout(500);
    await expect(message(page)).toHaveText(`Trained on ${n2} pixels, 2 classes.`);
    expect(await savedModel(page)).toEqual(m2);
    expect(errors).toEqual([]);
  });

  // F10: a Train still reading the old raster when another opens is dropped: no "Trained on N pixels"
  // for discarded labels and no model from the old raster.
  test("opening another raster while Train reads: the old run's result doesn't land on the new raster", async ({ page }) => {
    const errors = await setup(page);
    await gate(page);
    await page.click("#train");
    await expect.poll(() => calls(page)).toBe(1);
    page.once("dialog", (d) => d.accept());
    await openRaster(page, { ...rgbFixture(), name: "other.tif" });
    await expect(message(page)).toHaveText("Raster opened.");
    expect((await labels(page)).size).toBe(0);
    await openGate(page);
    await page.waitForTimeout(800);
    await expect(message(page)).toHaveText("Raster opened.");
    await page.click("#save-model");
    await expect(message(page)).toHaveText("Train or load a model first.");
    await settled(page); // the dropped run has ended, so Train is free for the new raster
    expect(errors).toEqual([]);
  });
});
