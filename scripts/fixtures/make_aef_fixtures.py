#!/usr/bin/env python3
"""Write spec 002's offline AlphaEarth fixtures (ADR 0007) from mangrove-embed chips.

Usage: python3 scripts/fixtures/make_aef_fixtures.py <data/chips dir> [out dir] [--region everglades]
       [--epsg 32617] [--year 2021] [--real 2021/17N/<name>]
Needs numpy and scikit-learn (mangrove-embed's environment) and network access for (d).
Reads <chips>/<region>/index.csv (x0,y1 = upper-left corner; optional chip, epsg, split columns)
and <chips>/<region>/chip_NNNN.npz (x float16 [64,128,128], invalid pixels all zero; y uint8 1..11,
255 = ignore). Without a chip column, row i is chip i; without a split column, even chips train.
A standin.json in <chips> marks ADR 0008 stand-ins and switches the NOTICE.
"""
import argparse
import csv
import json
import struct
import urllib.request
import zlib
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

AEF_BASE = "https://data.source.coop/tge-labs/aef/v1/annual/"
BANDS, N, RES, TILE = 64, 128, 10, 32
MANGROVE = 10
PER_SPLIT = 1000
HEAD_BYTES = 256 * 1024
# The host answers 403 to urllib's default "Python-urllib" user agent.
UA = {"User-Agent": "geoapp-fixtures/1 (make_aef_fixtures.py)"}


def requantize(x: np.ndarray) -> np.ndarray:
    """Invert sign(q)(q/127.5)^2 to Int8; all-zero vectors become -128."""
    xf = x.astype(np.float64)
    q = np.clip(np.rint(np.sign(xf) * np.sqrt(np.abs(xf)) * 127.5), -127, 127).astype(np.int8)
    q[:, (xf == 0).all(axis=0)] = -128
    return q


def dequantize(q: np.ndarray) -> np.ndarray:
    qf = q.astype(np.float64)
    return np.sign(qf) * (qf / 127.5) ** 2


def load_region(region_dir: Path, default_epsg: int) -> list[dict]:
    with open(region_dir / "index.csv", newline="") as f:
        rows = list(csv.DictReader(f))
    chips = []
    for i, row in enumerate(rows):
        cid = int(row["chip"]) if row.get("chip") else i
        d = np.load(region_dir / f"chip_{cid:04d}.npz")
        split = row.get("split") or ("train" if cid % 2 == 0 else "test")
        chips.append({"id": cid, "x0": float(row["x0"]), "y1": float(row["y1"]), "split": split,
                      "epsg": int(row["epsg"]) if row.get("epsg") else default_epsg,
                      "q": requantize(d["x"]), "y": d["y"].astype(np.uint8)})
    return chips


def pick_fixture_chip(chips: list[dict]) -> dict:
    """Prefer chips with invalid pixels, then more distinct labels, then mangrove share nearest 50%."""
    def key(c):
        valid = c["y"] != 255
        share = (c["y"] == MANGROVE).sum() / max(1, valid.sum())
        return (-int((c["q"][0] == -128).any()), -len(np.unique(c["y"][valid])), abs(share - 0.5), c["id"])
    return min(chips, key=key)


def tiff(q: np.ndarray, epsg: int, x0: float, y1: float, bottom_up: bool) -> bytes:
    """Tiled, deflated, band-separate Int8 GeoTIFF of q [64][h][w] (north-up) with upper-left (x0, y1)."""
    nb, h, w = q.shape
    rows = q[:, ::-1, :] if bottom_up else q
    tiles = []
    for b in range(nb):
        for ty in range(0, h, TILE):
            for tx in range(0, w, TILE):
                t = np.full((TILE, TILE), -128, np.int8)
                part = rows[b, ty:ty + TILE, tx:tx + TILE]
                t[:part.shape[0], :part.shape[1]] = part
                tiles.append(zlib.compress(t.tobytes(), 9))
    if bottom_up:  # like Source Cooperative: positive y scale, origin at the south-west corner
        geo = [(34264, 12, [RES, 0, 0, x0, 0, RES, 0, y1 - RES * h, 0, 0, 0, 0, 0, 0, 0, 1])]
    else:
        geo = [(33550, 12, [RES, RES, 0]), (33922, 12, [0, 0, 0, x0, y1, 0])]
    entries = [(256, 4, [w]), (257, 4, [h]), (258, 3, [8] * nb), (259, 3, [8]), (262, 3, [1]),
               (277, 3, [nb]), (284, 3, [2]), (322, 3, [TILE]), (323, 3, [TILE]),
               (324, 4, None), (325, 4, [len(t) for t in tiles]), (338, 3, [0] * (nb - 1)),
               (339, 3, [2] * nb), *geo,
               (34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg]),
               (42113, 2, b"-128\0")]
    fmt = {2: "s", 3: "H", 4: "I", 12: "d"}
    size = {2: 1, 3: 2, 4: 4, 12: 8}
    count = lambda e: len(e[2]) if e[2] is not None else len(tiles)
    ifd_at = 8
    data_at = ifd_at + 2 + 12 * len(entries) + 4
    extra = sum((count(e) * size[e[1]] + 1) & ~1 for e in entries if count(e) * size[e[1]] > 4)
    first_tile = data_at + extra
    offsets, at = [], first_tile
    for t in tiles:
        offsets.append(at)
        at += len(t)
    ifd, blob = struct.pack("<H", len(entries)), b""
    for tag, typ, vals in entries:
        vals = offsets if vals is None else vals
        raw = vals if typ == 2 else struct.pack(f"<{len(vals)}{fmt[typ]}", *vals)
        n = len(vals)
        if len(raw) <= 4:
            ifd += struct.pack("<HHI", tag, typ, n) + raw.ljust(4, b"\0")
        else:
            ifd += struct.pack("<HHII", tag, typ, n, data_at + len(blob))
            blob += raw + (b"\0" if len(raw) & 1 else b"")
    ifd += struct.pack("<I", 0)
    return b"II" + struct.pack("<HI", 42, ifd_at) + ifd + blob + b"".join(tiles)


def write_cogs(out: Path, chip: dict, year: int) -> list[dict]:
    """(a) and (b): three mixed-orientation COGs, a 5 m-shifted copy, the reference chip, index shards."""
    q, epsg, x0, y1 = chip["q"], chip["epsg"], chip["x0"], chip["y1"]
    half = N // 2
    zone = f"{epsg % 100}{'N' if epsg < 32700 else 'S'}"
    parts = [("west-bottomup", q[:, :, :half], x0, y1, True),
             ("ne-topdown", q[:, :half, half:], x0 + RES * half, y1, False),
             ("se-bottomup", q[:, half:, half:], x0 + RES * half, y1 - RES * half, True),
             ("ne-shifted5m", q[:, :half, half:], x0 + RES * half + 5, y1, False)]
    entries = []
    for name, data, px0, py1, bottom_up in parts:
        path = f"{year}/{zone}/fixture-{name}.tiff"
        (out / "cogs" / path).parent.mkdir(parents=True, exist_ok=True)
        (out / "cogs" / path).write_bytes(tiff(data, epsg, px0, py1, bottom_up))
        _, h, w = data.shape
        entry = {"year": year, "epsg": epsg, "path": path, "x0": px0, "y0": py1 - RES * h, "x1": px0 + RES * w, "y1": py1}
        if name != "ne-shifted5m":
            entries.append(entry)
        else:
            (out / "shifted-entry.json").write_text(json.dumps(entry))
    (out / "ref_chip.i8").write_bytes(q.tobytes())
    (out / "ref_chip.json").write_text(json.dumps({"chip": chip["id"], "epsg": epsg, "x0": x0, "y1": y1, "width": N,
                                                   "height": N, "invalid": int((q[0] == -128).sum())}))
    (out / "aef-index" / str(year)).mkdir(parents=True, exist_ok=True)
    (out / "aef-index" / "years.json").write_text(json.dumps([year]))
    (out / "aef-index" / str(year) / f"{epsg}.json").write_text(json.dumps(entries))
    return entries


def pixels(chips: list[dict], split: str, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """PER_SPLIT labelled, valid pixels drawn without replacement from the split's chips."""
    xs, ys = [], []
    for c in chips:
        if c["split"] != split:
            continue
        ok = (c["y"] != 255) & (c["q"] != -128).all(axis=0)
        xs.append(c["q"][:, ok].T)
        ys.append(c["y"][ok])
    x, y = np.concatenate(xs), np.concatenate(ys)
    pick = np.sort(rng.choice(len(y), PER_SPLIT, replace=False))
    return x[pick], y[pick]


def write_pixels(out: Path, regions: dict[str, list[dict]]) -> dict:
    """(c): train/test pixels per region from disjoint chips, plus the sklearn reference."""
    rng = np.random.default_rng(0)
    d = out / "pixels"
    d.mkdir(parents=True, exist_ok=True)
    split = {s: [pixels(chips, s, rng) for chips in regions.values()] for s in ("train", "test")}
    for s, parts in split.items():
        (d / f"{s}_x.i8").write_bytes(np.concatenate([p[0] for p in parts]).astype(np.int8).tobytes())
        (d / f"{s}_y.u8").write_bytes(np.concatenate([p[1] for p in parts]).astype(np.uint8).tobytes())
    xtr = dequantize(np.concatenate([p[0] for p in split["train"]]))
    ytr = np.concatenate([p[1] for p in split["train"]])
    xte = dequantize(np.concatenate([p[0] for p in split["test"]]))
    yte = np.concatenate([p[1] for p in split["test"]])
    pred = LogisticRegression(max_iter=3000).fit(xtr, ytr).predict(xte)  # mangrove-embed pixel.py
    tp = int(((pred == MANGROVE) & (yte == MANGROVE)).sum())
    union = int(((pred == MANGROVE) | (yte == MANGROVE)).sum())
    ref = {"mangrove": MANGROVE, "labels": list(range(1, 12)), "regions": {r: PER_SPLIT for r in regions},
           "bands": BANDS, "mangrove_iou": tp / union, "accuracy": float((pred == yte).mean()),
           "model": "sklearn LogisticRegression(max_iter=3000) on dequantized Int8"}
    (d / "ref.json").write_text(json.dumps(ref, indent=1))
    return ref


def write_real(out: Path, path: str) -> None:
    """(d): first 256 KiB and the .vrt of one real Source Cooperative COG."""
    d = out / "real"
    d.mkdir(parents=True, exist_ok=True)
    name = Path(path).stem
    req = urllib.request.Request(AEF_BASE + path, headers={**UA, "Range": f"bytes=0-{HEAD_BYTES - 1}"})
    with urllib.request.urlopen(req) as r:
        if r.status != 206:
            raise SystemExit(f"{path}: expected 206, got {r.status}")
        head = r.read()
    (d / f"{name}.head.tiff").write_bytes(head)
    with urllib.request.urlopen(urllib.request.Request(AEF_BASE + path.replace(".tiff", ".vrt"), headers=UA)) as r:
        (d / f"{name}.vrt").write_bytes(r.read())
    (d / "source.json").write_text(json.dumps({"url": AEF_BASE + path, "bytes": len(head)}))


NOTICE_AEF = ("AlphaEarth Foundations Satellite Embedding dataset, produced by Google and Google DeepMind,\n"
              "licensed under CC BY 4.0. COG headers and embeddings were read from the Source Cooperative copy\n"
              f"({AEF_BASE}), which is not officially supported by Google.\n")
NOTICE_STANDIN = ("Labels: ESA WorldCover 10 m 2021 v200, CC BY 4.0 (DOI 10.5281/zenodo.7254221).\n"
                  "(c) ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by\n"
                  "ESA WorldCover consortium. WorldCover classes 10..100 were mapped to labels 1..11 (mangroves = 10).\n"
                  "These are interim stand-in fixtures (ADR 0008), not mangrove-embed chips.\n")
NOTICE_MANGROVE_EMBED = (
    "Labels were derived by mangrove-embed's v3 rules from:\n"
    "- Global Mangrove Watch v3 (GMW v3), CC BY 4.0.\n"
    "- ESA WorldCover v200, CC BY 4.0. (c) ESA WorldCover project / Contains modified Copernicus Sentinel data\n"
    "  processed by ESA WorldCover consortium.\n"
    "- GWL_FCS30 global wetlands, CC BY 4.0.\n"
    "- JRC Global Surface Water 1.4, Copernicus programme. Source: EC JRC/Google.\n"
    "- GHSL (Global Human Settlement Layer), European Commission; reuse is authorised provided the source is\n"
    "  acknowledged. Source: European Commission, Joint Research Centre.\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("chips", type=Path)
    ap.add_argument("out", type=Path, nargs="?", default=Path("tests/fixtures/aef"))
    ap.add_argument("--region", default="everglades")
    ap.add_argument("--epsg", type=int, default=32617)
    ap.add_argument("--year", type=int, default=2021)
    ap.add_argument("--real", default="2021/17N/xm0lu3s74sdjecpf8-0000000000-0000008192.tiff")
    a = ap.parse_args()
    regions = {p.parent.name: load_region(p.parent, a.epsg) for p in sorted(a.chips.glob("*/index.csv"))}
    if a.region not in regions:
        raise SystemExit(f"no {a.region}/index.csv under {a.chips}")
    a.out.mkdir(parents=True, exist_ok=True)
    chip = pick_fixture_chip(regions[a.region])
    write_cogs(a.out, chip, a.year)
    ref = write_pixels(a.out, regions)
    write_real(a.out, a.real)
    standin = (a.chips / "standin.json").exists()
    (a.out / "NOTICE").write_text(NOTICE_AEF + (NOTICE_STANDIN if standin else NOTICE_MANGROVE_EMBED))
    print(f"fixture chip {chip['id']} of {a.region}; ref {ref['mangrove_iou']:.4f} IoU, {ref['accuracy']:.4f} accuracy")


if __name__ == "__main__":
    main()
