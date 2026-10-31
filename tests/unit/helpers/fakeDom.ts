// Node has no DOM and adding one needs an ADR: just enough of one for the class list (spec 036), with bubbling events.
type Listener = (e: FakeEvent) => void;

export class FakeEvent {
  defaultPrevented = false;
  stopped = false;
  target: FakeElement | null = null;
  key = "";
  constructor(readonly type: string, init: { key?: string } = {}) { Object.assign(this, init); }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.stopped = true; }
}

export class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  dataset: Record<string, string> = {};
  type = ""; name = ""; value = ""; checked = false; disabled = false; title = ""; className = "";
  /** The text the user selected in a field (select()). */
  selection = "";
  scrolls: unknown[] = [];
  private text = "";
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  constructor(readonly tagName: string, private readonly doc: FakeDocument) {}

  get textContent(): string { return this.children.length ? this.children.map((c) => c.textContent).join("") : this.text; }
  set textContent(t: string) { this.setChildren([]); this.text = t; }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      toggle: (c: string, on = !list().includes(c)) => { this.className = [...list().filter((x) => x !== c), ...(on ? [c] : [])].join(" "); return on; },
    };
  }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addEventListener(type: string, f: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]); }
  append(...els: FakeElement[]): void { this.setChildren([...this.children, ...els]); }
  replaceChildren(...els: FakeElement[]): void { this.setChildren(els); }
  replaceWith(el: FakeElement): void {
    const p = this.parentElement!;
    p.setChildren(p.children.map((c) => (c === this ? el : c)));
  }
  focus(): void {
    const was = this.doc.activeElement;
    if (was === this) return;
    this.doc.activeElement = this;
    was?.dispatch("blur");
  }
  select(): void { this.selection = this.value; }
  scrollIntoView(opts: unknown): void { this.scrolls.push(opts); }
  /** Dispatches an event at this element, bubbling up its ancestors until one stops it. */
  dispatch(type: string, init: { key?: string } = {}): FakeEvent {
    const e = new FakeEvent(type, init);
    e.target = this;
    for (let el: FakeElement | null = this; el && !e.stopped; el = el.parentElement) for (const f of el.listeners.get(type) ?? []) f(e);
    return e;
  }
  click(): FakeEvent { return this.dispatch("click"); }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => el.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null { return this.querySelectorAll(sel)[0] ?? null; }
  /** Compound selectors only: tag, .class and [attr=value]. */
  matches(sel: string): boolean {
    const m = /^(\w+)?((?:\.[\w-]+)*)(?:\[(\w[\w-]*)=([\w-]+)\])?$/.exec(sel);
    if (!m) throw new Error(`fakeDom: unsupported selector ${sel}`);
    const [, tag, classes, attr, val] = m;
    if (tag && tag !== this.tagName) return false;
    if (classes && !classes.split(".").filter(Boolean).every((c) => this.classList.contains(c))) return false;
    if (attr && (attr === "type" ? this.type : this.getAttribute(attr)) !== val) return false;
    return true;
  }
  private setChildren(els: FakeElement[]): void {
    for (const c of this.children) if (!els.includes(c)) { c.parentElement = null; if (c.contains(this.doc.activeElement)) this.doc.activeElement = null; }
    for (const c of els) c.parentElement = this;
    this.children = els;
  }
  private contains(el: FakeElement | null): boolean { return el === this || this.children.some((c) => c.contains(el)); }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  createElement(tag: string): FakeElement { return new FakeElement(tag, this); }
}
