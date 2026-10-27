import type { LabelClass } from "../core/classes";

type Handlers = {
  select: (index: number) => void;
  /** Returns the name to show: the new one if accepted, else the old one. */
  rename: (index: number, name: string) => string;
  recolour: (index: number, colour: string) => void;
};

/** The class list: select (click anywhere in a row), rename and recolour. */
export function renderClasses(list: HTMLElement, classes: LabelClass[], selected: number, on: Handlers): void {
  list.replaceChildren(...classes.map((c, i) => {
    const li = document.createElement("li");
    li.dataset.index = String(i);
    li.classList.toggle("selected", i === selected);
    li.setAttribute("aria-selected", String(i === selected));
    const pick = document.createElement("input");
    pick.type = "radio";
    pick.name = "label-class";
    pick.checked = i === selected;
    pick.setAttribute("aria-label", `Select ${c.name}`);
    const name = document.createElement("input");
    name.type = "text";
    name.className = "class-name";
    name.value = c.name;
    name.addEventListener("change", () => { name.value = on.rename(i, name.value); });
    const colour = document.createElement("input");
    colour.type = "color";
    colour.className = "class-colour";
    colour.value = c.colour;
    colour.addEventListener("input", () => on.recolour(i, colour.value));
    li.append(pick, name, colour);
    li.addEventListener("click", () => on.select(i));
    return li;
  }));
}

/** Mark the selected row without rebuilding the list (so a name being edited keeps focus). */
export function markSelected(list: HTMLElement, selected: number): void {
  list.querySelectorAll<HTMLLIElement>("li").forEach((li, i) => {
    li.classList.toggle("selected", i === selected);
    li.setAttribute("aria-selected", String(i === selected));
    li.querySelector<HTMLInputElement>("input[type=radio]")!.checked = i === selected;
  });
}
