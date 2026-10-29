import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Tester re-verification of F5's temp-dir swap: a failure while writing or swapping must leave
// the old index exactly as it was, and leave no temp dir behind.
const run = promisify(execFile);
const SCRIPT = "scripts/build_aef_index.mjs";
const CSV = "tests/fixtures/aef-index/aef_index.csv"; // years 2017, 2018, 2021, 2025

// Preload that makes the Nth call of one fs/promises function fail, like a full disk would.
const PRELOAD = `
const fs = require("node:fs");
const fn = process.env.FAIL_FN, at = Number(process.env.FAIL_AT);
const orig = fs.promises[fn];
let n = 0;
fs.promises[fn] = async (...a) => {
  if (++n === at) throw Object.assign(new Error("injected " + fn + " failure #" + n), { code: "EIO" });
  return orig(...a);
};
require("node:module").syncBuiltinESMExports();
`;

/** An existing index (old shard, years.json, NOTICE) plus a file the script does not own. */
async function existingOut() {
  const parent = await mkdtemp(join(tmpdir(), "aef-swap-"));
  const out = join(parent, "out");
  await mkdir(join(out, "2019"), { recursive: true });
  await writeFile(join(out, "2019", "32617.json"), "[\"old\"]");
  await writeFile(join(out, "years.json"), "[2019]");
  await writeFile(join(out, "NOTICE"), "old notice");
  await writeFile(join(out, "keep.txt"), "not ours");
  const preload = join(await mkdtemp(join(tmpdir(), "aef-preload-")), "fail.cjs");
  await writeFile(preload, PRELOAD);
  return { parent, out, preload };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const d of await readdir(dir, { withFileTypes: true, recursive: true })) {
    // keys use "/" on every OS, so the expected snapshots read the same on Windows
    if (d.isFile()) out[join(d.parentPath, d.name).slice(dir.length + 1).split(sep).join("/")] = await readFile(join(d.parentPath, d.name), "utf8");
  }
  return out;
}
const OLD = { "2019/32617.json": "[\"old\"]", "years.json": "[2019]", NOTICE: "old notice", "keep.txt": "not ours" };

async function failing(fn: string, at: number) {
  const { parent, out, preload } = await existingOut();
  const result = run("node", ["--require", preload, SCRIPT, CSV, out], { env: { ...process.env, FAIL_FN: fn, FAIL_AT: String(at) } });
  return { parent, out, result };
}

describe("index swap under failure (tester, F5 / criterion 16)", () => {
  it("the preload does inject: with no failure the build succeeds", async () => {
    const { out, result } = await failing("writeFile", 999);
    await result;
    expect(JSON.parse(await readFile(join(out, "years.json"), "utf8"))).toEqual([2017, 2018, 2021, 2025]);
  });

  // 4 shards + years.json + NOTICE = 6 writes into the temp dir
  it.each([1, 3, 5, 6])("writeFile failure #%d (mid-write): exit 1, old index intact, no temp dir", async (at) => {
    const { parent, out, result } = await failing("writeFile", at);
    await expect(result).rejects.toThrow(/injected writeFile failure/);
    expect(await snapshot(out)).toEqual(OLD);
    expect(await readdir(parent)).toEqual(["out"]);
  });

  it("mkdir failure while building shard dirs: old index intact, no temp dir", async () => {
    // mkdir #1 is `mkdir(out, recursive)`, #2 the first year dir in the temp dir
    const { parent, out, result } = await failing("mkdir", 2);
    await expect(result).rejects.toThrow(/injected mkdir failure/);
    expect(await snapshot(out)).toEqual(OLD);
    expect(await readdir(parent)).toEqual(["out"]);
  });

  // swapIn renames: #1-#3 move 2019, years.json, NOTICE aside; #4.. move the new ones in.
  // Tester follow-up T1 (fixed): the old entries sat in tmp/.old, which the cleanup deleted.
  it.each([2, 4, 7])("rename failure #%d (mid-swap): exit 1 and the old index is still there", async (at) => {
    const { parent, out, result } = await failing("rename", at);
    await expect(result).rejects.toThrow(/injected rename failure/);
    expect(await snapshot(out)).toEqual(OLD);
    expect(await readdir(parent)).toEqual(["out"]);
  });

  it("without injection: a plain file named like a year in out makes the swap fail, and the old index must survive", async () => {
    const { parent, out } = await existingOut();
    await writeFile(join(out, "2021"), "a stray file, not a shard dir");
    await expect(run("node", [SCRIPT, CSV, out])).rejects.toThrow();
    expect(await snapshot(out)).toEqual({ ...OLD, "2021": "a stray file, not a shard dir" });
    expect(await readdir(parent)).toEqual(["out"]);
  });
});
