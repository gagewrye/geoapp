import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Tester re-verification of follow-up T1 (review issue 2): the old index moves to a sibling
// .aef-index-old-* folder and is moved back when the swap fails. Here the restore itself is made
// to fail too, and every single rename / rm position is swept.
const run = promisify(execFile);
const SCRIPT = "scripts/build_aef_index.mjs";
const CSV = "tests/fixtures/aef-index/aef_index.csv"; // years 2017, 2018, 2021, 2025

// FAIL="rename:7,rm:1": the 7th rename and the 1st rm (fs/promises) throw EIO.
const PRELOAD = `
const fs = require("node:fs");
const plan = {};
for (const p of (process.env.FAIL || "").split(",").filter(Boolean)) { const [fn, at] = p.split(":"); (plan[fn] ??= new Set()).add(Number(at)); }
for (const fn of Object.keys(plan)) {
  const orig = fs.promises[fn];
  let n = 0;
  fs.promises[fn] = async (...a) => {
    if (plan[fn].has(++n)) throw Object.assign(new Error("injected " + fn + " failure #" + n), { code: "EIO" });
    return orig(...a);
  };
}
require("node:module").syncBuiltinESMExports();
`;
const OLD = { "2019/32617.json": "[\"old\"]", "years.json": "[2019]", NOTICE: "old notice" };
const NEW_YEARS = "[2017,2018,2021,2025]";

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const d of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (d.isFile()) out[join(d.parentPath, d.name).slice(dir.length + 1)] = await readFile(join(d.parentPath, d.name), "utf8");
  }
  return out;
}

async function attempt(fail: string) {
  const parent = await mkdtemp(join(tmpdir(), "aef-restore-"));
  const out = join(parent, "out");
  await mkdir(join(out, "2019"), { recursive: true });
  for (const [k, v] of Object.entries(OLD)) await writeFile(join(out, k), v);
  await writeFile(join(out, "keep.txt"), "not ours");
  const preload = join(await mkdtemp(join(tmpdir(), "aef-preload-")), "fail.cjs");
  await writeFile(preload, PRELOAD);
  const res = await run("node", ["--require", preload, SCRIPT, CSV, out], { env: { ...process.env, FAIL: fail } })
    .then(() => ({ code: 0, stderr: "" }), (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }));
  return { parent, out, ...res };
}

describe("index swap restore (tester, T1 / criterion 16)", () => {
  // renames: #1-#3 move the 3 old entries aside, #4-#9 move the 6 new ones in, #10.. move the old back
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])("rename failure #%d alone: exit 1, the old index is back exactly, no folder left beside out", async (at) => {
    const r = await attempt(`rename:${at}`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`injected rename failure #${at}`);
    expect(await snapshot(r.out)).toEqual({ ...OLD, "keep.txt": "not ours" });
    expect(await readdir(r.parent)).toEqual(["out"]);
  });

  it("success leaves no .aef-index-old-* or temp folder beside out", async () => {
    const r = await attempt("");
    expect(r.code).toBe(0);
    expect(await readFile(join(r.out, "years.json"), "utf8")).toBe(NEW_YEARS);
    expect(await readdir(r.parent)).toEqual(["out"]);
  });

  // swap fails at rename k (a move-in), then the first or second move-back fails too
  it.each([[4, 5], [7, 8], [9, 10], [7, 9], [5, 7]])("rename #%d fails and the restore's rename #%d fails: exit 1, the message names the folder holding the rest of the old index, nothing lost, no new entries in out", async (k, j) => {
    const r = await attempt(`rename:${k},rename:${j}`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`injected rename failure #${k}`);
    expect(r.stderr).toContain("restoring the old index also failed");
    const m = /it is in (\S+)\s*$/.exec(r.stderr.trim());
    expect(m, r.stderr).not.toBeNull();
    const oldDir = m![1]!;
    expect(oldDir.startsWith(join(r.parent, ".aef-index-old-"))).toBe(true);
    const inOut = await snapshot(r.out), inOld = await snapshot(oldDir);
    expect({ ...inOut, ...inOld }).toEqual({ ...OLD, "keep.txt": "not ours" }); // every old file somewhere, no new one
    expect(Object.keys(inOut).filter((f) => f in inOld)).toEqual([]);
    expect((await readdir(r.parent)).sort()).toEqual([oldDir.slice(r.parent.length + 1), "out"].sort()); // temp dir gone
  });

  it("rename #7 fails and removing a moved-in entry fails: the old index is intact in the named folder", async () => {
    const r = await attempt("rename:7,rm:1");
    expect(r.code).toBe(1);
    const m = /it is in (\S+)\s*$/.exec(r.stderr.trim());
    expect(m, r.stderr).not.toBeNull();
    expect(await snapshot(m![1]!)).toEqual(OLD);
  });

  // after a successful swap: rm #1 is the old folder, rm #2 the temp dir
  it.each([1, 2])("rm failure #%d after a successful swap: out holds exactly the new index, never a mix", async (at) => {
    const clean = await snapshot((await attempt("")).out);
    const r = await attempt(`rm:${at}`);
    expect(await snapshot(r.out)).toEqual(clean);
  });
});
