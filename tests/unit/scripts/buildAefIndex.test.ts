import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AefEntry } from "../../../src/core/aef";

const run = promisify(execFile);
const SCRIPT = "scripts/build_aef_index.mjs";
const CSV = "tests/fixtures/aef-index/aef_index.csv";
const PREFIX = "s3://us-west-2.opendata.source.coop/tge-labs/aef/v1/annual/";

async function build(csv: string, ...args: string[]) {
  const out = await mkdtemp(join(tmpdir(), "aef-index-"));
  await run("node", [SCRIPT, csv, out, ...args]);
  return out;
}

async function shards(out: string): Promise<Map<string, AefEntry[]>> {
  const m = new Map<string, AefEntry[]>();
  for (const year of (await readdir(out, { withFileTypes: true })).filter((d) => d.isDirectory())) {
    for (const f of await readdir(join(out, year.name))) m.set(`${year.name}/${f}`, JSON.parse(await readFile(join(out, year.name, f), "utf8")));
  }
  return m;
}

/** CSV rows as [crs, path, year, west, south, east, north], skipping the quoted WKT. */
async function csvRows(): Promise<string[][]> {
  const lines = (await readFile(CSV, "utf8")).trim().split("\n").slice(1);
  return lines.map((l) => l.slice(l.lastIndexOf('"') + 2).split(",")).map((c) => [c[0]!, c[1]!, c[2]!, c[4]!, c[5]!, c[6]!, c[7]!]);
}

describe("index build script (criterion 16)", () => {
  it("puts every row in exactly one {year}/{epsg}.json shard", async () => {
    const out = await build(CSV);
    const all = await shards(out);
    const rows = await csvRows();
    expect(rows.length).toBe(7);
    for (const [crs, path, year, w, s, e, n] of rows) {
      const epsg = Number(crs!.replace("EPSG:", ""));
      const rel = path!.slice(PREFIX.length);
      const hits = [...all].flatMap(([name, list]) => list.filter((x) => x.path === rel).map(() => name));
      expect(hits).toEqual([`${year}/${epsg}.json`]);
      const entry = all.get(`${year}/${epsg}.json`)!.find((x) => x.path === rel);
      expect(entry).toEqual({ year: Number(year), epsg, path: rel, x0: Number(w), y0: Number(s), x1: Number(e), y1: Number(n) });
    }
    expect([...all.values()].reduce((s, l) => s + l.length, 0)).toBe(rows.length);
    expect([...all.keys()].sort()).toEqual(["2017/32617.json", "2018/32617.json", "2018/32701.json", "2021/32617.json", "2025/32760.json"]);
  });

  it("lists the years ascending in years.json and writes the attribution", async () => {
    const out = await build(CSV);
    expect(JSON.parse(await readFile(join(out, "years.json"), "utf8"))).toEqual([2017, 2018, 2021, 2025]);
    expect(await readFile(join(out, "NOTICE"), "utf8")).toMatch(/CC BY 4\.0/);
  });

  it("writes only the requested zones with --epsg, but every year", async () => {
    const out = await build(CSV, "--epsg=32617");
    expect([...(await shards(out)).keys()].sort()).toEqual(["2017/32617.json", "2018/32617.json", "2021/32617.json"]);
    expect(JSON.parse(await readFile(join(out, "years.json"), "utf8"))).toEqual([2017, 2018, 2021, 2025]);
  });

  it("fails loudly on a path outside the expected prefix", async () => {
    const bad = join(await mkdtemp(join(tmpdir(), "aef-csv-")), "bad.csv");
    const text = await readFile(CSV, "utf8");
    await writeFile(bad, text.replace(`${PREFIX}2018/1S/x274oc2wyfxts9juj-0000008192`, "s3://elsewhere/2018/1S/x274oc2wyfxts9juj-0000008192"));
    await expect(build(bad)).rejects.toThrow(/line 5.*s3:\/\/elsewhere/s);
  });
});
