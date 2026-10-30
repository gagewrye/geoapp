/** Preview pixels between exact lattice nodes (spec 030). */
export const PREVIEW_LATTICE = 16;
/** Largest error, in source px, an interpolated cell centre may have before the lattice halves. */
export const PREVIEW_CHECK = 0.001;
/** Pixels this close to a whole source c or r are computed exactly, so their floor can't flip (5x PREVIEW_CHECK). */
export const PREVIEW_EDGE = 0.005;

/** Node positions along an axis of n pixels: multiples of step below n - 1, then n - 1. */
function nodesOf(n: number, step: number): number[] {
  const out: number[] = [];
  for (let p = 0; p < n - 1; p += step) out.push(p);
  out.push(n - 1);
  return out;
}

type Lattice = { us: number[]; vs: number[]; c: Float64Array; r: Float64Array; exactCell: Uint8Array };

const lerp = (a: number, b: number, t: number) => (1 - t) * a + t * b;
const nearWhole = (x: number) => Math.abs(x - Math.round(x)) < PREVIEW_EDGE;

/** The lattice at one step, or undefined if an interpolated cell centre misses the exact one by more than PREVIEW_CHECK. */
function build(width: number, height: number, step: number, exact: (u: number, v: number) => [number, number]): Lattice | undefined {
  const us = nodesOf(width, step), vs = nodesOf(height, step);
  const nu = us.length, nv = vs.length;
  const c = new Float64Array(nu * nv), r = new Float64Array(nu * nv);
  for (let j = 0; j < nv; j++) for (let k = 0; k < nu; k++) [c[j * nu + k], r[j * nu + k]] = exact(us[k]!, vs[j]!);
  const exactCell = new Uint8Array((nu - 1) * (nv - 1));
  for (let j = 0; j + 1 < nv; j++) {
    for (let k = 0; k + 1 < nu; k++) {
      const n = [j * nu + k, j * nu + k + 1, (j + 1) * nu + k, (j + 1) * nu + k + 1];
      const [ec, er] = exact((us[k]! + us[k + 1]!) / 2, (vs[j]! + vs[j + 1]!) / 2);
      // spec 029: where the projection gives up, the cell is computed pixel by pixel
      if (!n.every((i) => Number.isFinite(c[i]!) && Number.isFinite(r[i]!)) || !Number.isFinite(ec) || !Number.isFinite(er)) {
        exactCell[j * (nu - 1) + k] = 1;
        continue;
      }
      const ic = (c[n[0]!]! + c[n[1]!]! + c[n[2]!]! + c[n[3]!]!) / 4, ir = (r[n[0]!]! + r[n[1]!]! + r[n[2]!]! + r[n[3]!]!) / 4;
      if (Math.abs(ic - ec) > PREVIEW_CHECK || Math.abs(ir - er) > PREVIEW_CHECK) return undefined;
    }
  }
  return { us, vs, c, r, exactCell };
}

/** Visit every preview pixel row-major with its source (c, r): exact at nodes, bilinear between, exact near pixel edges. */
export function latticeEach(width: number, height: number, exact: (u: number, v: number) => [number, number],
  f: (o: number, c: number, r: number) => void): void {
  let lat: Lattice | undefined;
  for (let step = PREVIEW_LATTICE; step > 1 && width > 1 && height > 1 && !lat; step = Math.floor(step / 2)) lat = build(width, height, step, exact);
  if (!lat) {
    for (let v = 0; v < height; v++) for (let u = 0; u < width; u++) { const [c, r] = exact(u, v); f(v * width + u, c, r); }
    return;
  }
  const { us, vs, c, r, exactCell } = lat;
  const nu = us.length, step = us[1]! - us[0]!;
  const rowC = new Float64Array(nu), rowR = new Float64Array(nu);
  for (let v = 0, j = 0; v < height; v++) {
    if (v > vs[j + 1]!) j++;
    const v0 = vs[j]!, v1 = vs[j + 1]!, ty = (v - v0) / (v1 - v0);
    for (let k = 0; k < nu; k++) {
      rowC[k] = lerp(c[j * nu + k]!, c[(j + 1) * nu + k]!, ty);
      rowR[k] = lerp(r[j * nu + k]!, r[(j + 1) * nu + k]!, ty);
    }
    const onRow = v === v0 || v === v1;
    for (let u = 0; u < width; u++) {
      const k = Math.min(Math.floor(u / step), nu - 2), u0 = us[k]!, u1 = us[k + 1]!;
      const o = v * width + u;
      if (onRow && (u === u0 || u === u1)) { // a node: already exact
        const n = (v === v0 ? j : j + 1) * nu + (u === u0 ? k : k + 1);
        f(o, c[n]!, r[n]!);
        continue;
      }
      if (exactCell[j * (nu - 1) + k]) { const [ec, er] = exact(u, v); f(o, ec, er); continue; }
      const tx = (u - u0) / (u1 - u0);
      const ic = lerp(rowC[k]!, rowC[k + 1]!, tx), ir = lerp(rowR[k]!, rowR[k + 1]!, tx);
      if (nearWhole(ic) || nearWhole(ir)) { const [ec, er] = exact(u, v); f(o, ec, er); continue; }
      f(o, ic, ir);
    }
  }
}
