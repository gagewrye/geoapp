import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, toScreen, view } from "./helpers";
import { at, nodataImagery } from "./seeding";

// Spec 049 edge cases (tester): right drags keep the selection; a right click while the encode is held; Shift+left drags.
const SIDE = 256;
const fake = (page: Page, gate: boolean) => page.evaluate(([SIDE, gate]) => {
  const g = (window as any).__smart = { encodes: 0, decodes: 0, open: () => {}, waiting: false };
  let held: string | null = null;
  (window as any).__geoapp.segmenter = {
    async encode(_i: Float32Array, key: string) {
      g.encodes++; held = null;
      if (gate) { g.waiting = true; await new Promise<void>((r) => { g.open = r; }); g.waiting = false; }
      held = key;
    },
    has: (key: string) => held === key,
    async decode(_p: Float32Array, labels: Uint8Array) {
      g.decodes++;
      const n = labels.length === 1 ? 3 : 1;
      return { masks: new Float32Array(n * SIDE * SIDE).fill(1), scores: new Float32Array(n).fill(0.5), side: SIDE };
    },
  };
}, [SIDE, gate] as const);

async function setup(page: Page, gate = false) {
  await openApp(page);
  await fake(page, gate);
  await openRaster(page, nodataImagery());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, at(300, 300), 9);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("m");
  await expect(page.locator("#mode-smart")).toHaveAttribute("aria-pressed", "true");
}

test("a right drag over 4 px rotates and keeps the selection", async ({ page }) => {
  await setup(page);
  const p = await toScreen(page, at(300.5, 300.5));
  await page.mouse.click(p.x, p.y);
  await expect(page.locator("#smart-apply")).toBeEnabled();
  const before = await view(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + i * 8, p.y, { steps: 1 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(200);
  expect((await view(page)).bearing).not.toBe(before.bearing);
  await expect(page.locator("#smart-apply")).toBeEnabled();
});

test("a right click while the encode is held: the encode resolving afterwards shows nothing, and Smart stays", async ({ page }) => {
  await setup(page, true);
  const p = await toScreen(page, at(300.5, 300.5));
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => (window as any).__smart.waiting)).toBe(true);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.evaluate(() => (window as any).__smart.open());
  await page.waitForTimeout(300);
  await expect(page.locator("#smart-apply")).toBeDisabled();
  await expect(page.locator("#mode-smart")).toHaveAttribute("aria-pressed", "true");
});

test("a Shift+left drag over 4 px in Smart mode neither box-zooms nor adds a point", async ({ page }) => {
  await setup(page);
  const p = await toScreen(page, at(300.5, 300.5));
  const before = await view(page);
  await page.keyboard.down("Shift");
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 60, p.y + 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(400);
  expect((await view(page)).zoom).toBe(before.zoom);
  expect(await page.evaluate(() => (window as any).__smart.decodes)).toBe(0);
  await expect(page.locator("#smart-apply")).toBeDisabled();
});
