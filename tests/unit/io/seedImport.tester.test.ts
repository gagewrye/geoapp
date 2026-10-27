import { describe, expect, it } from "vitest";
import { fromArrayBuffer } from "geotiff";
import { initialClasses, paletteColour } from "../../../src/core/classes";
import type { ClassEntry } from "../../../src/core/classTable";
import { applyAffine, fromLonLat, invertAffine, normalizeLon, toLonLat } from "../../../src/core/crs";
import { tileWindows } from "../../../src/core/grid";
import { emptyStore } from "../../../src/core/labelStore";
import type { Grid } from "../../../src/core/types";
import { LabelFileRefused, openLabelTiff } from "../../../src/io/labelFile";
import { RasterRefusedError } from "../../../src/io/pipeline";
import { importLabels, importTable, type SeedOutcome } from "../../../src/io/seeding";
import { classFile, fakeLabelSource, writeFile } from "../helpers/labelFiles";
import { fakeSource } from "../helpers/sources";

// Tester brute force of Import labels (spec 004 criteria 12, 13, 15) on more CRS pairs than the
// fixtures: UTM, 3857, the southern hemisphere, both sides of 180 and a rotated file; partial
// overlaps, partial edge tiles, NaN imagery, value-derived classes, single-class files, the
// 255-class limit, GDAL_NODATA, and the open refusals.

const ok = (r: SeedOutcome) => { if (typeof r === "string") throw new Error(r); return r; };
const fresh = (w: number, h: number) => ({ store: emptyStore(w, h), classes: initialClasses() });

/** The spec's resampling written out: dst pixel centre -> dst gt -> lon/lat -> file CRS -> inverse file gt -> floor. */
function refCell(dst: Grid, src: Grid, c: number, r: number): [number, number] | null {
  const [x, y] = applyAffine(dst.gt, c + 0.5, r + 0.5);
  let fc: number, fr: number;
  if (dst.epsg === src.epsg) [fc, fr] = invertAffine(src.gt, x, y);
  else {
    const [lon, lat] = toLonLat(dst.epsg, x, y);
    [fc, fr] = invertAffine(src.gt, ...fromLonLat(src.epsg, normalizeLon(lon), lat));
  }
  const col = Math.floor(fc), row = Math.floor(fr);
  return col >= 0 && col < src.width && row >= 0 && row < src.height ? [col, row] : null;
}

/** Imagery: band 2 = -9999 (nodata) on one block, band 3 NaN on another, else data. */
const W = 600, H = 500; // partial edge tiles: 88 and 244 px
const inNodata = (c: number, r: number) => c >= 300 && c < 340 && r >= 200 && r < 230;
const inNan = (c: number, r: number) => c >= 350 && c < 380 && r >= 300 && r < 340;
const imageryValue = (b: number, c: number, r: number) => (b === 1 && inNodata(c, r) ? -9999 : b === 2 && inNan(c, r) ? NaN : 10 + b + ((c + r) % 50));

/** A file value pattern with blocks of 1, 4, 9 and (as nodata or class) 200. */
const fileValue = (c: number, r: number) => [1, 4, 9, 200][(Math.floor(c / 17) + Math.floor(r / 13)) % 4]!;

function check(dst: Grid, src: Grid, nodata: number | null) {
  return async () => {
    const { source: imagery } = fakeSource({ ...dst, bandCount: 3, nodata: -9999 }, imageryValue);
    const { source: file } = fakeLabelSource(src, fileValue, nodata);
    const r = ok(await importLabels(imagery, file, null, fresh(W, H), "replace"));
    // classes: the values at sampled cells, nodata skipped, ascending
    const seen = new Set<number>();
    for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) {
      const cell = refCell(dst, src, col, row);
      if (cell) seen.add(fileValue(...cell));
    }
    const values = [...seen].filter((v) => v !== nodata).sort((a, b) => a - b);
    expect(r.classes).toEqual(values.map((v, i) => ({ name: `Class ${v}`, colour: paletteColour(i) })));
    let bad = 0, labelled = 0, edge = 0;
    const lut = new Map(values.map((v, i) => [v, i + 1]));
    for (const w of tileWindows(W, H)) {
      const t = r.store.tiles.get(`${w.x0},${w.y0}`) ?? new Uint8Array(w.width * w.height);
      expect(t).toHaveLength(w.width * w.height);
      for (let i = 0; i < t.length; i++) {
        const col = w.x0 + (i % w.width), row = w.y0 + Math.floor(i / w.width);
        const cell = refCell(dst, src, col, row);
        const want = inNodata(col, row) || inNan(col, row) || !cell ? 0 : lut.get(fileValue(...cell)) ?? 0;
        if (t[i] !== want) bad++;
        if (want) { labelled++; if (w.width < 256 || w.height < 256) edge++; }
      }
    }
    expect(bad).toBe(0);
    expect(r.pixels).toBe(labelled);
    expect(labelled).toBeGreaterThan(2000);
    return { r, edge };
  };
}

describe("Import labels by brute force on more CRS pairs", () => {
  const utm: Grid = { width: W, height: H, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };
  it("UTM imagery, EPSG:4326 file crossing the imagery's right and bottom edges (partial overlap and partial tiles)", { timeout: 60_000 }, async () => {
    const { edge } = await check(utm, { width: 300, height: 260, epsg: 4326, gt: [15.15, 0.0005, 0, 45.1, 0, -0.0005] }, 200)();
    expect(edge).toBeGreaterThan(0);
  });
  it("UTM imagery, rotated UTM file, GDAL_NODATA unset (200 is a class)", { timeout: 60_000 }, async () => {
    await check(utm, { width: 250, height: 250, epsg: 32633, gt: [503000, 40, 12, 4997000, 9, -40] }, null)();
  });
  it("EPSG:3857 imagery, UTM file", { timeout: 60_000 }, async () => {
    await check({ width: W, height: H, epsg: 3857, gt: [1669792, 40, 0, 5640000, 0, -40] }, { width: 400, height: 300, epsg: 32633, gt: [500000, 50, 0, 5000000, 0, -50] }, 200)();
  });
  it("southern UTM imagery, EPSG:4326 file", { timeout: 60_000 }, async () => {
    await check({ width: W, height: H, epsg: 32733, gt: [300000, 30, 0, 7000000, 0, -30] }, { width: 300, height: 300, epsg: 4326, gt: [13.0, 0.0006, 0, -27.05, 0, -0.0006] }, 200)();
  });
  it("UTM 60 imagery straddling 180 with a UTM 1 file east of 180, and an EPSG:4326 file west of it", { timeout: 60_000 }, async () => {
    const z60: Grid = { width: W, height: H, epsg: 32660, gt: [700000, 200, 0, 5600000, 0, -200] };
    await check(z60, { width: 300, height: 300, epsg: 32601, gt: [280000, 300, 0, 5560000, 0, -300] }, 200)();
    await check(z60, { width: 500, height: 400, epsg: 4326, gt: [179.0, 0.002, 0, 50.4, 0, -0.002] }, 200)();
  });
});

describe("Import labels: classes and outcomes", () => {
  const grid: Grid = { width: W, height: H, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };

  it("value-derived classes come only from sampled cells: a value only on the file's part off the imagery is no class", { timeout: 30_000 }, async () => {
    // file twice as wide as the imagery; its east half (off the imagery) holds only 42
    const src: Grid = { width: 2 * W, height: H, epsg: 32633, gt: grid.gt };
    const { source: imagery } = fakeSource({ ...grid, bandCount: 1 }, () => 1);
    const { source: file } = fakeLabelSource(src, (c) => (c >= W ? 42 : 5));
    const r = ok(await importLabels(imagery, file, null, fresh(W, H), "replace"));
    expect(r.classes.map((c) => c.name)).toEqual(["Class 5"]);
    expect([r.pixels, r.classCount]).toEqual([W * H, 1]);
  });

  it("a single-class file gives one class; all-nodata and disjoint files give \"empty\" and read no imagery", { timeout: 30_000 }, async () => {
    const one = fakeSource({ ...grid, bandCount: 1 }, () => 1);
    expect(ok(await importLabels(one.source, fakeLabelSource(grid, () => 3).source, null, fresh(W, H), "replace")).classes.map((c) => c.name)).toEqual(["Class 3"]);
    for (const [g, v] of [[grid, 255], [{ ...grid, gt: [900000, 30, 0, 5000000, 0, -30] } as Grid, 3]] as const) {
      const { source, reads } = fakeSource({ ...grid, bandCount: 1 }, () => 1);
      const f = fakeLabelSource(g, () => v, 255);
      expect(await importLabels(source, f.source, null, fresh(W, H), "replace")).toBe("empty");
      expect(reads).toEqual([]);
    }
  });

  it("a class map whose values never occur gives \"empty\" and changes nothing", async () => {
    const { source } = fakeSource({ ...grid, bandCount: 1 }, () => 1);
    const current = fresh(W, H);
    const before = structuredClone(current.classes);
    const table: ClassEntry[] = [{ value: 77, name: "never" }];
    expect(await importLabels(source, fakeLabelSource(grid, () => 3).source, table, current, "merge")).toBe("empty");
    expect(current.classes).toEqual(before);
    expect(current.store.tiles.size).toBe(0);
  });

  it("256 distinct values without nodata are \"too many\"; with nodata 255 the other 255 values map to 1..255", { timeout: 60_000 }, async () => {
    const g: Grid = { width: 256, height: 256, epsg: 32633, gt: grid.gt };
    const { source } = fakeSource({ ...g, bandCount: 1 }, () => 1);
    const f = (c: number) => c; // column c holds value c
    expect(await importLabels(source, fakeLabelSource(g, f, null).source, null, fresh(256, 256), "replace")).toBe("too many");
    const r = ok(await importLabels(source, fakeLabelSource(g, f, 255).source, null, fresh(256, 256), "replace"));
    expect(r.classes).toHaveLength(255);
    expect(r.classes[254]!.name).toBe("Class 254");
    const t = r.store.tiles.get("0,0")!;
    expect([t[0], t[1], t[254], t[255]]).toEqual([1, 2, 255, 0]);
    expect(r.classCount).toBe(255);
  });

  it("honours GDAL_NODATA from the file: 7 is unlabelled and no class", { timeout: 30_000 }, async () => {
    const g: Grid = { width: 100, height: 100, epsg: 32633, gt: grid.gt };
    const file = await openLabelTiff(await fromArrayBuffer(classFile("7", g, (c) => (c < 50 ? 7 : 8))));
    expect(file.meta.nodata).toBe(7);
    const { source } = fakeSource({ ...grid, bandCount: 1 }, () => 1);
    const r = ok(await importLabels(source, file, importTable(file), fresh(W, H), "replace"));
    expect(r.classes.map((c) => c.name)).toEqual(["Class 8"]);
    expect(r.pixels).toBe(50 * 100);
  });
});

describe("open refusals and accepted layouts", () => {
  const g: Grid = { width: 8, height: 8, epsg: 32633, gt: [500000, 30, 0, 5000000, 0, -30] };
  const open = async (buf: ArrayBuffer) => openLabelTiff(await fromArrayBuffer(buf));
  const u8 = new Uint8Array(64).fill(1);

  it("refuses 2-band 8-bit, signed 8-bit, float and 16-bit files", async () => {
    const { writeArrayBuffer } = await import("geotiff");
    const keys = { GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32633, ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, 500000, 5000000, 0] };
    const files = [
      writeFile(g, 2, new Uint8Array(128).fill(1)),
      writeArrayBuffer(new Int8Array(64).fill(1) as unknown as Uint8Array, { width: 8, height: 8, SampleFormat: [2], BitsPerSample: [8], ...keys }),
      writeArrayBuffer(new Float32Array(64).fill(1) as unknown as Uint8Array, { width: 8, height: 8, ...keys }),
      writeFile(g, 1, new Uint16Array(64).fill(1)),
    ];
    for (const f of files) await expect(open(f)).rejects.toBeInstanceOf(LabelFileRefused);
  });

  it("opens 8-bit files in EPSG:4326, 3857, 32733 and a UTM 60 file across 180 (spec 001 refuses only 4326/3857 across 180)", async () => {
    for (const [epsg, gt] of [[3857, [1669792, 30, 0, 5621521, 0, -30]], [32733, [300000, 30, 0, 7000000, 0, -30]], [32660, [799000, 300, 0, 5560000, 0, -300]]] as const) {
      const f = await open(writeFile({ ...g, epsg, gt: [...gt] }, 1, u8, undefined, { GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: epsg }));
      expect(f.meta.epsg).toBe(epsg);
    }
    const geog = { GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326 };
    expect((await open(writeFile({ ...g, epsg: 4326, gt: [15, 0.01, 0, 45, 0, -0.01] }, 1, u8, undefined, geog))).meta.epsg).toBe(4326);
    const merc = { GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 3857 };
    await expect(open(writeFile({ ...g, epsg: 3857, gt: [20037000, 1000, 0, 0, 0, -1000] }, 1, u8, undefined, merc)))
      .rejects.toSatisfy((e) => e instanceof RasterRefusedError && e.reason === "antimeridian");
  });

  it("reads GDAL_NODATA 255.0 as 255, and 256 or -1 as null", async () => {
    for (const [nd, want] of [["255.0", 255], ["256", null], ["-1", null], ["7", 7]] as const) expect((await open(classFile(nd, g, () => 1))).meta.nodata, nd).toBe(want);
  });
});
