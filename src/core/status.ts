/** Status bar texts (spec 032). */

/** Lon/lat as `31.20410 N 29.91870 E`: absolute values to 5 decimals with N/S and E/W. */
export const formatLonLat = (lon: number, lat: number): string =>
  `${Math.abs(lat).toFixed(5)} ${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(5)} ${lon < 0 ? "W" : "E"}`;

const TOOL = { paint: "Paint", erase: "Erase", pan: "Pan", smart: "Smart", fill: "Fill" } as const;
/** `Paint · Water · 7 px`, from the brush mode, the selected class's name and the brush side; Smart and Fill have no brush, and say when they read (specs 046, 054). */
export const formatTool = (mode: keyof typeof TOOL, className: string, side: number, reading = false): string =>
  mode === "smart" || mode === "fill" ? `${TOOL[mode]} · ${className}${reading ? " · reading…" : ""}` : `${TOOL[mode]} · ${className} · ${side} px`;

/** `px col, row` for a pixel on the raster, else blank. */
export const formatPixel = (dims: { width: number; height: number }, [c, r]: [number, number]): string =>
  c >= 0 && c < dims.width && r >= 0 && r < dims.height ? `px ${c}, ${r}` : "";

/** `z 17.3`. */
export const formatZoom = (zoom: number): string => `z ${zoom.toFixed(1)}`;
