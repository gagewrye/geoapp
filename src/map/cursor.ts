/** CSS cursor value: a 32x32 paintbrush with `colour` ("#rrggbb") bristles, hotspot at the tip (spec 010). */
// Black and white outlines keep it visible on any imagery and any class colour.
export function brushCursor(colour: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`
    + `<path d="M29 3 L17 15" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`
    + `<path d="M29 3 L17 15" stroke="#000" stroke-width="3.5" stroke-linecap="round"/>`
    + `<path d="M15 13 L19 17 C17 25 10 29 2 30 C3 22 7 15 15 13 Z" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>`
    + `<path d="M15 13 L19 17 C17 25 10 29 2 30 C3 22 7 15 15 13 Z" fill="${colour}" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>`
    + `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 30, crosshair`;
}
