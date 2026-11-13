import { expect, test, type Page } from "@playwright/test";
import { jumpTo, message, openApp, openRaster, paintMode, rgbFixture } from "./helpers";

// Tester pass 4: spec 003 Strokes / criterion 10. contextmenu is prevented on the map while local
// imagery is open, in every mode, and never on any panel element, whether opened by mouse
// or by keyboard. Spec 061 kept only the Paint case.

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
  test("imagery open, Paint: every map element is prevented, no panel element is", async ({ page }) => {
    await open(page);
    expect(await prevented(page, MAP)).toEqual(all(MAP, true));
    expect(await prevented(page, PANEL)).toEqual(all(PANEL, false));
  });
});
