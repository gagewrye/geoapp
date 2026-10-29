import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AefEntry } from "../../../src/core/aef";

// Tester edge cases for spec 002 criterion 16 and the committed index.
const run = promisify(execFile);
const SCRIPT = "scripts/build_aef_index.mjs";
const PREFIX = "s3://us-west-2.opendata.source.coop/tge-labs/aef/v1/annual/";
const HEAD = "WKT,crs,path,year,utm_zone,utm_west,utm_south,utm_east,utm_north";
const row = (crs: string, path: string, year: string, b = "418080,2785280,500000,2867200") => `"POLYGON((0 0,1 0,1 1,0 0))",${crs},${path},${year},17N,${b}`;
const good = (year = "2021", name = "a") => row("EPSG:32617", `${PREFIX}${year}/17N/${name}.tiff`, year);

async function build(csv: string) {
  const dir = await mkdtemp(join(tmpdir(), "aef-tester-"));
  const file = join(dir, "in.csv"), out = join(dir, "out");
  await writeFile(file, csv);
  return { out, result: run("node", [SCRIPT, file, out]) };
}

describe("index build script edges (tester, criterion 16)", () => {
  it.each([
    ["ESRI:102100", "ESRI"], ["EPSG:", "EPSG:"], ["epsg:32617", "epsg"], ["", '""'], ["EPSG:32617 ", "32617 "],
  ])("fails on crs %j", async (crs, shown) => {
    const { result } = await build([HEAD, good(), row(crs, `${PREFIX}2021/17N/b.tiff`, "2021")].join("\n"));
    await expect(result).rejects.toThrow(new RegExp(`line 3: crs .*${shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it.each([
    ["https://data.source.coop/tge-labs/aef/v1/annual/2021/17N/b.tiff"],
    ["s3://us-west-2.opendata.source.coop/tge-labs/aef/v1/annual2021/17N/b.tiff"],
    ["S3://US-WEST-2.opendata.source.coop/tge-labs/aef/v1/annual/2021/17N/b.tiff"],
    [""],
  ])("fails on path %j", async (path) => {
    const { result } = await build([HEAD, good(), row("EPSG:32617", path, "2021")].join("\n"));
    await expect(result).rejects.toThrow(/line 3: path .*does not start with/);
  });

  it("fails on a missing column and on a non-numeric year or bound", async () => {
    await expect((await build(["WKT,crs,path,year,utm_zone,utm_west,utm_south,utm_east", good()].join("\n"))).result).rejects.toThrow(/missing columns utm_north/);
    await expect((await build([HEAD, good(), row("EPSG:32617", `${PREFIX}x.tiff`, "")].join("\n"))).result).rejects.toThrow(/line 3: year/);
    await expect((await build([HEAD, row("EPSG:32617", `${PREFIX}x.tiff`, "2021", "418080,,500000,2867200")].join("\n"))).result).rejects.toThrow(/line 2: utm_south/);
  });

  it("fails on an empty file", async () => {
    await expect((await build("")).result).rejects.toThrow(/empty CSV/);
  });

  it("reads CRLF line endings, a trailing line without newline, and blank lines", async () => {
    const { out, result } = await build([HEAD, good("2021", "a"), "", good("2019", "b")].join("\r\n"));
    await result;
    expect(JSON.parse(await readFile(join(out, "years.json"), "utf8"))).toEqual([2019, 2021]);
    const e: AefEntry[] = JSON.parse(await readFile(join(out, "2021", "32617.json"), "utf8"));
    expect(e).toEqual([{ year: 2021, epsg: 32617, path: "2021/17N/a.tiff", x0: 418080, y0: 2785280, x1: 500000, y1: 2867200 }]);
  });

  it("orders years numerically, not as strings, across many years", async () => {
    const years = ["2025", "2017", "2100", "999", "2018"];
    const { out, result } = await build([HEAD, ...years.map((y, i) => good(y, `f${i}`))].join("\n"));
    await result;
    expect(JSON.parse(await readFile(join(out, "years.json"), "utf8"))).toEqual([999, 2017, 2018, 2025, 2100]);
  });

  // Tester found a header-only CSV (e.g. a truncated download) succeeded, wrote years.json []
  // and deleted every existing {year}/ shard directory in the output (F5).
  it("a header-only CSV fails instead of wiping the index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aef-tester-"));
    const file = join(dir, "in.csv"), out = join(dir, "out");
    await mkdir(join(out, "2021"), { recursive: true });
    await writeFile(join(out, "2021", "32617.json"), "[]");
    await writeFile(file, HEAD + "\n");
    await expect(run("node", [SCRIPT, file, out])).rejects.toThrow();
    expect(await readdir(out)).toContain("2021");
  });
});

describe("committed public/aef-index (tester, spec 002 Index rule)", () => {
  it("years.json is ascending, and every committed shard holds only its own year and EPSG:32617 entries", async () => {
    const dir = "public/aef-index";
    const years: number[] = JSON.parse(await readFile(join(dir, "years.json"), "utf8"));
    expect(years.length).toBeGreaterThan(0);
    expect([...years].sort((a, b) => a - b)).toEqual(years);
    expect(new Set(years).size).toBe(years.length);
    const dirs = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => Number(d.name));
    expect(dirs.sort((a, b) => a - b)).toEqual(years);
    for (const y of years) {
      expect(await readdir(join(dir, String(y)))).toEqual(["32617.json"]);
      const list: AefEntry[] = JSON.parse(await readFile(join(dir, String(y), "32617.json"), "utf8"));
      expect(list.length).toBeGreaterThan(0);
      for (const e of list) {
        expect(e.year).toBe(y);
        expect(e.epsg).toBe(32617);
        expect(e.path).toMatch(new RegExp(`^${y}/17N/[a-z0-9]+-\\d{10}-\\d{10}\\.tiff$`));
        expect(e.x0 % 10 === 0 && e.y0 % 10 === 0 && e.x1 % 10 === 0 && e.y1 % 10 === 0).toBe(true);
        expect(e.x1).toBeGreaterThan(e.x0); expect(e.y1).toBeGreaterThan(e.y0);
      }
      expect(new Set(list.map((e) => e.path)).size).toBe(list.length);
    }
    expect(await readFile(join(dir, "NOTICE"), "utf8")).toMatch(/Google and Google DeepMind[\s\S]*CC BY 4\.0/);
  });
});
