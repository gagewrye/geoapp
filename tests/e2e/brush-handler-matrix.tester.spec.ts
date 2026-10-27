import { expect, test, type Page } from "@playwright/test";
import { jumpTo, openApp, toScreen } from "./helpers";
import { ALL, AREA, blurFocus, CENTRE, flags, gestures, NONE, openOther, openRgb, PAINT, PAN, type Gestures } from "./handlerMatrix";

// Tester pass 4: spec 003 Modes and Rules (the AOI tool switches the brush to Pan, ADR 0009) after the
// review fix that the brush only re-enables handlers it disabled. Each case walks Paint, Pan, Space and
// spec 002's area tool in some order, with or without imagery, and checks MapLibre's handler flags
// (dragRotate, doubleClickZoom, boxZoom, dragPan) and what a double-click, a Shift-drag and a right drag
// do. Outside Paint mode the state must equal the no-imagery state of the same tool (MapLibre's default,
// or terra-draw's rectangle mode: no double-click zoom, as on spec 002).
const AREA_G: Gestures = { dblclick: false, boxZoom: true, rotate: true };

type Case = { name: string; imagery: boolean; steps: (page: Page) => Promise<void>; flags: string; gestures: Gestures; space?: boolean };
const click = (sel: string) => (page: Page) => page.click(sel);
const seq = (...fs: ((page: Page) => Promise<unknown>)[]) => async (page: Page) => { for (const f of fs) await f(page); };
const spaceDown = async (page: Page) => { await blurFocus(page); await page.keyboard.down(" "); };
const spaceUp = (page: Page) => page.keyboard.up(" ");
const drawRect = async (page: Page) => {
  const a = await toScreen(page, [14.6, 45.4]), b = await toScreen(page, [15.4, 44.6]);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.click(b.x, b.y);
  await jumpTo(page, CENTRE, 7);
};
const blurWindow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("blur")));
const nothing = async () => {};

const CASES: Case[] = [
  { name: "no imagery", imagery: false, steps: nothing, flags: PAN, gestures: ALL },
  { name: "no imagery, area tool", imagery: false, steps: click("#aef-draw"), flags: AREA, gestures: AREA_G },
  { name: "no imagery, area tool, Space pressed and released", imagery: false, steps: seq(click("#aef-draw"), spaceDown, spaceUp), flags: AREA, gestures: AREA_G },
  { name: "no imagery, Space held", imagery: false, steps: spaceDown, flags: PAN, gestures: ALL, space: true },
  { name: "Paint (default on open)", imagery: true, steps: nothing, flags: PAINT, gestures: NONE },
  { name: "Pan", imagery: true, steps: click("#mode-pan"), flags: PAN, gestures: ALL },
  { name: "Pan, then Paint", imagery: true, steps: seq(click("#mode-pan"), click("#mode-paint")), flags: PAINT, gestures: NONE },
  { name: "Paint with Space held", imagery: true, steps: spaceDown, flags: PAN, gestures: ALL, space: true },
  { name: "Paint after Space released", imagery: true, steps: seq(spaceDown, spaceUp), flags: PAINT, gestures: NONE },
  { name: "Pan with Space pressed and released", imagery: true, steps: seq(click("#mode-pan"), spaceDown, spaceUp), flags: PAN, gestures: ALL },
  { name: "area tool", imagery: true, steps: click("#aef-draw"), flags: AREA, gestures: AREA_G },
  { name: "area tool, then Pan", imagery: true, steps: seq(click("#aef-draw"), click("#mode-pan")), flags: AREA, gestures: AREA_G },
  { name: "area tool from Pan", imagery: true, steps: seq(click("#mode-pan"), click("#aef-draw")), flags: AREA, gestures: AREA_G },
  { name: "area tool, then Paint (F12)", imagery: true, steps: seq(click("#aef-draw"), click("#mode-paint")), flags: PAINT, gestures: NONE },
  { name: "area tool, Paint, then Pan", imagery: true, steps: seq(click("#aef-draw"), click("#mode-paint"), click("#mode-pan")), flags: PAN, gestures: ALL },
  { name: "area drawn, then Paint", imagery: true, steps: seq(click("#aef-draw"), drawRect, click("#mode-paint")), flags: PAINT, gestures: NONE },
  { name: "area drawn, tool still active", imagery: true, steps: seq(click("#aef-draw"), drawRect), flags: AREA, gestures: AREA_G },
  { name: "area tool, Space pressed and released", imagery: true, steps: seq(click("#aef-draw"), spaceDown, spaceUp), flags: AREA, gestures: AREA_G },
  { name: "area tool, Space held", imagery: true, steps: seq(click("#aef-draw"), spaceDown), flags: AREA, gestures: AREA_G, space: true },
  { name: "Space held in Paint, area tool chosen, Space released", imagery: true, steps: seq(spaceDown, click("#aef-draw"), spaceUp), flags: AREA, gestures: AREA_G },
  { name: "Space held in Paint, Pan chosen, Space released", imagery: true, steps: seq(spaceDown, click("#mode-pan"), spaceUp), flags: PAN, gestures: ALL },
  { name: "area tool, Paint, area tool, Paint", imagery: true,
    steps: seq(click("#aef-draw"), click("#mode-paint"), click("#aef-draw"), click("#mode-paint")), flags: PAINT, gestures: NONE },
  { name: "area tool (no imagery), then a raster opens", imagery: false, steps: seq(click("#aef-draw"), openRgb), flags: PAINT, gestures: NONE },
  { name: "area tool (no imagery), raster opens, then Pan", imagery: false, steps: seq(click("#aef-draw"), openRgb, click("#mode-pan")), flags: PAN, gestures: ALL },
  { name: "area tool, then another raster opens", imagery: true, steps: seq(click("#aef-draw"), openOther), flags: PAINT, gestures: NONE },
  { name: "area tool, another raster opens, then Pan", imagery: true, steps: seq(click("#aef-draw"), openOther, click("#mode-pan")), flags: PAN, gestures: ALL },
  { name: "Pan, then another raster opens", imagery: true, steps: seq(click("#mode-pan"), openOther), flags: PAINT, gestures: NONE },
  { name: "Space held in Paint, window blur, Space released", imagery: true, steps: seq(spaceDown, blurWindow, spaceUp), flags: PAINT, gestures: NONE },
  { name: "area tool, window blur", imagery: true, steps: seq(click("#aef-draw"), blurWindow), flags: AREA, gestures: AREA_G },
  { name: "Pan, window blur", imagery: true, steps: seq(click("#mode-pan"), blurWindow), flags: PAN, gestures: ALL },
];

// 30 independent cases of ~13 s each: let them spread over workers
test.describe.configure({ mode: "parallel" });
test.describe("MapLibre handlers across Paint, Pan, Space, area tool and opens (tester pass 4)", () => {
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
