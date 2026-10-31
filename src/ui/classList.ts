import type { LabelClass } from "../core/classes";

type Handlers = {
  select: (index: number) => void;
  /** Returns the name to show: the new one if accepted, else the old one. */
  rename: (index: number, name: string) => string;
  recolour: (index: number, colour: string) => void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = className;
  return e;
};

/** The class list (spec 036): key, swatch, name and rename per row; a click elsewhere selects; locked, only select. */
export function renderClasses(list: HTMLElement, classes: LabelClass[], selected: number, locked: boolean, on: Handlers): void {
  list.replaceChildren(...classes.map((c, i) => {
    const li = el("li");
    li.dataset.index = String(i);
    li.classList.toggle("selected", i === selected);
    li.setAttribute("aria-selected", String(i === selected));
    // visually hidden: keyboard selection and the radio group's semantics stay
    const pick = el("input", "visually-hidden");
    pick.type = "radio";
    pick.name = "label-class";
    pick.checked = i === selected;
    pick.setAttribute("aria-label", `Select ${c.name}`);
    const key = el("span", "class-key");
    key.textContent = i < 9 ? String(i + 1) : "";
    const colour = el("input", "class-colour");
    colour.type = "color";
    colour.value = c.colour;
    colour.disabled = locked;
    colour.addEventListener("input", () => on.recolour(i, colour.value));
    const name = el("span", "class-name");
    const edit = el("button", "class-rename");
    edit.type = "button";
    edit.textContent = "✎";
    edit.disabled = locked;
    const show = (text: string) => {
      name.textContent = name.title = text;
      edit.setAttribute("aria-label", `Rename ${text}`);
      pick.setAttribute("aria-label", `Select ${text}`);
    };
    show(c.name);
    const rename = () => { if (!locked) startRename(name, (text) => (text === null ? name.textContent! : on.rename(i, text)), show); };
    name.addEventListener("dblclick", rename);
    edit.addEventListener("click", rename);
    li.append(pick, key, colour, name, edit);
    li.addEventListener("click", (e) => { if (e.target !== colour && e.target !== edit) on.select(i); });
    return li;
  }));
}

/** Swaps the name for a field with it selected: Enter or blur commits, Escape cancels (commit(null)). */
function startRename(name: HTMLElement, commit: (text: string | null) => string, show: (text: string) => void): void {
  const field = el("input", "class-name-edit");
  field.type = "text";
  field.value = name.textContent!;
  field.setAttribute("aria-label", `Name of ${name.textContent}`);
  let done = false;
  const finish = (text: string | null) => {
    if (done) return; // removing the field may blur it after Enter or Escape
    done = true;
    show(commit(text));
    field.replaceWith(name);
  };
  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    // the field is gone before the event would reach the window, where Escape is spec 033's Pan key
    e.stopPropagation();
    e.preventDefault();
    finish(e.key === "Enter" ? field.value : null);
  });
  field.addEventListener("blur", () => finish(field.value));
  name.replaceWith(field);
  field.focus();
  field.select();
}

/** Mark the selected row without rebuilding the list (so a name being edited keeps focus), and scroll it into view. */
export function markSelected(list: HTMLElement, selected: number): void {
  list.querySelectorAll<HTMLLIElement>("li").forEach((li, i) => {
    li.classList.toggle("selected", i === selected);
    li.setAttribute("aria-selected", String(i === selected));
    li.querySelector<HTMLInputElement>("input[type=radio]")!.checked = i === selected;
    if (i === selected) li.scrollIntoView({ block: "nearest" });
  });
}
