import { actionOf, inTextField } from "./labelKeys";
import { SHORTCUTS, ariaKey, keyLabel, keysLabel } from "./shortcuts";

/** Gives each button SHORTCUTS names its title and aria-keyshortcuts, such as "Paint (B)" and "B" (spec 039). */
export function labelButtons(byId: (id: string) => HTMLElement | null): void {
  for (const s of SHORTCUTS) {
    const el = s.button ? byId(s.button) : null;
    if (!el) continue;
    el.title = `${s.action} (${keyLabel(s.keys[0]!)})`;
    el.setAttribute("aria-keyshortcuts", s.keys.map(ariaKey).join(" "));
  }
}

type Deps = { dialog: HTMLDialogElement; button: HTMLButtonElement; list: HTMLElement };

/** The shortcut list (spec 039): `?` or the ? button opens it as a modal; Escape, Close or `?` closes it. */
export function initHelp({ dialog, button, list }: Deps): void {
  const sections = [...new Set(SHORTCUTS.map((s) => s.section))];
  list.replaceChildren(...sections.map((section) => {
    const group = document.createElement("section");
    const h = document.createElement("h3");
    h.textContent = section;
    const table = document.createElement("table");
    for (const s of SHORTCUTS.filter((x) => x.section === section)) {
      const row = table.insertRow();
      row.className = "shortcut";
      row.insertCell().append(Object.assign(document.createElement("kbd"), { textContent: keysLabel(s.keys) }));
      row.insertCell().textContent = s.action;
    }
    group.append(h, table);
    return group;
  }));
  labelButtons((id) => document.getElementById(id));
  button.addEventListener("click", () => { if (!dialog.open) dialog.showModal(); });
  // Capture on the window runs before every other shortcut listener: while the list is open none of them sees a key,
  // so Escape only closes it (the dialog's own close) and doesn't select Pan
  window.addEventListener("keydown", (e) => {
    const toggle = actionOf(e) === "Shortcuts" && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (dialog.open) {
      e.stopPropagation();
      if (toggle) { e.preventDefault(); dialog.close(); }
    } else if (toggle && !inTextField(document.activeElement)) {
      e.preventDefault();
      dialog.showModal();
    }
  }, { capture: true });
}
