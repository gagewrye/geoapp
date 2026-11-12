import { expect, test, type Page } from "@playwright/test";
import { editName, jumpTo, message, openApp, openRaster, paintMode, rgbFixture, stroke, toScreen } from "./helpers";

// Tester pass 4: spec 003 Strokes / criterion 10. contextmenu is prevented on the map while local
// imagery is open, in every mode, and never on any panel element, whether opened by mouse
// or by keyboard.

const PANEL = ["#classes .class-name", "#classes input[type=color]", "#classes input[type=radio]", "#mode-paint", "#brush-larger",
  "#brush-size-range", "#label-opacity", "#show-labels", "#class-add", "#open-raster", "#import-labels", "#export-labels", "#message", "#topbar h1"];
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
  await paintMode(page);
  await jumpTo(page, [15, 45], 7);
}

test.describe("contextmenu on every map and panel element (criterion 10, tester pass 4)", () => {
  test("no imagery: no panel element is prevented", async ({ page }) => {
    await openApp(page);
    expect(await prevented(page, PANEL.filter((s) => !s.startsWith("#classes") && !s.startsWith("#mode") && !s.startsWith("#brush") && s !== "#class-add")))
      .toEqual(all(["#label-opacity", "#show-labels", "#open-raster", "#import-labels", "#export-labels", "#message", "#topbar h1"], false));
  });

  const states: [string, (page: Page) => Promise<void>][] = [
    ["Paint", async () => {}],
    ["Pan", async (page) => { await page.click("#mode-pan"); }],
    ["Space held", async (page) => { await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.down(" "); }],
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

  test("a keyboard contextmenu (Shift+F10) on a focused class rename field isn't prevented", async ({ page }) => {
    await open(page);
    const c = await toScreen(page, [15.005, 45.005]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }]);
    await stroke(page, [c, { x: c.x + 40, y: c.y }], "right");
    await page.evaluate(() => {
      const g = (window as any).__menus = [] as unknown[];
      window.addEventListener("contextmenu", (e) => g.push([(e.target as Element).className, e.defaultPrevented]));
    });
    await editName(page, 0);
    await page.keyboard.press("Shift+F10");
    const got = await page.evaluate(() => (window as any).__menus as [string, boolean][]);
    test.skip(got.length === 0, "this Chromium fires no contextmenu for Shift+F10");
    expect(got).toEqual([["class-name-edit", false]]);
  });
});
