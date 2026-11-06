/**
 * One shortcut (specs 039, 045). Single keys are written as labelKeys' KEYMAP keys: a KeyboardEvent.key, or a code for
 * keys read by position (Space, Backquote, Backslash, KeyW...). Chords use "+", with "Mod" for Cmd on Mac and Ctrl
 * elsewhere, and mouse actions a space ("Right drag"), or are "Click". The id is what KEYMAP maps to and the handlers branch on; the
 * action is the text the help shows, and a button's title.
 */
export type Shortcut = { id: string; section: string; keys: string[]; action: string; button?: string };

/** Running on macOS or iOS, where Cmd takes Ctrl's place in undo and redo. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** Every keyboard and mouse shortcut, by section (specs 003-054). */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "paint", section: "Tools", keys: ["b"], action: "Paint", button: "mode-paint" },
  { id: "erase", section: "Tools", keys: ["e"], action: "Erase", button: "mode-erase" },
  { id: "pan", section: "Tools", keys: ["p", "Escape"], action: "Pan", button: "mode-pan" },
  { id: "hold-pan", section: "Tools", keys: ["Space"], action: "Pan while held" },
  { id: "smart", section: "Tools", keys: ["m"], action: "Smart select", button: "mode-smart" },
  { id: "smart-point", section: "Tools", keys: ["Click", "Shift+click"], action: "Include / exclude a point" },
  { id: "smart-apply", section: "Tools", keys: ["Enter"], action: "Apply smart selection", button: "smart-apply" },
  { id: "smart-discard", section: "Tools", keys: ["Escape", "Right click"], action: "Discard the selection" },
  { id: "fill", section: "Tools", keys: ["f"], action: "Fill", button: "mode-fill" },
  { id: "fill-click", section: "Tools", keys: ["Click"], action: "Fill the area under the pointer" },
  { id: "brush-smaller", section: "Brush", keys: ["["], action: "Smaller brush", button: "brush-smaller" },
  { id: "brush-larger", section: "Brush", keys: ["]"], action: "Larger brush", button: "brush-larger" },
  { id: "right-erase", section: "Brush", keys: ["Right drag"], action: "Erase the selected class (Paint mode)" },
  { id: "select-class", section: "Classes", keys: DIGITS, action: "Select class 1-9" },
  { id: "pick", section: "Classes", keys: ["i"], action: "Pick the class under the pointer" },
  { id: "alt-pick", section: "Classes", keys: ["Alt+click"], action: "Pick the class of the clicked pixel" },
  { id: "toggle-labels", section: "View", keys: ["h"], action: "Show or hide labels" },
  { id: "peek", section: "View", keys: ["Backquote"], action: "Hide labels while held" },
  { id: "collapse", section: "View", keys: ["Backslash"], action: "Hide the side panels" },
  { id: "home", section: "View", keys: ["Home"], action: "Zoom to the raster" },
  { id: "help", section: "View", keys: ["?"], action: "Shortcuts", button: "help-button" },
  { id: "move", section: "Navigation", keys: ["KeyW", "KeyA", "KeyS", "KeyD"], action: "Move the map" },
  { id: "middle-pan", section: "Navigation", keys: ["Middle drag"], action: "Move the map, in any mode" },
  { id: "wheel-zoom", section: "Navigation", keys: ["Mouse wheel"], action: "Zoom" },
  { id: "undo", section: "Edit", keys: ["Mod+Z"], action: "Undo", button: "undo" },
  { id: "redo", section: "Edit", keys: ["Mod+Shift+Z", "Ctrl+Y"], action: "Redo", button: "redo" },
];

/** A key KEYMAP holds: not a chord ("+") or a mouse action (a space, or "Click"). */
export const isSingleKey = (k: string) => !/[+ ]|^Click$/.test(k);

const NAMES: Record<string, string> = { Backquote: "`", Backslash: "\\", Escape: "Esc" };
const one = (k: string) => NAMES[k] ?? (/^Key[A-Z]$/.test(k) ? k.slice(3) : k.length === 1 ? k.toUpperCase() : k);

/** How a key reads to the user: B, W, `, Esc, Ctrl+Y, and Mod+Z as Cmd+Z on Mac, Ctrl+Z elsewhere. */
export const keyLabel = (k: string, mac = IS_MAC) =>
  (isSingleKey(k) ? one(k) : k.split("+").map((p) => (p === "Mod" ? (mac ? "Cmd" : "Ctrl") : p)).join("+"));

/** A key as aria-keyshortcuts writes it: B, Escape, Control+Y, and Mod+Z as Meta+Z on Mac, Control+Z elsewhere. */
export const ariaKey = (k: string, mac = IS_MAC) => k.split("+")
  .map((p) => (p === "Mod" ? (mac ? "Meta" : "Control") : p === "Ctrl" ? "Control" : p.length === 1 ? p.toUpperCase() : p)).join("+");

/** The keys of one entry as the help lists them; a run of digits reads 1-9. */
export const keysLabel = (keys: string[]) => (keys === DIGITS ? "1-9" : keys.map((k) => keyLabel(k)).join(" / "));
