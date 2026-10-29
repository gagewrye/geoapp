export type WasdKey = "KeyW" | "KeyA" | "KeyS" | "KeyD";

/** Screen px per second, in any direction (spec 009). */
export const WASD_SPEED = 600;
/** A longer frame gap counts as this many ms, so a stalled frame never jumps. */
export const WASD_MAX_DT = 50;

/** Screen offset [dx, dy] to pan by for one frame with these keys held; [0, 0] if they cancel. */
export function wasdStep(held: ReadonlySet<WasdKey>, dtMs: number): [number, number] {
  const x = (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0);
  const y = (held.has("KeyS") ? 1 : 0) - (held.has("KeyW") ? 1 : 0);
  const len = Math.hypot(x, y);
  if (len === 0) return [0, 0];
  const d = (WASD_SPEED * Math.min(dtMs, WASD_MAX_DT)) / 1000 / len;
  return [x * d, y * d];
}
