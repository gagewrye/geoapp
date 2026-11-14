import { expect, test, type Page } from "@playwright/test";
import { pixelAt as cellAt } from "../../src/core/pixel";
import { maskBits, maskSpans, promptPoints, samWindow } from "../../src/core/smart";
import { MESSAGES } from "../../src/ui/messages";
import { hintOf, jumpTo, labels, logRequests, message, openApp, openRaster, rgbFixture, settled, toLngLat, toScreen, view, type Xy } from "./helpers";
import { gateWrites, openWrite, writeHeld } from "./lockCombos";
import { at, inNodata, ND_GRID, noSavePicker, nodataImagery } from "./seeding";

// Spec 046 criteria 5-8, with a fake Segmenter through the __geoapp.segmenter hook: its masks are squares of
// half-width R logits (4 encoder pixels each) around each include point.
const R = 8, SIDE = 256;

/** Installs the fake; `gate` holds each encode until window.__smart.open() is called. */
const fakeSegmenter = (page: Page, gate = false) => page.evaluate(([R, SIDE, gate]) => {
  const g = (window as any).__smart = { encodes: 0, open: () => {}, waiting: false, labels: [] as number[][] };
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
      g.labels.push([...labels]);
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

  await page.keyboard.press("ControlOrMeta+z");
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

test("the Smart button, M, Escape, the status bar and the help list (criterion 7, help as amended by spec 049 criterion 6)", async ({ page }) => {
  await openApp(page);
  await fakeSegmenter(page, true);
  await openRaster(page, nodataImagery());
  await expect(message(page)).toHaveText("Raster opened.");
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(smartButton(page)).toHaveAttribute("title", `Smart select (M)\n${hintOf("smart")}`);
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
  for (const [k, action] of [["M", "Smart select"], ["Enter", "Apply smart selection"], ["Click / Shift+click", "Include / exclude a point"], ["Esc / Right click", "Discard the selection"]]) {
    await expect(page.locator("#help .shortcut").filter({ has: page.getByText(action!, { exact: true }) }).locator("kbd")).toHaveText(k!);
  }
});

test("without navigator.gpu, M shows the unavailable popup, keeps the mode and requests no model file (criterion 7, as amended by spec 055 criterion 8)", async ({ page }) => {
  await page.addInitScript(() => { delete (Navigator.prototype as any).gpu; delete (navigator as any).gpu; });
  const log = logRequests(page);
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await unfocus(page);
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(`${d.type()}: ${d.message()}`); void d.accept(); }); // an alert blocks the key press until handled
  await page.keyboard.press("m");
  await expect.poll(() => dialogs).toEqual([`alert: ${MESSAGES.smartUnavailable}`]);
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(smartButton(page)).toBeDisabled();
  await expect(smartButton(page)).toHaveAttribute("title", MESSAGES.smartUnavailable);
  await expect(message(page)).not.toHaveClass(/error/);
  await page.waitForTimeout(200);
  expect(log.map((r) => r.url()).filter((u) => u.includes("models/") || new URL(u).hostname.endsWith("huggingface.co"))).toEqual([]);
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

// Spec 049 criteria 4 and 5: a right click discards the selection; Shift+click adds an exclude point.
/** Records whether each contextmenu reached the window with its default prevented. */
const recordMenus = (page: Page) => page.evaluate(() => {
  const g = (window as any).__menus = [] as boolean[];
  window.addEventListener("contextmenu", (e) => g.push(e.defaultPrevented)); // after the app's listener on #map
});
const menus = (page: Page) => page.evaluate(() => (window as any).__menus as boolean[]);
/** The smart preview's map layers (map/smartLayer.ts names them smart-<i>). */
const previewLayers = (page: Page) => page.evaluate(() =>
  ((window as any).__geoapp.map.getStyle().layers as { id: string }[]).filter((l) => /^smart-\d+$/.test(l.id)).length);
const rightClick = (page: Page, p: Xy) => page.mouse.click(p.x, p.y, { button: "right" });

test("a right click hides the preview and keeps Smart; Enter then labels nothing and Undo stays off (spec 049 criterion 4)", async ({ page }) => {
  await setup(page);
  await recordMenus(page);
  const p = await toScreen(page, at(300.5, 300.5));
  await click(page, p);
  expect(await previewLayers(page)).toBeGreaterThan(0);
  await rightClick(page, p);
  await expect(page.locator("#smart-apply")).toBeDisabled();
  expect(await previewLayers(page)).toBe(0);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  expect((await labels(page)).size).toBe(0);
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#undo")).toBeDisabled();
  expect(await menus(page)).toEqual([true]);
});

test("a right click right after Enter leaves the fill, and one Ctrl+Z removes it (spec 049 criterion 4)", async ({ page }) => {
  await setup(page);
  await recordMenus(page);
  const p = await toScreen(page, at(300.5, 300.5));
  await click(page, p);
  await page.keyboard.press("Enter");
  await rightClick(page, p);
  await settled(page);
  await expect(page.locator("#smart-apply")).toBeDisabled();
  expect((await labels(page)).size).toBeGreaterThan(0);
  await page.keyboard.press("ControlOrMeta+z");
  expect((await labels(page)).size).toBe(0);
  await expect(page.locator("#undo")).toBeDisabled();
  expect(await menus(page)).toEqual([true]);
});

test("a right click with no prompt keeps Smart selected (spec 049 criterion 4)", async ({ page }) => {
  await setup(page, [20, 300]);
  await recordMenus(page);
  await rightClick(page, await toScreen(page, at(20.5, 300.5)));
  await rightClick(page, await toScreen(page, at(-20, 300))); // on the map, off the raster
  await page.waitForTimeout(200);
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "false");
  expect(await menus(page)).toEqual([true, true]);
});

test("a Shift+left release 3 px from its press adds an exclude point and doesn't zoom (spec 049 criterion 5)", async ({ page }) => {
  await setup(page);
  const p = await toScreen(page, at(300.5, 300.5)), q = await toScreen(page, at(310.5, 300.5));
  await click(page, p);
  const before = await view(page);
  await page.keyboard.down("Shift");
  await page.mouse.move(q.x, q.y);
  await page.mouse.down();
  await page.mouse.move(q.x + 3, q.y);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(() => page.evaluate(() => (window as any).__smart.labels.at(-1))).toEqual([1, 0]);
  await page.waitForTimeout(300); // a box zoom would ease
  expect((await view(page)).zoom).toBe(before.zoom);
});

const apply = (page: Page) => page.locator("#smart-apply");

test("Apply shows only in Smart: hidden in Pan, disabled until a mask, hidden by every other tool and by Escape (spec 056 criterion 4)", async ({ page }) => {
  await openApp(page);
  await fakeSegmenter(page);
  await openRaster(page, nodataImagery());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, at(300, 300), 9);
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(apply(page)).toBeHidden();
  await unfocus(page);
  await page.keyboard.press("m");
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(apply(page)).toBeVisible();
  await expect(apply(page)).toBeDisabled();
  await click(page, await toScreen(page, at(300.5, 300.5)));
  await expect(apply(page)).toBeVisible();
  await expect(apply(page)).toBeEnabled();

  for (const [m, key] of [["pan", "p"], ["paint", "b"], ["erase", "e"], ["fill", "f"], ["polygon", "l"]] as const) {
    for (const how of ["button", "key"]) {
      await unfocus(page);
      await page.keyboard.press("m");
      await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");
      await expect(apply(page), `Smart before ${m} by ${how}`).toBeVisible();
      if (how === "button") { await page.click(`#mode-${m}`); await unfocus(page); } else await page.keyboard.press(key);
      await expect(page.locator(`#mode-${m}`)).toHaveAttribute("aria-pressed", "true");
      await expect(apply(page), `${m} by ${how}`).toBeHidden();
    }
  }
  await page.keyboard.press("m");
  await expect(apply(page)).toBeVisible();
  await page.keyboard.press("Escape"); // no prompt: Pan
  await expect(page.locator("#mode-pan")).toHaveAttribute("aria-pressed", "true");
  await expect(apply(page)).toBeHidden();
  await smartButton(page).click();
  await expect(smartButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(apply(page)).toBeVisible();
});

test("a click on the visible Apply labels the mask, as Enter does (spec 056 criterion 6)", async ({ page }) => {
  await setup(page, [430, 425]);
  const cell = await click(page, await toScreen(page, at(430.5, 425.5)));
  await expect(apply(page)).toBeVisible();
  await apply(page).click();
  await settled(page);
  await expect(apply(page)).toBeDisabled();
  await expect(apply(page)).toBeVisible(); // still Smart
  const want = [...square(cell)].filter((k) => { const [c, r] = k.split(",").map(Number) as [number, number]; return !inNodata(c, r); });
  expect(new Set((await labels(page)).keys())).toEqual(new Set(want));
});
