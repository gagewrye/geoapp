#!/usr/bin/env node
// Build the static AlphaEarth tile index (ADR 0006) from the host's aef_index.csv.
// Usage: node scripts/build_aef_index.mjs [csv path or URL] [out dir] [--epsg=32617,...]
// Writes {out}/years.json, {out}/{year}/{epsg}.json (AefEntry[], spec 002) and {out}/NOTICE.
// The CSV is ~800 MB, so it is streamed line by line.
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

// Keep in sync with AEF_BASE in src/core/aef.ts.
const AEF_BASE = "https://data.source.coop/tge-labs/aef/v1/annual/";
const S3_PREFIX = "s3://us-west-2.opendata.source.coop/tge-labs/aef/v1/annual/";
const COLUMNS = ["crs", "path", "year", "utm_west", "utm_south", "utm_east", "utm_north"];

const NOTICE = `AlphaEarth Foundations Satellite Embedding dataset, produced by Google and Google DeepMind.
Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
This index is derived from aef_index.csv of the Source Cooperative copy (${AEF_BASE}),
which is not officially supported by Google.
`;

/** Split one CSV line, honouring double quotes ("" is an escaped quote). */
function splitCsv(line, lineNo) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (quoted) throw new Error(`line ${lineNo}: unterminated quote`);
  out.push(cur);
  return out;
}

function fail(lineNo, msg) {
  throw new Error(`line ${lineNo}: ${msg}`);
}

function entryOf(cells, col, lineNo) {
  const crs = cells[col.crs];
  const m = /^EPSG:(\d+)$/.exec(crs ?? "");
  if (!m) fail(lineNo, `crs ${JSON.stringify(crs)} is not EPSG:NNNNN`);
  const path = cells[col.path] ?? "";
  if (!path.startsWith(S3_PREFIX)) fail(lineNo, `path ${JSON.stringify(path)} does not start with ${S3_PREFIX}`);
  const num = (name) => {
    const v = Number(cells[col[name]]);
    if (!Number.isFinite(v) || cells[col[name]] === "") fail(lineNo, `${name} ${JSON.stringify(cells[col[name]])} is not a number`);
    return v;
  };
  return { year: num("year"), epsg: Number(m[1]), path: path.slice(S3_PREFIX.length),
    x0: num("utm_west"), y0: num("utm_south"), x1: num("utm_east"), y1: num("utm_north") };
}

async function lines(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok || !res.body) throw new Error(`GET ${src}: ${res.status}`);
    return createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  }
  return createInterface({ input: createReadStream(src), crlfDelay: Infinity });
}

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const [src = `${AEF_BASE}aef_index.csv`, out = "public/aef-index"] = args.filter((a) => !a.startsWith("--"));
  const only = flags.find((f) => f.startsWith("--epsg="))?.slice(7).split(",").map(Number);

  const shards = new Map(); // "year/epsg" -> AefEntry[]
  const years = new Set();
  let col = null, lineNo = 0, rows = 0;
  for await (const line of await lines(src)) {
    lineNo++;
    if (line === "") continue;
    const cells = splitCsv(line, lineNo);
    if (!col) {
      col = Object.fromEntries(COLUMNS.map((c) => [c, cells.indexOf(c)]));
      const missing = COLUMNS.filter((c) => col[c] < 0);
      if (missing.length) fail(lineNo, `missing columns ${missing.join(", ")}`);
      continue;
    }
    const e = entryOf(cells, col, lineNo);
    rows++;
    years.add(e.year);
    if (only && !only.includes(e.epsg)) continue;
    const key = `${e.year}/${e.epsg}`;
    if (!shards.has(key)) shards.set(key, []);
    shards.get(key).push(e);
  }
  if (!col) throw new Error(`${src}: empty CSV`);
  // a truncated download can end right after the header; it must not replace a good index
  if (rows === 0) throw new Error(`${src}: no data rows`);

  await mkdir(out, { recursive: true });
  // Build next to out (same filesystem, so rename works) and swap in only once it is complete.
  const tmp = await mkdtemp(join(dirname(resolve(out)), ".aef-index-tmp-"));
  try {
    for (const [key, list] of shards) {
      const [year, epsg] = key.split("/");
      await mkdir(join(tmp, year), { recursive: true });
      await writeFile(join(tmp, year, `${epsg}.json`), JSON.stringify(list));
    }
    await writeFile(join(tmp, "years.json"), JSON.stringify([...years].sort((a, b) => a - b)));
    await writeFile(join(tmp, "NOTICE"), NOTICE);
    await swapIn(tmp, out);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(`${rows} rows -> ${shards.size} shards, years ${[...years].sort().join(", ")}`);
}

/** Replace what this script owns in out ({year}/, years.json, NOTICE) with tmp's; other files stay. */
async function swapIn(tmp, out) {
  // A sibling of out, not inside tmp: main's cleanup of tmp must never delete the old index.
  const old = await mkdtemp(join(dirname(resolve(out)), ".aef-index-old-"));
  const movedOut = [], movedIn = [];
  try {
    // Move only what this script writes, so stale shards go but a mistyped out dir is not wiped.
    for (const d of await readdir(out, { withFileTypes: true })) {
      if ((d.isDirectory() && /^\d{4}$/.test(d.name)) || d.name === "years.json" || d.name === "NOTICE") {
        await rename(join(out, d.name), join(old, d.name));
        movedOut.push(d.name);
      }
    }
    for (const name of await readdir(tmp)) {
      await rename(join(tmp, name), join(out, name));
      movedIn.push(name);
    }
  } catch (e) {
    try {
      for (const name of movedIn) await rm(join(out, name), { recursive: true, force: true });
      for (const name of movedOut) await rename(join(old, name), join(out, name));
    } catch (undo) {
      throw new Error(`${e.message}; restoring the old index also failed (${undo.message}), it is in ${old}`, { cause: undo });
    }
    await rm(old, { recursive: true, force: true });
    throw e;
  }
  await rm(old, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(`build_aef_index: ${e.message}`);
  process.exit(1);
});
