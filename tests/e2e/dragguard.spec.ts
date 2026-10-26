import { expect, test, type Page } from "@playwright/test";
import { MAX_LAT } from "../../src/core/types";
import { checkRing, normalizeLon } from "../../src/core/ring";
import { MESSAGES } from "../../src/ui/messages";
import { clickAt, drawPolygon, jumpTo, message, openApp, renderedPolygons, setMode, snapshot, toScreen, type LngLat } from "./helpers";

// Tester additions: try to break the select-mode drag guard (criteria 14 and 15).

type Xy = { x: number; y: number };
type Ring = LngLat[];
const rings = async (page: Page): Promise<Ring[]> => (await snapshot(page)).map((f) => f.geometry.coordinates[0]);
const clearMessage = (page: Page) => page.evaluate(() => { document.getElementById("message")!.textContent = ""; });

/** Pointer path a -> b in `steps` moves with the button held; optionally no release. */
async function press(page: Page, a: Xy) { await page.mouse.move(a.x, a.y); await page.mouse.down(); }
async function moveTo(page: Page, a: Xy, b: Xy, steps = 30) {
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
}

for (const sign of [1, -1]) {
  const hemi = sign > 0 ? "north" : "south";
  test.describe(`drag guard, ${hemi} pole (criterion 15, tester)`, () => {
    // Same geometry as latitude.spec.ts: big enough that handles and the body are > 40 px apart.
    const corners: Ring = [[-40, sign * 60], [40, sign * 60], [40, sign * 82], [-40, sign * 82]];
    const body: LngLat = [0, sign * 72];
    const vertex: LngLat = [40, sign * 82];

    test.beforeEach(async ({ page }) => {
      await openApp(page);
      await jumpTo(page, [0, sign * 75], 1.5);
      await drawPolygon(page, await Promise.all(corners.map((p) => toScreen(page, p))), "ice");
      await setMode(page, "select");
      await clickAt(page, await toScreen(page, body));
    });

    test("a blocked vertex drag released outside the canvas leaves the stored polygon unchanged, also after the pointer returns", async ({ page }) => {
      const [before] = await rings(page);
      const v = await toScreen(page, vertex);
      const beyond = await toScreen(page, [vertex[0], sign * 88]);
      const panel = await page.locator("#panel").boundingBox();
      const outside = { x: panel!.x + panel!.width / 2, y: beyond.y };
      await press(page, v);
      await moveTo(page, v, beyond);
      await moveTo(page, beyond, outside);
      expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("#panel") !== null, [outside.x, outside.y])).toBe(true);
      await page.mouse.up();
      await page.waitForTimeout(100);
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      expect(await rings(page), "right after release outside the canvas").toEqual([before]);
      // The button is up: moving back over the map must not keep editing the polygon.
      await moveTo(page, outside, await toScreen(page, [20, sign * 70]), 20);
      await page.waitForTimeout(100);
      expect(await rings(page), "after hovering back over the map with the button up").toEqual([before]);
    });

    test("a blocked drag released outside the canvas: hovering back past the limit must not leave a vertex at the limit", async ({ page }) => {
      const [before] = await rings(page);
      const v = await toScreen(page, vertex);
      const beyond = await toScreen(page, [vertex[0], sign * 88]);
      const panel = await page.locator("#panel").boundingBox();
      const outside = { x: panel!.x + panel!.width / 2, y: beyond.y };
      await press(page, v); await moveTo(page, v, beyond); await moveTo(page, beyond, outside); await page.mouse.up();
      await page.waitForTimeout(100);
      expect(await rings(page), "right after release outside the canvas").toEqual([before]);
      // button up: back over the map, through valid latitudes to beyond the limit, no click
      await moveTo(page, outside, v, 20);
      await moveTo(page, v, beyond, 30);
      await page.waitForTimeout(100);
      const after = await rings(page);
      expect(after, `polar vertex ended at ${JSON.stringify(after[0]!.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a)))}`).toEqual([before]);
    });

    test("a blocked vertex drag ended by pointercancel (touch) leaves the stored polygon unchanged", async ({ page }) => {
      const [before] = await rings(page);
      const cdp = await page.context().newCDPSession(page);
      const v = await toScreen(page, vertex);
      const beyond = await toScreen(page, [vertex[0], sign * 88]);
      const touch = (type: "touchStart" | "touchMove" | "touchCancel", p?: Xy) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
      await touch("touchStart", v);
      for (let i = 1; i <= 30; i++) await touch("touchMove", { x: v.x + ((beyond.x - v.x) * i) / 30, y: v.y + ((beyond.y - v.y) * i) / 30 });
      const during = (await rings(page))[0]!;
      await touch("touchCancel");
      await page.waitForTimeout(100);
      // Guard against a vacuous pass: the touch really dragged the vertex before the cancel.
      expect(during, "touch drag moved the vertex").not.toEqual(before);
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      expect(await rings(page), "after pointercancel").toEqual([before]);
      // and after the next, unrelated tap on empty map
      await clickAt(page, await toScreen(page, [0, sign * 50]));
      expect(await rings(page), "after the next tap").toEqual([before]);
    });

    test("rapid successive drags (blocked, valid, blocked) with no pause keep only the valid edit", async ({ page }) => {
      const [before] = await rings(page);
      const v = await toScreen(page, vertex);
      const beyond = await toScreen(page, [vertex[0], sign * 88]);
      const ok = await toScreen(page, [vertex[0], sign * 84]);
      await press(page, v); await moveTo(page, v, beyond, 15); await page.mouse.up();
      expect(await rings(page)).toEqual([before]);
      await press(page, v); await moveTo(page, v, ok, 15); await page.mouse.up();
      const [valid] = await rings(page);
      expect(valid).not.toEqual(before);
      expect(Math.max(...valid!.map(([, lat]) => Math.abs(lat)))).toBeGreaterThan(83);
      const v2 = await toScreen(page, valid!.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a)));
      await press(page, v2); await moveTo(page, v2, beyond, 15); await page.mouse.up();
      await page.waitForTimeout(100);
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      expect(await rings(page)).toEqual([valid]);
    });

    test("a drag that goes beyond the limit and comes back before release is still blocked (stored polygon unchanged)", async ({ page }) => {
      const [before] = await rings(page);
      const v = await toScreen(page, vertex);
      const beyond = await toScreen(page, [vertex[0], sign * 88]);
      const back = await toScreen(page, [vertex[0], sign * 80]);
      await press(page, v); await moveTo(page, v, beyond); await moveTo(page, beyond, back); await page.mouse.up();
      await page.waitForTimeout(100);
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      expect(await rings(page)).toEqual([before]);
    });

    test("the polygon body dragged beyond the limit with one big jump snaps back and nothing is clamped", async ({ page }) => {
      const [before] = await rings(page);
      const b = await toScreen(page, body);
      const far = await toScreen(page, [0, sign * 87]);
      await press(page, b); await page.mouse.move(b.x, b.y + sign * -3); await page.mouse.move(far.x, far.y); await page.mouse.up();
      await page.waitForTimeout(100);
      await expect(message(page)).toHaveText(MESSAGES.latitude);
      expect(await rings(page)).toEqual([before]);
      for (const [, lat] of (await rings(page))[0]!) expect(Math.abs(lat)).not.toBe(MAX_LAT);
    });
  });
}

test.describe("drag guard with several polygons (criterion 15, tester)", () => {
  const west: Ring = [[-45, 60], [-8, 60], [-8, 82], [-45, 82]];
  const east: Ring = [[8, 60], [45, 60], [45, 82], [8, 82]];

  test("a blocked drag on one polygon leaves every polygon unchanged; valid edits to another survive", async ({ page }) => {
    await openApp(page);
    await jumpTo(page, [0, 75], 1.5);
    await drawPolygon(page, await Promise.all(west.map((p) => toScreen(page, p))), "a");
    await drawPolygon(page, await Promise.all(east.map((p) => toScreen(page, p))), "b");
    await setMode(page, "select");
    const start = await rings(page);
    expect(start).toHaveLength(2);

    // blocked drag on the west polygon
    await clickAt(page, await toScreen(page, [-26, 70]));
    let a = await toScreen(page, [-45, 82]);
    await press(page, a); await moveTo(page, a, await toScreen(page, [-45, 88])); await page.mouse.up();
    await page.waitForTimeout(100);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page)).toEqual(start);
    await clearMessage(page);

    // valid drag on the east polygon
    await clickAt(page, await toScreen(page, [26, 70]));
    a = await toScreen(page, [45, 82]);
    await press(page, a); await moveTo(page, a, await toScreen(page, [45, 84])); await page.mouse.up();
    await page.waitForTimeout(100);
    const edited = await rings(page);
    expect(edited[0]).toEqual(start[0]);
    expect(edited[1]).not.toEqual(start[1]);
    await expect(message(page)).toHaveText("");

    // blocked drag on the east polygon keeps its valid edit and the west polygon
    const polar = edited[1]!.reduce((p, q) => (q[1] > p[1] ? q : p));
    a = await toScreen(page, polar);
    await press(page, a); await moveTo(page, a, await toScreen(page, [polar[0], 88])); await page.mouse.up();
    await page.waitForTimeout(100);
    await expect(message(page)).toHaveText(MESSAGES.latitude);
    expect(await rings(page)).toEqual(edited);
  });
});

test.describe("deleting a vertex (criterion 14 'editing', tester extra)", () => {
  test("deleting a vertex so a new edge spans more than 180 degrees is blocked, nothing invalid stored or rendered", async ({ page }) => {
    await openApp(page);
    await jumpTo(page, [0, 75], 1);
    // edges of 91 degrees; deleting [0, 66] joins -91 and 91 (182 degrees): "antimeridian" per checkRing
    // Drawing closes the ring after each click, so -91 and 91 can't both be clicked; draw 60, then drag it to 91.
    const ring: Ring = [[-91, 70], [0, 66], [60, 70], [0, 84]];
    await drawPolygon(page, await Promise.all(ring.map((p) => toScreen(page, p))), "a");
    await setMode(page, "select");
    await clickAt(page, await toScreen(page, [0, 74]));
    const sixty = await toScreen(page, (await rings(page))[0]!.find(([lon]) => lon > 30)!);
    await press(page, sixty); await moveTo(page, sixty, await toScreen(page, [91, 70])); await page.mouse.up();
    await page.waitForTimeout(100);
    const [before] = await rings(page);
    expect(before).toHaveLength(5);
    expect(Math.max(...before!.map(([lon]) => lon))).toBeGreaterThan(90.5); // vertex really at ~91
    expect(Math.max(...before!.map(([lon]) => lon)) - Math.min(...before!.map(([lon]) => lon))).toBeGreaterThan(180);
    await expect(message(page)).toHaveText("");
    const del = await toScreen(page, before!.reduce((p, q) => (q[1] < p[1] ? q : p)));
    await page.mouse.click(del.x, del.y, { button: "right" });
    await page.waitForTimeout(150);
    const valid = (r: Ring) => checkRing(r.map(([x, y]) => [normalizeLon(x), y])) === null;
    for (const r of await rings(page)) expect(valid(r), JSON.stringify(r)).toBe(true);
    for (const f of await renderedPolygons(page)) for (const r of f.coordinates) expect(valid(r), JSON.stringify(r)).toBe(true);
    expect(await rings(page)).toEqual([before]);
  });
});
