import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../../../src/ui/messages";
import { initClassPanel } from "../../../src/ui/classPanel";
import { FakeDocument, type FakeElement } from "../helpers/fakeDom";

// Spec 036 criterion 8.
let doc: FakeDocument;
beforeEach(() => { doc = new FakeDocument(); vi.stubGlobal("document", doc); });
afterEach(() => { vi.unstubAllGlobals(); });

function setup() {
  let locked = false;
  const list = doc.createElement("ul"), add = doc.createElement("button");
  const d = { say: vi.fn(), recoloured: vi.fn(), selectedChanged: vi.fn(), edited: vi.fn() };
  const panel = initClassPanel({ list: list as unknown as HTMLElement, add: add as unknown as HTMLButtonElement, locked: () => locked, ...d });
  return { list, add, panel, ...d, lock: (on: boolean) => { locked = on; panel.render(); } };
}
const row = (list: FakeElement, i: number) => list.querySelectorAll("li")[i]!;
function rename(list: FakeElement, i: number, name: string): void {
  row(list, i).querySelector(".class-rename")!.click();
  const field = row(list, i).querySelector(".class-name-edit");
  if (!field) return;
  field.value = name;
  field.dispatch("keydown", { key: "Enter" });
}
const recolour = (list: FakeElement, i: number, colour: string) => {
  const sw = row(list, i).querySelector(".class-colour")!;
  sw.value = colour;
  sw.dispatch("input");
};

describe("initClassPanel", () => {
  it("starts with two classes, Class 1 selected; select marks the row and reports it", () => {
    const { list, panel, selectedChanged } = setup();
    expect(panel.classes().map((c) => c.name)).toEqual(["Class 1", "Class 2"]);
    expect(panel.selected()).toBe(0);
    row(list, 1).querySelector(".class-name")!.click();
    expect(panel.selected()).toBe(1);
    expect(row(list, 1).getAttribute("aria-selected")).toBe("true");
    expect(selectedChanged).toHaveBeenCalledTimes(1);
  });

  it("setClasses (spec 047's Apply class map) swaps the list, keeps the selection and is a class edit: recoloured and edited", () => {
    const { list, panel, recoloured, edited } = setup();
    panel.select(1);
    panel.setClasses([{ name: "Sand", colour: "#000000" }, { name: "Water", colour: "#0000ff" }]);
    expect(panel.classes()).toEqual([{ name: "Sand", colour: "#000000" }, { name: "Water", colour: "#0000ff" }]);
    expect(panel.selected()).toBe(1);
    expect(row(list, 1).querySelector(".class-name")!.textContent).toBe("Water");
    expect([recoloured.mock.calls.length, edited.mock.calls.length]).toEqual([1, 1]);
  });

  it("replace swaps the list and clamps an out-of-range selected to 0", () => {
    const { list, panel } = setup();
    panel.select(1);
    panel.replace([{ name: "Water", colour: "#0000ff" }]);
    expect(panel.selected()).toBe(0);
    expect(list.querySelectorAll("li")).toHaveLength(1);
    panel.replace([{ name: "a", colour: "#000000" }, { name: "b", colour: "#ffffff" }], 5);
    expect(panel.selected()).toBe(0);
    panel.replace([{ name: "a", colour: "#000000" }, { name: "b", colour: "#ffffff" }], 1);
    expect(panel.selected()).toBe(1);
    expect(row(list, 1).getAttribute("aria-selected")).toBe("true");
  });

  it("recolour changes the class and calls recoloured; rename checks the name and says why it refused", () => {
    const { list, panel, recoloured, say, edited } = setup();
    recolour(list, 1, "#12ab34");
    expect(panel.classes()[1]!.colour).toBe("#12ab34");
    expect(recoloured).toHaveBeenCalledTimes(1);
    rename(list, 1, " Water ");
    expect(panel.classes()[1]!.name).toBe("Water");
    expect(edited).toHaveBeenCalled();
    rename(list, 1, "Class 1");
    expect(say).toHaveBeenCalledWith(MESSAGES.className, "error");
    expect(panel.classes()[1]!.name).toBe("Water");
    expect(row(list, 1).querySelector(".class-name")!.textContent).toBe("Water");
  });

  it("Add appends a class and disables itself at 255", () => {
    const { add, panel, edited } = setup();
    add.click();
    expect(panel.classes().map((c) => c.name)).toEqual(["Class 1", "Class 2", "Class 3"]);
    expect(edited).toHaveBeenCalledTimes(1);
    for (let i = 3; i < 255; i++) add.click();
    expect(panel.classes()).toHaveLength(255);
    expect(add.disabled).toBe(true);
  });

  it("locked blocks rename, recolour and Add; selecting still works", () => {
    const { list, add, panel, lock, recoloured, edited } = setup();
    lock(true);
    expect(add.disabled).toBe(true);
    rename(list, 0, "Sand");
    recolour(list, 0, "#123456");
    add.click();
    expect(panel.classes()).toEqual([{ name: "Class 1", colour: "#1f77b4" }, { name: "Class 2", colour: "#ff7f0e" }]);
    expect(recoloured).not.toHaveBeenCalled();
    expect(edited).not.toHaveBeenCalled();
    panel.select(1);
    expect(panel.selected()).toBe(1);
    lock(false);
    expect(add.disabled).toBe(false);
  });

  it("labels.ts no longer renders the class list and is under 200 lines", () => {
    const src = readFileSync("src/ui/labels.ts", "utf8");
    expect(src).not.toMatch(/renderClasses/);
    expect(src.split("\n").length).toBeLessThan(200);
  });
});
