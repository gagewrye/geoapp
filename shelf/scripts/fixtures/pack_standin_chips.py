#!/usr/bin/env python3
"""Pack standin_chips.mjs output into mangrove-embed chip_NNNN.npz files (ADR 0008). numpy only.

Usage: python3 scripts/fixtures/pack_standin_chips.py <chips dir>
Each <region>/chip_NNNN.x.i8 (Int8 [64,128,128]) and chip_NNNN.y.u8 (uint8 [128,128]) becomes
chip_NNNN.npz with x float16 = sign(q)(q/127.5)^2 (pixels with -128 -> all-zero vector) and y.
"""
import sys
from pathlib import Path

import numpy as np

BANDS, N = 64, 128


def pack(x_path: Path) -> None:
    q = np.fromfile(x_path, dtype=np.int8).reshape(BANDS, N, N)
    y = np.fromfile(x_path.with_name(x_path.name.replace(".x.i8", ".y.u8")), dtype=np.uint8).reshape(N, N)
    qf = q.astype(np.float64)
    x = np.sign(qf) * (qf / 127.5) ** 2
    x[:, (q == -128).any(axis=0)] = 0.0  # mangrove-embed marks invalid pixels with an all-zero vector
    np.savez_compressed(x_path.with_name(x_path.name.replace(".x.i8", ".npz")), x=x.astype(np.float16), y=y)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: pack_standin_chips.py <chips dir>")
    files = sorted(Path(sys.argv[1]).glob("*/chip_*.x.i8"))
    if not files:
        sys.exit(f"no chip_*.x.i8 under {sys.argv[1]}")
    for f in files:
        pack(f)
    print(f"packed {len(files)} chips")


if __name__ == "__main__":
    main()
