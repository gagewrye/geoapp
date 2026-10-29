import { expect, test, type Page } from "@playwright/test";
import { jumpTo, openApp } from "./helpers";
import { ALL, blurFocus, CENTRE, flags, gestures, NONE, openOther, openRgb, PAINT, PAN, type Gestures } from "./handlerMatrix";

// Tester pass 4: spec 003 Modes and Rules after the review fix that the brush only re-enables handlers
// it disabled. Each case walks Paint, Pan, Space and raster opens in some order, with or without imagery,
// and checks MapLibre's handler flags (dragRotate, doubleClickZoom, boxZoom, dragPan) and what a
// double-click, a Shift-drag and a right drag do. Outside Paint mode the state must equal the no-imagery
// state (MapLibre's default).

type Case = { name: string; imagery: boolean; steps: (page: Page) => Promise<void>; flags: string; gestures: Gestures; space?: boolean };
const click = (sel: string) => (page: Page) => page.click(sel);
const seq = (...fs: ((page: Page) => Promise<unknown>)[]) => async (page: Page) => { for (const f of fs) await f(page); };
const spaceDown = async (page: Page) => { await blurFocus(page); await page.keyboard.down(" "); };
const spaceUp = (page: Page) => page.keyboard.up(" ");
const blurWindow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("blur")));
const nothing = async () => {};

const CASES: Case[] = [
  { name: "no imagery", imagery: false, steps: nothing, flags: PAN, gestures: ALL },
  { name: "no imagery, Space held", imagery: false, steps: spaceDown, flags: PAN, gestures: ALL, space: true },
  { name: "Paint", imagery: true, steps: nothing, flags: PAINT, gestures: NONE },
  { name: "Pan", imagery: true, steps: click("#mode-pan"), flags: PAN, gestures: ALL },
  { name: "Pan, then Paint", imagery: true, steps: seq(click("#mode-pan"), click("#mode-paint")), flags: PAINT, gestures: NONE },
  { name: "Paint with Space held", imagery: true, steps: spaceDown, flags: PAN, gestures: ALL, space: true },
  { name: "Paint after Space released", imagery: true, steps: seq(spaceDown, spaceUp), flags: PAINT, gestures: NONE },
  { name: "Pan with Space pressed and released", imagery: true, steps: seq(click("#mode-pan"), spaceDown, spaceUp), flags: PAN, gestures: ALL },
  { name: "Space held in Paint, Pan chosen, Space released", imagery: true, steps: seq(spaceDown, click("#mode-pan"), spaceUp), flags: PAN, gestures: ALL },
  { name: "Paint, then another raster opens (it selects Pan: spec 016)", imagery: true, steps: openOther, flags: PAN, gestures: ALL },
  { name: "Space held in Paint, window blur, Space released", imagery: true, steps: seq(spaceDown, blurWindow, spaceUp), flags: PAINT, gestures: NONE },
  { name: "Pan, window blur", imagery: true, steps: seq(click("#mode-pan"), blurWindow), flags: PAN, gestures: ALL },
];

// independent cases of ~13 s each: let them spread over workers
test.describe.configure({ mode: "parallel" });
test.describe("MapLibre handlers across Paint, Pan, Space and opens (tester pass 4)", () => {
  for (const c of CASES) {
    test(`${c.name}: handlers ${c.flags}, gestures as expected, unchanged by them`, async ({ page }) => {
      await openApp(page);
      await jumpTo(page, CENTRE, 7);
      if (c.imagery) await openRgb(page);
      await c.steps(page);
      expect(await flags(page)).toBe(c.flags);
      expect(await gestures(page)).toEqual(c.gestures);
      expect(await flags(page)).toBe(c.flags);
      if (c.space) await spaceUp(page);
    });
  }
});
