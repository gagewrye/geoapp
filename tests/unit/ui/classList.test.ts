import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paletteColour, type LabelClass } from "../../../src/core/classes";
import { markSelected, renderClasses } from "../../../src/ui/classList";
import { FakeDocument, type FakeElement } from "../helpers/fakeDom";

// Spec 036 criteria 1-4.
let doc: FakeDocument;
beforeEach(() => { doc = new FakeDocument(); vi.stubGlobal("document", doc); });
afterEach(() => { vi.unstubAllGlobals(); });

const make = (n: number): LabelClass[] => Array.from({ length: n }, (_, i) => ({ name: `Class ${i + 1}`, colour: paletteColour(i) }));
const rows = (list: FakeElement) => list.querySelectorAll("li");
const part = (list: FakeElement, i: number, sel: string) => rows(list)[i]!.querySelector(sel)!;

function setup(classes: LabelClass[], locked = false, rename = (_i: number, name: string) => name) {
  const list = doc.createElement("ul");
  const on = { select: vi.fn(), rename: vi.fn(rename), recolour: vi.fn() };
  renderClasses(list as unknown as HTMLElement, classes, 0, locked, on);
  return { list, on };
}

describe("class rows (criterion 1)", () => {
  it("rows 1-9 show their key, rows 10-12 none; each has the class colour's swatch and a name span", () => {
    const classes = make(12);
    const { list } = setup(classes);
    expect(rows(list).map((li) => li.querySelector(".class-key")!.textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "", ""]);
    rows(list).forEach((_, i) => {
      expect(part(list, i, "input.class-colour").value).toBe(classes[i]!.colour);
      const name = part(list, i, "span.class-name");
      expect(name.textContent).toBe(classes[i]!.name);
      expect(name.title).toBe(classes[i]!.name);
      expect(part(list, i, "button.class-rename").getAttribute("aria-label")).toBe(`Rename ${classes[i]!.name}`);
      expect(part(list, i, "input[type=radio]")).not.toBeNull();
    });
  });
});

describe("selecting (criterion 2)", () => {
  it("a click on the name selects the row; a click on the swatch or rename doesn't", () => {
    const { list, on } = setup(make(3));
    part(list, 2, ".class-name").click();
    expect(on.select).toHaveBeenCalledWith(2);
    on.select.mockClear();
    part(list, 1, ".class-colour").click();
    part(list, 1, ".class-rename").click();
    expect(on.select).not.toHaveBeenCalled();
  });

  it("markSelected marks the row and scrolls it into view (nearest)", () => {
    const { list } = setup(make(3));
    markSelected(list as unknown as HTMLElement, 2);
    expect(rows(list).map((li) => li.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(part(list, 2, "input[type=radio]").checked).toBe(true);
    expect(rows(list)[2]!.scrolls).toEqual([{ block: "nearest" }]);
  });
});

describe("renaming (criterion 3)", () => {
  const edit = (list: FakeElement, i: number) => part(list, i, "input.class-name-edit");

  it("rename opens a field with the name selected; Enter commits through rename and shows the returned name", () => {
    const { list, on } = setup(make(2), false, (_i, name) => name.trim());
    const outer = vi.fn(); // the event path is fixed at dispatch, so only stopPropagation keeps Enter from the ancestors
    list.addEventListener("keydown", outer);
    part(list, 1, ".class-rename").click();
    const field = edit(list, 1);
    expect(doc.activeElement).toBe(field);
    expect(field.selection).toBe("Class 2");
    expect(part(list, 1, ".class-name")).toBeNull();
    field.value = " Water ";
    field.dispatch("keydown", { key: "Enter" });
    expect(on.rename).toHaveBeenCalledWith(1, " Water ");
    expect(outer).not.toHaveBeenCalled();
    expect(edit(list, 1)).toBeNull();
    expect(part(list, 1, ".class-name").textContent).toBe("Water");
    expect(part(list, 1, ".class-rename").getAttribute("aria-label")).toBe("Rename Water");
    field.dispatch("blur"); // a blur after the commit renames nothing more
    expect(on.rename).toHaveBeenCalledTimes(1);
  });

  it("double-clicking the name opens the field; blur commits", () => {
    const { list, on } = setup(make(2));
    part(list, 0, ".class-name").dispatch("dblclick");
    const field = edit(list, 0);
    field.value = "Sand";
    field.dispatch("blur");
    expect(on.rename).toHaveBeenCalledWith(0, "Sand");
    expect(part(list, 0, ".class-name").textContent).toBe("Sand");
  });

  it("Escape restores the old name without calling rename, and doesn't reach the window's keys", () => {
    const { list, on } = setup(make(2));
    const outer = vi.fn();
    list.addEventListener("keydown", outer);
    part(list, 0, ".class-rename").click();
    const field = edit(list, 0);
    field.value = "Other";
    field.dispatch("keydown", { key: "Escape" });
    field.dispatch("blur");
    expect(on.rename).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(part(list, 0, ".class-name").textContent).toBe("Class 1");
  });

  it("a duplicate name shows the old name (rename returns it)", () => {
    const classes = make(2);
    const { list } = setup(classes, false, (i, name) => (classes.some((c, j) => j !== i && c.name === name) ? classes[i]!.name : name));
    part(list, 1, ".class-rename").click();
    edit(list, 1).value = "Class 1";
    edit(list, 1).dispatch("keydown", { key: "Enter" });
    expect(part(list, 1, ".class-name").textContent).toBe("Class 2");
  });
});

describe("locked (criterion 4)", () => {
  it("disables the swatch and rename; double-click opens no field; a click still selects", () => {
    const { list, on } = setup(make(2), true);
    expect(part(list, 0, ".class-colour").disabled).toBe(true);
    expect(part(list, 0, ".class-rename").disabled).toBe(true);
    part(list, 0, ".class-name").dispatch("dblclick");
    part(list, 0, ".class-rename").click();
    expect(part(list, 0, "input.class-name-edit")).toBeNull();
    part(list, 1, ".class-name").click();
    expect(on.select).toHaveBeenCalledWith(1);
  });
});
