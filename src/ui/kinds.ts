import type { BrushMode } from "../map/brush";

/** A label type (spec 062, ADR 0037): masks, and boxes (spec 064). */
export type KindId = "mask" | "box";
/** A label type's tools and panel: its modes, the tool strip groups and the panel sections it shows. */
export type LabelKind = { id: KindId; name: string; modes: readonly BrushMode[]; groups: readonly string[]; sections: readonly string[] };

/** Pan and Smart select are shared, so they belong to no kind. */
export const KINDS: readonly LabelKind[] = [
  { id: "mask", name: "Masks", modes: ["paint", "erase", "fill", "polygon"], groups: ["tools-mask", "brush-group"], sections: ["mask-view"] },
];

type Deps = { kinds: readonly LabelKind[]; mode: () => BrushMode; setMode: (m: BrushMode) => void };

/** The label type switch at the top of the tool strip: it shows one kind's tools and panel sections at a time (spec 062). */
export function initKinds({ kinds, mode, setMode }: Deps) {
  const box = document.getElementById("kinds")!;
  const radios = kinds.map((k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("id", `kind-${k.id}`);
    b.setAttribute("role", "radio");
    b.textContent = k.name;
    b.addEventListener("click", () => setKind(k.id));
    return b;
  });
  box.replaceChildren(...radios);
  box.hidden = kinds.length < 2; // one kind needs no switch
  let current = kinds[0]!.id;
  const kindOf = (m: BrushMode): KindId | null => kinds.find((k) => k.modes.includes(m))?.id ?? null;
  function setKind(id: KindId): void {
    current = id;
    kinds.forEach((k, i) => {
      for (const el of [...k.groups, ...k.sections]) document.getElementById(el)!.hidden = k.id !== id;
      radios[i]!.setAttribute("aria-checked", String(k.id === id));
    });
    // the old kind's tool can't stay selected under the new kind's tools; Pan and Smart are shared
    const owner = kindOf(mode());
    if (owner !== null && owner !== id) setMode("pan");
  }
  setKind(current);
  return {
    kind: () => current,
    setKind,
    kindOf,
    /** A mode chosen by button or key switches to its kind first. */
    follow(m: BrushMode): void {
      const k = kindOf(m);
      if (k !== null && k !== current) setKind(k);
    },
  };
}
