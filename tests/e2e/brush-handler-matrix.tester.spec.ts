import { expect, test, type Page } from "@playwright/test";
import { jumpTo, openApp } from "./helpers";
import { ALL, CENTRE, flags, gestures, NONE, openRgb, PAINT, PAN, type Gestures } from "./handlerMatrix";

// Tester pass 4: spec 003 Modes and Rules after the review fix that the brush only re-enables handlers
// it disabled. In Paint and Pan, checks MapLibre's handler flags (dragRotate, doubleClickZoom, boxZoom, dragPan)
// and what a double-click, a Shift-drag and a right drag do. Spec 061 cut the Space, blur and open cases.

type Case = { name: string; steps: (page: Page) => Promise<unknown>; flags: string; gestures: Gestures };

// Only Paint and Pan remain (spec 061); each runs the gestures (about 10 s each).
const CASES: Case[] = [
  { name: "Paint", steps: async () => {}, flags: PAINT, gestures: NONE },
  { name: "Pan", steps: (page) => page.click("#mode-pan"), flags: PAN, gestures: ALL },
];

// independent cases: let them spread over workers
test.describe.configure({ mode: "parallel" });
test.describe("MapLibre handlers across Paint, Pan, Space and opens (tester pass 4)", () => {
  for (const c of CASES) {
    test(`${c.name}: handlers ${c.flags}, gestures as expected, unchanged by them`, async ({ page }) => {
      await openApp(page);
      await jumpTo(page, CENTRE, 7);
      await openRgb(page);
      await c.steps(page);
      expect(await flags(page)).toBe(c.flags);
      expect(await gestures(page)).toEqual(c.gestures);
      expect(await flags(page)).toBe(c.flags);
    });
  }
});
