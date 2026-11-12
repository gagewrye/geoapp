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

/** CSS cursor value: a 32x32 block eraser tilted 45°, pink tip at the lower left, hotspot mid tip edge (spec 058). */
// The same black outline over a white halo as the brush; class-agnostic, so it never takes the class colour.
export function eraserCursor(): string {
  const body = `x="6" y="21" width="28" height="10" rx="1.5"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`
    + `<g transform="rotate(-45 6 26)">`
    + `<rect ${body} fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>`
    + `<rect ${body} fill="#fff"/>`
    + `<path d="M7.5 21 H15 V31 H7.5 A1.5 1.5 0 0 1 6 29.5 V22.5 A1.5 1.5 0 0 1 7.5 21 Z" fill="#f28fa5"/>`
    + `<path d="M15 21 V31" stroke="#000" stroke-width="1.2"/>`
    + `<rect ${body} fill="none" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>`
    + `</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 6 26, crosshair`;
}
