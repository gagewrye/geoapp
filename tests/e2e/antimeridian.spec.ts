import { expect, test, type Page } from "@playwright/test";
import { checkRing, normalizeLon } from "../../src/core/ring";
import { MESSAGES } from "../../src/ui/messages";
import { clickAt, dragFromTo, drawPolygon, jumpTo, message, openApp, renderedPolygons, setMode, snapshot, toScreen } from "./helpers";

const valid = (ring: [number, number][]) => checkRing(ring.map(([x, y]) => [normalizeLon(x), y])) === null;

/** Nothing invalid is stored or rendered. */
async function expectNothingInvalid(page: Page) {
  for (const f of await snapshot(page)) expect(valid(f.geometry.coordinates[0]), JSON.stringify(f.geometry)).toBe(true);
  for (const f of await renderedPolygons(page)) for (const ring of f.coordinates) expect(valid(ring), JSON.stringify(ring)).toBe(true);
}

for (const zoom of [3, 14]) {
  test.describe(`antimeridian at zoom ${zoom} (criterion 14)`, () => {
    let c: { x: number; y: number };
    // A valid polygon just west of 180: x from c-120 to c-30 px.
    const west = () => [{ x: c.x - 120, y: c.y - 40 }, { x: c.x - 30, y: c.y - 40 }, { x: c.x - 30, y: c.y + 40 }, { x: c.x - 120, y: c.y + 40 }];

    test.beforeEach(async ({ page }) => {
      await openApp(page);
      await jumpTo(page, [180, 0], zoom);
      c = await toScreen(page, [180, 0]);
    });

    test("drawing a vertex across 180 is blocked", async ({ page }) => {
      await setMode(page, "draw");
      await clickAt(page, { x: c.x - 120, y: c.y - 40 });
      await clickAt(page, { x: c.x - 30, y: c.y - 40 });
      await clickAt(page, { x: c.x + 80, y: c.y + 40 });
      await expect(message(page)).toHaveText(MESSAGES.antimeridian);
      await expectNothingInvalid(page);
    });

    const edits = {
      "dragging a vertex": () => ({ x: c.x - 30, y: c.y - 40 }),
      "dragging a midpoint (adding a vertex)": () => ({ x: c.x - 30, y: c.y }),
      "dragging the polygon": () => ({ x: c.x - 75, y: c.y + 10 }),
    };
    for (const [edit, start] of Object.entries(edits)) {
      test(`${edit} across 180 is blocked and nothing invalid is stored or rendered`, async ({ page }) => {
        await drawPolygon(page, west(), "a");
        expect(await snapshot(page)).toHaveLength(1);
        await setMode(page, "select");
        await clickAt(page, { x: c.x - 75, y: c.y });
        const from = start();
        await dragFromTo(page, from, { x: from.x + 110, y: from.y });
        await expect(message(page)).toHaveText(MESSAGES.antimeridian);
        // the shape follows the cursor up to the last valid position; nothing past 180 is kept
        expect(await snapshot(page)).toHaveLength(1);
        await expectNothingInvalid(page);
      });
    }

    test("one polygon on each side of 180 is stored and rendered", async ({ page }) => {
      await drawPolygon(page, west(), "a");
      await drawPolygon(page, [{ x: c.x + 30, y: c.y - 40 }, { x: c.x + 120, y: c.y - 40 }, { x: c.x + 120, y: c.y + 40 }, { x: c.x + 30, y: c.y + 40 }], "b");
      await expect(message(page)).toHaveText("");
      const stored = await snapshot(page);
      expect(stored).toHaveLength(2);
      await jumpTo(page, [180, 0], zoom);
      const rings: [number, number][][] = (await renderedPolygons(page)).map((f) => f.coordinates[0]);
      const side = (r: [number, number][]) => Math.sign(normalizeLon(r[0]![0]));
      expect(rings.some((r) => side(r) > 0)).toBe(true); // west of 180 (positive longitudes)
      expect(rings.some((r) => side(r) < 0)).toBe(true); // east of 180 (negative longitudes)
      await expectNothingInvalid(page);
    });
  });
}
