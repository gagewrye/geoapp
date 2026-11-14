/** Export's file-name and target rules (spec 055): the typed name, and what a chosen target allows. */

// Names Windows refuses as a file's stem, whatever the extension
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// Path separators, characters Windows refuses, and control characters
// eslint-disable-next-line no-control-regex
const REFUSED = /[/\\<>:"|?*\u0000-\u001f]/;

/** The typed name trimmed, with `.tif` added when it has no .tif or .tiff extension; null for a name the folder can't take. */
export function exportName(input: string): string | null {
  const t = input.trim();
  if (!t || REFUSED.test(t) || t.endsWith(".")) return null;
  const name = /\.tiff?$/i.test(t) ? t : `${t}.tif`;
  if (name.length > 255 || RESERVED.test(name.split(".")[0]!.trim())) return null;
  return name;
}

export type TargetAction = "write" | "replace" | "refuse-imagery" | "refuse-mask";

/** What Export does with a target: a new file is written; the imagery, and the mask while the app has no copy, are refused; any other file needs a replace confirm. */
export function targetAction(t: { exists: boolean; imagery: boolean; mask: boolean; maskCopied: boolean }): TargetAction {
  if (!t.exists) return "write";
  if (t.imagery) return "refuse-imagery";
  if (t.mask && !t.maskCopied) return "refuse-mask";
  return "replace";
}
