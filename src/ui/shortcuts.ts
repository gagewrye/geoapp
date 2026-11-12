/**
 * One shortcut (specs 039, 045). Single keys are written as labelKeys' KEYMAP keys: a KeyboardEvent.key, or a code for
 * keys read by position (Space, Backquote, Backslash, KeyW...). Chords use "+", with "Mod" for Cmd on Mac and Ctrl
 * elsewhere, and mouse actions a space ("Right drag"), or are "Click". The id is what KEYMAP maps to and the handlers branch on; the
 * action is the text the help shows, and a button's title; the hint (spec 057) is the title's lines after the key, saying what the button does.
 */
export type Shortcut = { id: string; section: string; keys: string[]; action: string; button?: string; hint?: string };

/** Running on macOS or iOS, where Cmd takes Ctrl's place in undo and redo. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** Every keyboard and mouse shortcut, by section (specs 003-054). */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "paint", section: "Tools", keys: ["b"], action: "Paint", button: "mode-paint", hint: "Left Drag: paints the selected class\nRight Drag: removes the selected class" },
  { id: "erase", section: "Tools", keys: ["e"], action: "Erase", button: "mode-erase", hint: "Removes the selected class" },
  { id: "pan", section: "Tools", keys: ["p", "Escape"], action: "Pan", button: "mode-pan", hint: "Drag to move the map. A middle drag or WASD pans in any mode." },
  { id: "hold-pan", section: "Tools", keys: ["Space"], action: "Pan while held" },
  { id: "smart", section: "Tools", keys: ["m"], action: "Smart select", button: "mode-smart", hint: "Click an object to create an AI-generated mask. More clicks add to it, Shift+click excludes, Enter applies." },
  { id: "smart-point", section: "Tools", keys: ["Click", "Shift+click"], action: "Include / exclude a point" },
  { id: "smart-apply", section: "Tools", keys: ["Enter"], action: "Apply smart selection", button: "smart-apply", hint: "Paints the previewed mask as the selected class." },
  { id: "smart-discard", section: "Tools", keys: ["Escape", "Right click"], action: "Discard the selection" },
  { id: "fill", section: "Tools", keys: ["f"], action: "Fill", button: "mode-fill", hint: "Click an area to change every connected pixel of the same class to the selected class." },
  { id: "fill-click", section: "Tools", keys: ["Click"], action: "Fill the area under the pointer" },
  { id: "polygon", section: "Tools", keys: ["l"], action: "Polygon", button: "mode-polygon", hint: "Click corners around a region; Enter, a double click or a click on the first corner fills it. Backspace or right click removes a corner, Escape discards." },
  { id: "polygon-corner", section: "Tools", keys: ["Click"], action: "Add a polygon corner" },
  { id: "polygon-apply", section: "Tools", keys: ["Enter", "Double click"], action: "Fill the polygon" },
  { id: "polygon-back", section: "Tools", keys: ["Backspace", "Right click"], action: "Remove the last corner" },
  { id: "polygon-discard", section: "Tools", keys: ["Escape"], action: "Discard the polygon" },
  { id: "brush-smaller", section: "Brush", keys: ["["], action: "Smaller brush", button: "brush-smaller", hint: "Halves the brush (in raster pixels)." },
  { id: "brush-larger", section: "Brush", keys: ["]"], action: "Larger brush", button: "brush-larger", hint: "Doubles the brush (in raster pixels)." },
  { id: "right-erase", section: "Brush", keys: ["Right drag"], action: "Erase the selected class (Paint mode)" },
  { id: "select-class", section: "Classes", keys: DIGITS, action: "Select class 1-9" },
  { id: "pick", section: "Classes", keys: ["i"], action: "Pick the class under the pointer" },
  { id: "alt-pick", section: "Classes", keys: ["Alt+click"], action: "Pick the class of the clicked pixel" },
  { id: "toggle-labels", section: "View", keys: ["h"], action: "Show or hide labels" },
  { id: "peek", section: "View", keys: ["Backquote"], action: "Hide labels while held" },
  { id: "collapse", section: "View", keys: ["Backslash"], action: "Hide the side panels" },
  { id: "home", section: "View", keys: ["Home"], action: "Zoom to the raster" },
  { id: "help", section: "View", keys: ["?"], action: "Shortcuts", button: "help-button", hint: "Lists every keyboard and mouse shortcut." },
  { id: "move", section: "Navigation", keys: ["KeyW", "KeyA", "KeyS", "KeyD"], action: "Move the map" },
  { id: "middle-pan", section: "Navigation", keys: ["Middle drag"], action: "Move the map, in any mode" },
  { id: "wheel-zoom", section: "Navigation", keys: ["Mouse wheel"], action: "Zoom" },
  { id: "undo", section: "Edit", keys: ["Mod+Z"], action: "Undo", button: "undo", hint: "Takes back the last stroke, fill or applied selection." },
  { id: "redo", section: "Edit", keys: ["Mod+Shift+Z", "Ctrl+Y"], action: "Redo", button: "redo", hint: "Puts back what you undid." },
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
