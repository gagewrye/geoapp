import { expect, test, type Page } from "@playwright/test";
import { message, openApp, openRaster, rgbFixture } from "./helpers";

// Spec 062 criterion 4: grouping by label kind moves nothing. One page measures the tool strip and panel
// as built, then again with scope 2 undone in place, so no fixture or platform's font metrics come into it.
test.use({ viewport: { width: 1280, height: 720 } });

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
}

test("after open, every element of the tool strip and panel sits where it does with scope 2's wrappers undone", async ({ page }) => {
  await setup(page);
  const { compared, off } = await page.evaluate(() => {
    const ADDED = ["kinds", "tools-mask", "brush-group"];
    const els = ["tools", "side"].flatMap((r) => [...document.getElementById(r)!.querySelectorAll("*")]).filter((e) => !ADDED.includes(e.id));
    const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const wrapped = els.map(rect);
    for (const id of ["tools-mask", "brush-group"]) { const w = document.getElementById(id)!; w.replaceWith(...w.childNodes); }
    document.getElementById("kinds")!.remove();
    const view = document.getElementById("mask-view")!;
    view.removeAttribute("id");
    view.removeAttribute("data-kind");
    const name = (e: Element) => e.id || `${e.tagName.toLowerCase()} in #${e.closest("[id]")?.id}`;
    const off: string[] = [];
    els.forEach((e, i) => {
      const now = rect(e), was = wrapped[i]!;
      for (const k of ["x", "y", "width", "height"] as const) if (Math.abs(now[k] - was[k]) > 0.5) off.push(`${name(e)} ${k}: wrapped ${was[k]}, unwrapped ${now[k]}`);
    });
    return { compared: els.length, off };
  });
  expect(compared).toBeGreaterThan(30); // the strip's 15 controls and the panel's rows, not an empty query
  expect(off).toEqual([]);
});

test("after open, #kinds is hidden", async ({ page }) => {
  await setup(page);
  await expect(page.locator("#kinds")).toBeAttached();
  await expect(page.locator("#kinds")).toBeHidden();
});
