import { MAX_CLASSES, checkName, initialClasses, nextClass, type LabelClass } from "../core/classes";
import { markSelected, renderClasses } from "./classList";
import { MESSAGES, type MessageKind } from "./messages";

type Deps = {
  list: HTMLElement;
  add: HTMLButtonElement;
  say: (text: string, kind?: MessageKind) => void;
  /** Spec 004's lock: no rename, recolour or Add; selecting still works. */
  locked: () => boolean;
  recoloured: () => void;
  selectedChanged: () => void;
  /** A rename or Add changed the list (spec 031 saves it; the status bar shows the selected name). */
  edited: () => void;
};

/** The Classes section (specs 003, 036): the class list, the selected class, rename, recolour and Add class. */
export function initClassPanel({ list, add, say, locked, recoloured, selectedChanged, edited }: Deps) {
  const classes: LabelClass[] = initialClasses();
  let selected = 0;
  const select = (i: number) => {
    selected = i;
    markSelected(list, i);
    selectedChanged();
  };
  const render = () => {
    renderClasses(list, classes, selected, locked(), {
      select,
      rename: (i, name) => {
        if (locked()) return classes[i]!.name;
        const ok = checkName(classes, i, name);
        if (ok === null) { say(MESSAGES.className, "error"); return classes[i]!.name; }
        classes[i]!.name = ok;
        edited();
        return ok;
      },
      recolour: (i, colour) => {
        if (locked()) return;
        classes[i]!.colour = colour;
        recoloured();
      },
    });
    add.disabled = locked() || classes.length >= MAX_CLASSES;
  };
  add.addEventListener("click", () => {
    if (locked() || classes.length >= MAX_CLASSES) return;
    classes.push(nextClass(classes));
    edited();
    render();
  });
  render();

  return {
    classes: () => classes,
    selected: () => selected,
    select,
    /** Swaps in another list (an import or a restore); an out-of-range selected falls back to 0. */
    replace(next: LabelClass[], i = selected): void {
      classes.splice(0, classes.length, ...next);
      selected = i >= 0 && i < classes.length ? i : 0;
      render();
    },
    render,
  };
}
