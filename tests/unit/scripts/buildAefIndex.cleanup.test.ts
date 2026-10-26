import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Deleting the emptied .aef-index-old-* folder is cleanup: its failure must neither fail a good
// build nor hide why a bad one failed.
const run = promisify(execFile);
const SCRIPT = "scripts/build_aef_index.mjs";
const CSV = "tests/fixtures/aef-index/aef_index.csv";

// FAIL="rename:4,rm:1": the 4th rename and the 1st rm (fs/promises) throw EIO.
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

async function attempt(fail: string) {
  const parent = await mkdtemp(join(tmpdir(), "aef-cleanup-"));
  const out = join(parent, "out");
  await mkdir(join(out, "2019"), { recursive: true });
  for (const [k, v] of Object.entries(OLD)) await writeFile(join(out, k), v);
  const preload = join(await mkdtemp(join(tmpdir(), "aef-preload-")), "fail.cjs");
  await writeFile(preload, PRELOAD);
  const res = await run("node", ["--require", preload, SCRIPT, CSV, out], { env: { ...process.env, FAIL: fail } })
    .then((r) => ({ code: 0, stderr: r.stderr }), (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }));
  const old = (await readdir(parent)).filter((n) => n.startsWith(".aef-index-old-")).map((n) => join(parent, n));
  return { out, old, ...res };
}

describe("old index folder cleanup (review optional item 1)", () => {
  it("a failed delete after a good swap warns, naming the folder, and exits 0 with the new index in place", async () => {
    const r = await attempt("rm:1");
    expect(r.code).toBe(0);
    expect(r.old).toHaveLength(1);
    expect(r.stderr).toContain(r.old[0]);
    expect(r.stderr).toContain("injected rm failure #1");
    expect(await readFile(join(r.out, "years.json"), "utf8")).toBe("[2017,2018,2021,2025]");
  });

});
