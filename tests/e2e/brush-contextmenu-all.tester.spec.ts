import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, rgbFixture, stroke, tiff, toScreen } from "./helpers";

// Tester pass 4: spec 003 Strokes / criterion 10. contextmenu is prevented on the map while local
// imagery is open, in every mode and tool, and never on any panel element, whether opened by mouse,
// by keyboard or just after an erase stroke.

const PANEL = ["#classes .class-name", "#classes input[type=color]", "#classes input[type=radio]", "#mode-paint", "#brush-larger",
  "#class-add", "#open-raster", "#aef-year", "#aef-draw", "#train", "#load-model", "#message", "#panel h1"];
const MAP = [".maplibregl-canvas", ".maplibregl-ctrl-zoom-in", ".maplibregl-ctrl-compass", ".maplibregl-ctrl-globe, .maplibregl-ctrl-globe-enabled"];

/** defaultPrevented of a contextmenu dispatched on the first match of each selector. */
const prevented = (page: Page, sels: string[]) => page.evaluate((sels) => Object.fromEntries(sels.map((s) => {
  const el = document.querySelector(s);
  if (!el) return [s, "missing"];
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  el.dispatchEvent(e);
  return [s, e.defaultPrevented];
})), sels);
const all = (sels: string[], v: boolean) => Object.fromEntries(sels.map((s) => [s, v]));

async function open(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await jumpTo(page, [15, 45], 7);
}

test.describe("contextmenu on every map and panel element (criterion 10, tester pass 4)", () => {
  test("no imagery: no panel element is prevented", async ({ page }) => {
    await openApp(page);
    expect(await prevented(page, PANEL.filter((s) => !s.startsWith("#classes") && !s.startsWith("#mode") && !s.startsWith("#brush") && s !== "#class-add")))
      .toEqual(all(["#open-raster", "#aef-year", "#aef-draw", "#train", "#load-model", "#message", "#panel h1"], false));
  });

  const states: [string, (page: Page) => Promise<void>][] = [
    ["Paint", async () => {}],
    ["Pan", async (page) => { await page.click("#mode-pan"); }],
    ["Space held", async (page) => { await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.down(" "); }],
    ["area tool", async (page) => { await page.click("#aef-draw"); }],
    ["another raster opened", async (page) => {
      await openRaster(page, tiff("b.tif", 1000, 1000, 3, () => 120, { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] }));
      await expect(page.locator("#raster-info")).toContainText("b.tif");
      await expect(message(page)).toHaveText("Raster opened.");
    }],
  ];
  for (const [name, enter] of states) {
    test(`imagery open, ${name}: every map element is prevented, no panel element is`, async ({ page }) => {
      await open(page);
      await enter(page);
      expect(await prevented(page, MAP)).toEqual(all(MAP, true));
      expect(await prevented(page, PANEL)).toEqual(all(PANEL, false));
      await page.keyboard.up(" ");
    });
  }

  test("right-clicks on the panel's fields and controls, also within 500 ms of an erase, aren't prevented", async ({ page }) => {
    await open(page);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    await page.evaluate(() => {
      const g = (window as any).__menus = [] as unknown[];
      window.addEventListener("contextmenu", (e) => g.push([(e.target as Element).closest("#map") !== null, e.defaultPrevented]));
    });
    const targets = ["#classes .class-name", "#classes input[type=color]", "#aef-year", "#brush-larger", "#message"];
    for (const t of targets) {
      await stroke(page, [c, { x: c.x + 40, y: c.y }], "right");
      const t0 = Date.now();
      await page.locator(t).first().click({ button: "right" });
      expect(Date.now() - t0).toBeLessThan(500);
    }
    const got = await page.evaluate(() => (window as any).__menus as [boolean, boolean][]);
    // each erase press on the map (prevented), then the panel target (not)
    expect(got).toEqual(targets.flatMap(() => [[true, true], [false, false]]));
  });

  test("a keyboard contextmenu (Shift+F10) on a focused class name field isn't prevented", async ({ page }) => {
    await open(page);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }], "right");
    await page.evaluate(() => {
      const g = (window as any).__menus = [] as unknown[];
      window.addEventListener("contextmenu", (e) => g.push([(e.target as Element).className, e.defaultPrevented]));
    });
    await page.locator("#classes .class-name").first().focus();
    await page.keyboard.press("Shift+F10");
    const got = await page.evaluate(() => (window as any).__menus as [string, boolean][]);
    test.skip(got.length === 0, "this Chromium fires no contextmenu for Shift+F10");
    expect(got).toEqual([["class-name", false]]);
  });
});
