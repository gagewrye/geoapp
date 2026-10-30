import { expect, test } from "@playwright/test";
import { fromArrayBuffer } from "geotiff";
import { uint8Tiff } from "../unit/helpers/tiffFixtures";
import { jumpTo, labels, message, openApp, openRaster, paintMode, path, stroke, toScreen } from "./helpers";
import { arrayBuffer, at, download, importFile, maskFile, maskValue, noSavePicker } from "./seeding";

// Spec 022 criterion 6: on RGBA imagery, transparent pixels (alpha 0) take no label from a stroke, an import or an export.

const EDGE = 100; // columns 0..99 are transparent
/** rgbFixture's grid as RGBA uint8 in 1-row strips with ExtraSamples 2, like Gage's chunks: transparent black west of EDGE. */
const rgbaFixture = () => ({
  name: "rgba4326.tif", mimeType: "image/tiff",
  buffer: Buffer.from(uint8Tiff([{ width: 1000, height: 1000, bands: 4, layout: { rows: 1 }, extraSamples: [2],
    value: (k, c, r) => (c < EDGE ? 0 : k === 3 ? 255 : 80 + ((c + r + 40 * k) % 120)) }], { epsg: 4326, gt: [10, 0.01, 0, 50, 0, -0.01] })),
});
const seeded = /^Seeded \d+ pixels in \d+ classes\.$/;
const col = (key: string) => Number(key.split(",")[0]);

test("a stroke across the transparent edge, an import over it and its export label only opaque pixels", async ({ page }) => {
  test.setTimeout(180_000);
  await noSavePicker(page);
  await openApp(page);
  await openRaster(page, rgbaFixture());
  await expect(message(page)).toHaveText("Raster opened.");

  await paintMode(page);
  await jumpTo(page, at(EDGE, 500), 10);
  await stroke(page, path(await toScreen(page, at(EDGE - 10.5, 500.5)), await toScreen(page, at(EDGE + 10.5, 500.5)), 8));
  const painted = [...(await labels(page)).keys()];
  expect(painted.some((k) => col(k) >= EDGE)).toBe(true);
  expect(painted.filter((k) => col(k) < EDGE)).toEqual([]);

  page.once("dialog", (d) => void d.accept()); // Replace labels?
  await importFile(page, maskFile());
  await expect(message(page)).toHaveText(seeded);
  const imported = await labels(page);
  expect([...imported.keys()].filter((k) => col(k) < EDGE)).toEqual([]);
  // every opaque pixel keeps the mask's value
  let bad = 0;
  for (let r = 0; r < 1000; r += 7) for (let c = EDGE; c < 1000; c += 7) if ((imported.get(`${c},${r}`) ?? 0) !== maskValue(c, r)) bad++;
  expect(bad).toBe(0);

  const file = await download(page, "#export-labels");
  await expect(message(page)).toHaveText("Labels exported.");
  const img = await (await fromArrayBuffer(arrayBuffer(file))).getImage();
  const [band] = (await img.readRasters({ samples: [0] })) as unknown as Uint8Array[];
  let west = 0, eastBad = 0;
  for (let r = 0; r < 1000; r++) for (let c = 0; c < 1000; c++) {
    const v = band![r * 1000 + c]!;
    if (c < EDGE) { if (v) west++; } else if (v !== maskValue(c, r)) eastBad++;
  }
  expect([west, eastBad]).toEqual([0, 0]);
});
