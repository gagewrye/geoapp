import { expect, test, type Page } from "@playwright/test";
import { MAX_LAT } from "../../src/core/types";
import { MESSAGES } from "../../src/ui/messages";
import { clickAt, drawPolygon, jumpDrag, jumpTo, message, openApp, renderedPolygons, setMode, snapshot, toLngLat, toScreen } from "./helpers";

for (const sign of [1, -1]) {
  const hemi = sign > 0 ? "north" : "south";
  test.describe(`latitude limit, ${hemi}, on the globe (criterion 15)`, () => {
    test.beforeEach(async ({ page }) => {
      await openApp(page);
      await jumpTo(page, [0, sign * 80], 1.5);
      expect(await page.evaluate(() => (window as any).__geoapp.map.getProjection().type)).toBe("globe");
    });

    test("adding a vertex beyond MAX_LAT is blocked", async ({ page }) => {
      const beyond = await toScreen(page, [0, sign * 88]);
      const [ll] = await toLngLat(page, [beyond]);
      expect(beyond.y).toBeGreaterThan(0); // on the canvas, so the click really lands beyond the limit
      expect(Math.abs(ll![1])).toBeGreaterThan(MAX_LAT);
      await setMode(page, "draw");
      await clickAt(page, await toScreen(page, [-10, sign * 78]));
      await clickAt(page, await toScreen(page, [10, sign * 78]));
      await clickAt(page, beyond);
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      for (const f of await snapshot(page)) for (const [, lat] of f.geometry.coordinates[0]) expect(Math.abs(lat)).toBeLessThan(MAX_LAT);
    });

    test("finishing a valid polygon after a blocked vertex clears the message", async ({ page }) => {
      const first = await toScreen(page, [-10, sign * 78]);
      await setMode(page, "draw");
      await clickAt(page, first);
      await clickAt(page, await toScreen(page, [10, sign * 78]));
      await clickAt(page, await toScreen(page, [0, sign * 88]));
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      await clickAt(page, await toScreen(page, [0, sign * 82]));
      await clickAt(page, first);
      expect(await snapshot(page)).toHaveLength(1);
      await expect(message(page)).toHaveText("");
    });

    test("dragging a vertex beyond MAX_LAT is blocked and nothing is clamped", async ({ page }) => {
      const corners: [number, number][] = [[-10, sign * 76], [10, sign * 76], [10, sign * 82], [-10, sign * 82]];
      await drawPolygon(page, await Promise.all(corners.map((p) => toScreen(page, p))), "ice");
      const before = await snapshot(page);
      expect(before).toHaveLength(1);
      await setMode(page, "select");
      await clickAt(page, await toScreen(page, [0, sign * 79]));
      const ring: [number, number][] = before[0].geometry.coordinates[0];
      const v = ring.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
      const target = await toScreen(page, [v[0], sign * 88]);
      expect(target.y).toBeGreaterThan(0);
      // Jump straight past the limit so the only drag update is the blocked one.
      await jumpDrag(page, await toScreen(page, v), target);
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      const after = await snapshot(page);
      expect(after.map((f) => f.geometry)).toEqual(before.map((f) => f.geometry));
      for (const [, lat] of after[0].geometry.coordinates[0]) expect(Math.abs(lat)).not.toBe(MAX_LAT);
    });
  });
}

type Xy = { x: number; y: number };
type Ring = [number, number][];
const ringOf = async (page: Page): Promise<Ring> => (await snapshot(page))[0].geometry.coordinates[0];
const maxAbsLat = (ring: Ring) => Math.max(...ring.map(([, lat]) => Math.abs(lat)));

/** Smooth drag; `held` runs with the button still down, after the last move. */
async function drag(page: Page, a: Xy, b: Xy, held: () => Promise<void> = async () => {}) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 60, a.y + ((b.y - a.y) * i) / 60);
  await held();
  await page.mouse.up();
  await page.waitForTimeout(80);
}

for (const sign of [1, -1]) {
  const hemi = sign > 0 ? "north" : "south";
  test.describe(`latitude limit, ${hemi}: blocked drags snap back (criterion 15)`, () => {
    // Large enough that the body point is > 40 px (terra-draw's grab distance) from every handle.
    const corners: Ring = [[-40, sign * 60], [40, sign * 60], [40, sign * 82], [-40, sign * 82]];
    const body: [number, number] = [0, sign * 72];
    const view = async (page: Page) => jumpTo(page, [0, sign * 75], 1.5); // also waits for idle

    test.beforeEach(async ({ page }) => {
      await openApp(page);
      await view(page);
      await drawPolygon(page, await Promise.all(corners.map((p) => toScreen(page, p))), "ice");
      await setMode(page, "select");
      await clickAt(page, await toScreen(page, body));
    });

    const polarMidpoint = async (page: Page): Promise<[number, number]> => {
      const mids: Ring = (await page.evaluate(() => (window as any).__geoapp.draw.getSnapshot()))
        .filter((f: any) => f.properties.midPoint).map((f: any) => f.geometry.coordinates);
      return mids.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
    };
    const edits: Record<string, { start: (page: Page) => Promise<[number, number]>; whileHeld: (before: Ring, now: Ring) => void }> = {
      "a vertex": {
        start: async () => [40, sign * 82],
        whileHeld: (before, now) => expect(now.filter((v, i) => v[1] !== before[i]![1]).length).toBeGreaterThan(0),
      },
      "a midpoint (adding a vertex)": {
        start: polarMidpoint,
        whileHeld: (before, now) => expect(now).toHaveLength(before.length + 1), // a midpoint, not a corner
      },
      "the polygon": {
        start: async () => body,
        whileHeld: (before, now) => now.forEach(([, lat], i) => expect(Math.abs(lat)).toBeGreaterThan(Math.abs(before[i]![1]))),
      },
    };
    for (const [edit, { start, whileHeld }] of Object.entries(edits)) {
      test(`dragging ${edit} beyond MAX_LAT leaves the stored and rendered polygon unchanged`, async ({ page }) => {
        const before = await ringOf(page);
        const from = await start(page);
        const target = await toScreen(page, [from[0], sign * 88]);
        expect(target.y).toBeGreaterThan(0);
        await drag(page, await toScreen(page, from), target, async () => whileHeld(before, await ringOf(page)));
        await expect(message(page)).toHaveText(MESSAGES.latitude);
        expect(await snapshot(page)).toHaveLength(1);
        expect(await ringOf(page)).toEqual(before);
        // queryRenderedFeatures finds nothing on the globe below about zoom 3; at zoom 3 it returns
        // tile-clipped pieces, so compare the polar extent over all of them.
        await jumpTo(page, [0, sign * 78], 3);
        const pieces: Ring[] = (await renderedPolygons(page)).flatMap((f) => f.coordinates);
        expect(pieces.length).toBeGreaterThan(0);
        expect(Math.max(...pieces.map(maxAbsLat))).toBeCloseTo(maxAbsLat(before), 1);
      });
    }

    test("valid drags near the limit are stored, also after a blocked one", async ({ page }) => {
      const blocked = await ringOf(page);
      await drag(page, await toScreen(page, [40, sign * 82]), await toScreen(page, [40, sign * 88]));
      expect(await ringOf(page)).toEqual(blocked);
      await expect(message(page)).toHaveText(MESSAGES.latitude);

      await drag(page, await toScreen(page, [40, sign * 82]), await toScreen(page, [40, sign * 84]));
      await expect(message(page)).toHaveText(""); // a successful edit clears the stale block message
      const moved = await ringOf(page);
      expect(moved).toHaveLength(blocked.length);
      expect(maxAbsLat(moved)).toBeGreaterThan(83);
      expect(maxAbsLat(moved)).toBeLessThan(MAX_LAT);

      await drag(page, await toScreen(page, body), await toScreen(page, [0, sign * 73]));
      const shifted = await ringOf(page);
      shifted.forEach(([, lat], i) => expect(Math.abs(lat)).toBeGreaterThan(Math.abs(moved[i]![1])));
      expect(maxAbsLat(shifted)).toBeLessThan(MAX_LAT);
      await expect(message(page)).toHaveText("");
    });
  });
}
