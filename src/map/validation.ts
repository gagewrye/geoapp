import type { GeoJSONStoreFeatures } from "terra-draw";
import { checkRing, normalizeLon } from "../core/ring";

export type BlockReason = "antimeridian" | "latitude";

/** One terra-draw validation for drawing and select-mode edits; rejects every update type (spec 001). */
export function ringValidation(onBlocked: (reason: BlockReason) => void) {
  // The update type is ignored on purpose: provisional, commit and finish are all rejected.
  return (feature: GeoJSONStoreFeatures, _context?: { updateType: string }): { valid: boolean; reason?: string } => {
    if (feature.geometry.type !== "Polygon") return { valid: true };
    for (const ring of feature.geometry.coordinates) {
      const reason = checkRing(ring.map(([lon, lat]) => [normalizeLon(lon!), lat!]));
      if (reason) {
        onBlocked(reason);
        return { valid: false, reason };
      }
    }
    return { valid: true };
  };
}
