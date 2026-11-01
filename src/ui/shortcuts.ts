/**
 * One shortcut (spec 039). Single keys are written as labelKeys' KEYMAP keys: a KeyboardEvent.key, or a code for keys
 * read by position (Space, Backquote, Backslash, KeyW...). Chords use "+" and mouse actions a space ("Right drag"), or are "Click".
 * The action is the text the help shows and the id KEYMAP maps to; a button gets it as its title.
 */
export type Shortcut = { section: string; keys: string[]; action: string; button?: string };

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** Every keyboard and mouse shortcut, by section (specs 003-039). */
export const SHORTCUTS: readonly Shortcut[] = [
  { section: "Tools", keys: ["b"], action: "Paint", button: "mode-paint" },
  { section: "Tools", keys: ["e"], action: "Erase", button: "mode-erase" },
  { section: "Tools", keys: ["p", "Escape"], action: "Pan", button: "mode-pan" },
  { section: "Tools", keys: ["Space"], action: "Pan while held" },
  { section: "Tools", keys: ["m"], action: "Smart select", button: "mode-smart" },
  { section: "Tools", keys: ["Click", "Right click"], action: "Include / exclude a point" },
  { section: "Tools", keys: ["Enter"], action: "Apply smart selection", button: "smart-apply" },
  { section: "Tools", keys: ["Escape"], action: "Discard the selection" },
  { section: "Brush", keys: ["["], action: "Smaller brush", button: "brush-smaller" },
  { section: "Brush", keys: ["]"], action: "Larger brush", button: "brush-larger" },
  { section: "Brush", keys: ["Right drag"], action: "Erase the selected class (Paint mode)" },
  { section: "Classes", keys: DIGITS, action: "Select class 1-9" },
  { section: "Classes", keys: ["i"], action: "Pick the class under the pointer" },
  { section: "Classes", keys: ["Alt+click"], action: "Pick the class of the clicked pixel" },
  { section: "View", keys: ["h"], action: "Show or hide labels" },
  { section: "View", keys: ["Backquote"], action: "Hide labels while held" },
  { section: "View", keys: ["Backslash"], action: "Hide the side panels" },
  { section: "View", keys: ["Home"], action: "Zoom to the raster" },
  { section: "View", keys: ["?"], action: "Shortcuts", button: "help-button" },
  { section: "Navigation", keys: ["KeyW", "KeyA", "KeyS", "KeyD"], action: "Move the map" },
  { section: "Navigation", keys: ["Middle drag"], action: "Move the map, in any mode" },
  { section: "Navigation", keys: ["Mouse wheel"], action: "Zoom" },
  { section: "Edit", keys: ["Ctrl+Z"], action: "Undo", button: "undo" },
  { section: "Edit", keys: ["Ctrl+Shift+Z", "Ctrl+Y"], action: "Redo", button: "redo" },
];

/** A key KEYMAP holds: not a chord ("+") or a mouse action (a space, or "Click"). */
export const isSingleKey = (k: string) => !/[+ ]|^Click$/.test(k);

const NAMES: Record<string, string> = { Backquote: "`", Backslash: "\\", Escape: "Esc" };
/** How a key reads to the user: B, W, `, Esc, Ctrl+Z. */
export const keyLabel = (k: string) => NAMES[k] ?? (/^Key[A-Z]$/.test(k) ? k.slice(3) : k.length === 1 ? k.toUpperCase() : k);

/** A key as aria-keyshortcuts writes it: Control+Z, B, Escape. */
export const ariaKey = (k: string) => k.split("+").map((p) => (p === "Ctrl" ? "Control" : p.length === 1 ? p.toUpperCase() : p)).join("+");

/** The keys of one entry as the help lists them; a run of digits reads 1-9. */
export const keysLabel = (keys: string[]) => (keys === DIGITS ? "1-9" : keys.map(keyLabel).join(" / "));
