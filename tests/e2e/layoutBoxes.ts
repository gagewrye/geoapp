import type { Page } from "@playwright/test";

/** One element's box in CSS px, keyed by its id or, without one, its nearest id'd ancestor, tag and index there. */
export type Box = { key: string; x: number; y: number; width: number; height: number };

/** Spec 062's wrappers: keyed as if they had no id, so the wrapped opacity row keeps its baseline key. */
export const NEW_IDS = ["kinds", "tools-mask", "brush-group", "mask-view"];

/** The box of every element in #tools and #side (spec 062 criterion 4). */
export function measure(page: Page): Promise<Box[]> {
  return page.evaluate((fresh) => {
    const id = (e: Element) => (e.id && !fresh.includes(e.id) ? e.id : "");
    const out: { key: string; x: number; y: number; width: number; height: number }[] = [];
    for (const root of ["tools", "side"]) {
      for (const e of document.getElementById(root)!.querySelectorAll("*")) {
        let key = id(e);
        if (!key) {
          let a = e.parentElement!;
          while (!id(a)) a = a.parentElement!;
          const same = [...a.querySelectorAll(e.tagName)].filter((o) => { let p = o.parentElement!; while (!id(p)) p = p.parentElement!; return p === a; });
          key = `${a.id}>${e.tagName.toLowerCase()}:${same.indexOf(e)}`;
        }
        const r = e.getBoundingClientRect();
        out.push({ key, x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    return out;
  }, NEW_IDS);
}
