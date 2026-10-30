/** The TIFF alpha band (spec 022): which sample it is, and which samples display and masking read. */

/** Index of the first ExtraSamples entry that is associated (1) or unassociated (2) alpha, or null; 0 (unspecified) isn't alpha. */
// ExtraSamples lists the last extraSamples.length samples of each pixel.
export function alphaOf(extraSamples: number[], samplesPerPixel: number): number | null {
  const i = extraSamples.findIndex((v) => v === 1 || v === 2);
  return i < 0 ? null : samplesPerPixel - extraSamples.length + i;
}

/** Samples the preview and imagery tiles read: bands 1-3 (or band 1) for colour, then alpha if any. */
// Colour bands are those before the alpha sample, so gray plus alpha shows as grey.
export function displaySamples(bandCount: number, alpha: number | null): number[] {
  const colour = (alpha ?? bandCount) >= 3 ? [0, 1, 2] : [0];
  return alpha === null ? colour : [...colour, alpha];
}

/** Samples a label mask reads, and alpha's index among them: the alpha sample alone when nothing else can be nodata. */
export function maskSamples(bandCount: number, nodata: number | null, float: boolean, alpha: number | null): { samples: number[]; alpha: number | null } {
  if (alpha !== null && nodata === null && !float) return { samples: [alpha], alpha: 0 };
  return { samples: Array.from({ length: bandCount }, (_, k) => k), alpha };
}
