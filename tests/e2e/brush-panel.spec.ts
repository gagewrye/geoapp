import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../src/ui/messages";
import { hoverFeatures, jumpTo, labels, message, openApp, openRaster, paintMode, rgbFixture, selectClass, settled, toScreen } from "./helpers";

// Spec 003 criteria 13 (brush size) and 14 (classes).

async function setup(page: Page) {
  await openApp(page);
  await openRaster(page, rgbFixture());
  await expect(message(page)).toHaveText("Raster opened.");
  await paintMode(page);
  await jumpTo(page, [15, 45], 9);
}
const sizeText = (page: Page) => page.locator("#brush-size");
const names = (page: Page) => page.locator("#classes .class-name").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const selected = (page: Page) => page.locator("#classes li").evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"));
const hookClasses = (page: Page) => page.evaluate(() => (window as any).__geoapp.labels.classes.map((c: any) => ({ ...c })));

test.describe("brush size (criterion 13)", () => {
  test("] and + step up and stop at 127; [ and the minus button step down and stop at 1; the text follows", async ({ page }) => {
    await setup(page);
    await expect(sizeText(page)).toHaveText("7");
    await page.locator("#map canvas").focus();
    const up: string[] = [];
    for (let i = 0; i < 3; i++) { await page.keyboard.press("]"); up.push((await sizeText(page).textContent())!); }
    for (let i = 0; i < 3; i++) { await page.click("#brush-larger"); up.push((await sizeText(page).textContent())!); }
    expect(up).toEqual(["15", "31", "63", "127", "127", "127"]);
    const down: string[] = [];
    for (let i = 0; i < 4; i++) { await page.keyboard.press("["); down.push((await sizeText(page).textContent())!); }
    for (let i = 0; i < 4; i++) { await page.click("#brush-smaller"); down.push((await sizeText(page).textContent())!); }
    expect(down).toEqual(["63", "31", "15", "7", "3", "1", "1", "1"]);
  });

  test("a size-15 dab labels 15x15 pixels", async ({ page }) => {
    await setup(page);
    await page.click("#brush-larger");
    await expect(sizeText(page)).toHaveText("15");
    const c = await toScreen(page, [15.005, 45.005]);
    await page.mouse.click(c.x, c.y);
    await settled(page);
    const got = [...(await labels(page)).keys()].map((k) => k.split(",").map(Number) as [number, number]);
    expect(got).toHaveLength(225);
    const cs = got.map((p) => p[0]), rs = got.map((p) => p[1]);
    expect([Math.max(...cs) - Math.min(...cs), Math.max(...rs) - Math.min(...rs)]).toEqual([14, 14]);
    expect([Math.min(...cs) + 7, Math.min(...rs) + 7]).toEqual([500, 499]); // centred on the clicked pixel
  });

  test("typing [, ] or 1 in a class name field changes neither the size nor the selected class", async ({ page }) => {
    await setup(page);
    await selectClass(page, 1);
    const field = page.locator("#classes .class-name").nth(1);
    await field.click();
    await field.press("End");
    await page.keyboard.type("[]1[1]");
    await expect(sizeText(page)).toHaveText("7");
    expect(await selected(page)).toBe(1);
    await expect(field).toHaveValue("Class 2[]1[1]");
  });
});

test.describe("classes (criterion 14)", () => {
  test("starts as Class 1 and Class 2 with Class 1 selected; select by click and by keys 1-9", async ({ page }) => {
    await setup(page);
    expect(await names(page)).toEqual(["Class 1", "Class 2"]);
    expect(await selected(page)).toBe(0);
    await selectClass(page, 1);
    expect(await selected(page)).toBe(1);
    for (let i = 0; i < 8; i++) await page.click("#class-add");
    expect(await names(page)).toHaveLength(10);
    await page.locator("#map canvas").focus();
    for (const k of ["9", "3", "1", "7"]) {
      await page.keyboard.press(k);
      expect(await selected(page)).toBe(Number(k) - 1);
    }
    // a selected class paints with its value
    await page.keyboard.press("3");
    const c = await toScreen(page, [15.005, 45.005]);
    await page.mouse.click(c.x, c.y);
    await settled(page);
    expect(new Set((await labels(page)).values())).toEqual(new Set([3]));
  });

  test("add and rename work; an empty or duplicate name shows the message and keeps the old name", async ({ page }) => {
    await setup(page);
    await page.click("#class-add");
    expect(await names(page)).toEqual(["Class 1", "Class 2", "Class 3"]);
    const field = page.locator("#classes .class-name").nth(2);
    await field.fill("Mangrove");
    await field.press("Enter");
    expect((await hookClasses(page)).map((c: any) => c.name)).toEqual(["Class 1", "Class 2", "Mangrove"]);
    for (const bad of ["", "   ", "Class 1"]) {
      await message(page).evaluate((e) => { e.textContent = ""; });
      await field.fill(bad);
      await field.press("Enter");
      await expect(message(page)).toHaveText(MESSAGES.className);
      await expect(field).toHaveValue("Mangrove");
      expect((await hookClasses(page))[2].name).toBe("Mangrove");
    }
  });

  test("recolouring changes the overlay and the hover colour", async ({ page }) => {
    await setup(page);
    const c = await toScreen(page, [15.005, 45.005]);
    await page.mouse.click(c.x, c.y);
    await settled(page);
    const overlayPixel = () => page.evaluate(() => {
      const { map, labels } = (window as any).__geoapp;
      const key = [...labels.store.tiles.keys()][0];
      // a tile is one or more quads, label-${key} or label-${key}-${i} (spec 018); added on the next animation frame
      const ids = key === undefined ? [] : map.getStyle().layers.map((l: any) => l.id as string).filter((id: string) => id === `label-${key}` || id.startsWith(`label-${key}-`));
      for (const id of ids) {
        const canvas: HTMLCanvasElement = map.getSource(id).getCanvas();
        const d = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]) return Array.from(d.subarray(i, i + 4));
      }
      return null;
    });
    const colour = (await hookClasses(page))[0].colour as string;
    const rgb = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    await expect.poll(overlayPixel).toEqual([...rgb(colour), 255]);
    await page.locator("#classes .class-colour").first().fill("#12ab34");
    await expect.poll(overlayPixel).toEqual([0x12, 0xab, 0x34, 255]);
    const opacities: number[] = await page.evaluate(() => (window as any).__geoapp.map.getStyle().layers.filter((l: any) => l.id.startsWith("label-")).map((l: any) => l.paint["raster-opacity"]));
    expect(opacities.length).toBeGreaterThan(0);
    expect(new Set(opacities)).toEqual(new Set([0.6]));
    await page.mouse.move(c.x + 40, c.y + 20);
    await expect.poll(async () => (await hoverFeatures(page)).length).toBe(1);
    expect(await page.evaluate(() => (window as any).__geoapp.map.getPaintProperty("brush-hover-fill", "fill-color"))).toBe("#12ab34");
  });

  test("Add is disabled at 255 classes", async ({ page }) => {
    test.setTimeout(120_000);
    await setup(page);
    const add = page.locator("#class-add");
    for (let i = 2; i < 254; i++) await add.click();
    await expect(add).toBeEnabled();
    await add.click();
    expect(await page.locator("#classes li").count()).toBe(255);
    await expect(add).toBeDisabled();
    expect((await hookClasses(page)).length).toBe(255);
  });
});
