import { expect, test, type Page } from "@playwright/test";
import { pixelAt as cellAt } from "../../src/core/pixel";
import { maskBits, maskSpans, promptPoints, samWindow } from "../../src/core/smart";
import { MESSAGES } from "../../src/ui/messages";
import { jumpTo, labels, logRequests, message, openApp, openRaster, rgbFixture, settled, toLngLat, toScreen, type Xy } from "./helpers";
import { gateWrites, openWrite, writeHeld } from "./lockCombos";
import { at, inNodata, ND_GRID, noSavePicker, nodataImagery } from "./seeding";

// Spec 046 criteria 5-8, with a fake Segmenter through the __geoapp.segmenter hook: its masks are squares of
// half-width R logits (4 encoder pixels each) around each include point.
const R = 8, SIDE = 256;

/** Installs the fake; `gate` holds each encode until window.__smart.open() is called. */
const fakeSegmenter = (page: Page, gate = false) => page.evaluate(([R, SIDE, gate]) => {
  const g = (window as any).__smart = { encodes: 0, open: () => {}, waiting: false };
  let held: string | null = null;
  (window as any).__geoapp.segmenter = {
    async encode(_input: Float32Array, key: string) {
      g.encodes++;
      held = null;
      if (gate) { g.waiting = true; await new Promise<void>((r) => { g.open = r; }); g.waiting = false; }
      held = key;
    },
    has: (key: string) => held === key,
    async decode(points: Float32Array, labels: Uint8Array) {
      const n = labels.length === 1 ? 3 : 1, masks = new Float32Array(n * SIDE * SIDE).fill(-1);
      for (let i = 0; i < labels.length; i++) {
        if (!labels[i]) continue;
        const cx = Math.floor(points[2 * i]! / 4), cy = Math.floor(points[2 * i + 1]! / 4);
        for (let k = 0; k < n; k++) for (let y = Math.max(0, cy - R); y <= Math.min(SIDE - 1, cy + R); y++)
          for (let x = Math.max(0, cx - R); x <= Math.min(SIDE - 1, cx + R); x++) masks[k * SIDE * SIDE + y * SIDE + x] = 1;
      }
      return { masks, scores: new Float32Array(n).fill(0.5), side: SIDE };
    },
  };
}, [R, SIDE, gate] as const);

/** The pixels the fake's mask for a single include click on cell fills, as "col,row". */
function square(cell: [number, number]): Set<string> {
  const w = samWindow(ND_GRID, cell[0], cell[1]);
  const [px, py] = promptPoints([cell], w), logits = new Float32Array(SIDE * SIDE).fill(-1);
  const cx = Math.floor(px! / 4), cy = Math.floor(py! / 4);
  for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) logits[y * SIDE + x] = 1;
  const out = new Set<string>();
  for (const s of maskSpans(maskBits(logits, SIDE, w), w)) for (let x = s.x0; x < s.x1; x++) out.add(`${x},${s.row}`);
  return out;
}

const tool = (page: Page) => page.locator("#status-tool");
const smartButton = (page: Page) => page.locator("#mode-smart");
const unfocus = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** Opens the nodata imagery centred on pixel (c, r) at zoom 9 (about 3.6 screen px per pixel), and presses M. */
async function setup(page: Page, [c, r]: [number, number] = [300, 300]) {
  await openApp(page);
  await fakeSegmenter(page);
  await openRaster(page, nodataImagery());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, at(c, r), 9);
  await unfocus(page);
  await page.keyboard.press("m");
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");
}

/** Clicks a screen point in Smart mode and waits for the preview; returns the clicked cell. */
async function click(page: Page, p: Xy, button: "left" | "right" = "left"): Promise<[number, number]> {
  await page.mouse.click(p.x, p.y, { button });
  await expect(page.locator("#smart-apply")).toBeEnabled();
  const [ll] = await toLngLat(page, [p]);
  return cellAt(ND_GRID, ll![0], ll![1]);
}

test("a click then Enter labels the square except imagery nodata; one Ctrl+Z restores every tile and Ctrl+Y redoes (criterion 5)", async ({ page }) => {
  await setup(page, [430, 425]);
  const cell = await click(page, await toScreen(page, at(430.5, 425.5)));
  await page.keyboard.press("Enter");
  await settled(page);
  await expect(page.locator("#smart-apply")).toBeDisabled(); // the commit cleared the prompt
  const want = [...square(cell)].filter((k) => { const [c, r] = k.split(",").map(Number) as [number, number]; return !inNodata(c, r); });
  expect(want.length).toBeGreaterThan(1000);
  const got = await labels(page);
  expect(new Set(got.keys())).toEqual(new Set(want));
  expect(new Set(got.values())).toEqual(new Set([1]));

  await page.keyboard.press("Control+z");
  expect((await labels(page)).size).toBe(0);
  expect(await page.evaluate(() => (window as any).__geoapp.labels.store.tiles.size)).toBe(0);
  await page.keyboard.press("Control+y");
  expect(await labels(page)).toEqual(got);
});

test("Escape before Enter labels nothing and keeps Smart; a second Escape selects Pan (criteria 5, 7)", async ({ page }) => {
  await setup(page);
  await click(page, await toScreen(page, at(300.5, 300.5)));
  await page.keyboard.press("Escape");
  await expect(page.locator("#smart-apply")).toBeDisabled();
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  expect((await labels(page)).size).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "false");
});

test("with 256 tiles stored, a commit touching a new tile shows the label-limit message and changes nothing (criterion 6)", async ({ page }) => {
  await setup(page);
  // 256 tiles beyond the raster's 16 keys: the store is full without changing any pixel the labels helper reads
  await page.evaluate(() => {
    const { store } = (window as any).__geoapp.labels;
    for (let i = 0; i < 256; i++) store.tiles.set(`${(i % 16) * 256},${(8 + Math.floor(i / 16)) * 256}`, new Uint8Array(65536).fill(1));
  });
  await click(page, await toScreen(page, at(300.5, 300.5)));
  await page.keyboard.press("Enter");
  await expect(message(page)).toHaveText(MESSAGES.labelLimit);
  await settled(page);
  expect((await labels(page)).size).toBe(0);
  expect(await page.evaluate(() => (window as any).__geoapp.labels.store.tiles.size)).toBe(256);
  await expect(page.locator("#smart-apply")).toBeEnabled(); // a refused commit keeps the prompt
});

test("while an export runs with a paused sink, Enter changes nothing (criterion 6)", async ({ page }) => {
  await noSavePicker(page);
  await gateWrites(page);
  await setup(page);
  await click(page, await toScreen(page, at(300.5, 300.5)));
  const downloaded = page.waitForEvent("download");
  await page.click("#export-labels");
  await writeHeld(page);
  await unfocus(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  expect((await labels(page)).size).toBe(0);
  await openWrite(page);
  await downloaded;
  await expect(message(page)).toHaveText("Labels exported.");
  expect((await labels(page)).size).toBe(0);
});

test("the Smart button, M, Escape, the status bar and the help list (criterion 7)", async ({ page }) => {
  await openApp(page);
  await fakeSegmenter(page, true);
  await openRaster(page, nodataImagery());
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(smartButton(page)).toHaveAttribute("title", "Smart select (M)");
  await page.click("#show-labels"); // hidden labels: choosing Smart shows them
  await expect(page.locator("#show-labels")).not.toBeChecked();
  await unfocus(page);
  await page.keyboard.press("m");
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#show-labels")).toBeChecked();
  await expect(tool(page)).toHaveText("Smart · Class 1");
  await jumpTo(page, at(300, 300), 9);
  await page.mouse.click(...(Object.values(await toScreen(page, at(300.5, 300.5))) as [number, number]));
  await expect(tool(page)).toHaveText("Smart · Class 1 · reading…");
  await expect.poll(() => page.evaluate(() => (window as any).__smart.waiting)).toBe(true); // the imagery is read; the encode is held
  await expect(tool(page)).toHaveText("Smart · Class 1 · reading…");
  await page.evaluate(() => (window as any).__smart.open());
  await expect(tool(page)).toHaveText("Smart · Class 1");
  await expect(page.locator("#smart-apply")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await smartButton(page).click();
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("?");
  for (const [k, action] of [["M", "Smart select"], ["Enter", "Apply smart selection"], ["Click / Right click", "Include / exclude a point"], ["Esc", "Discard the selection"]]) {
    await expect(page.locator("#help .shortcut").filter({ has: page.getByText(action!, { exact: true }) }).locator("kbd")).toHaveText(k!);
  }
});

test("without navigator.gpu, M shows the WebGPU message, keeps the mode and requests no model file (criterion 7)", async ({ page }) => {
  await page.addInitScript(() => { delete (Navigator.prototype as any).gpu; delete (navigator as any).gpu; });
  const log = logRequests(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await unfocus(page);
  await page.keyboard.press("m");
  await expect(message(page)).toHaveText(MESSAGES.noWebGpu);
  await expect(message(page)).not.toHaveClass(/error/);
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(smartButton(page)).toBeDisabled();
  await expect(smartButton(page)).toHaveAttribute("title", MESSAGES.noWebGpu);
  await page.waitForTimeout(200);
  expect(log.map((r) => r.url()).filter((u) => u.includes("models/"))).toEqual([]);
});

test("the entry chunk has no onnxruntime, and load through a commit requests only same-origin files (criterion 8)", async ({ page, baseURL }) => {
  const log = logRequests(page);
  await setup(page);
  await click(page, await toScreen(page, at(300.5, 300.5)));
  await page.keyboard.press("Enter");
  await settled(page);
  expect((await labels(page)).size).toBeGreaterThan(0);
  const app = new URL(baseURL!);
  for (const u of log.map((r) => r.url()).filter((u) => !u.startsWith("data:"))) {
    expect(new URL(u.startsWith("blob:") ? u.slice(5) : u).origin, u).toBe(app.origin);
  }
  const entry = await page.evaluate(() => document.querySelector<HTMLScriptElement>("script[type=module][src]")!.src);
  const js = await (await page.request.get(entry)).text();
  expect(js.length).toBeGreaterThan(10_000);
  expect(js).not.toContain("onnxruntime");
});
