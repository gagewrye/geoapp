# basemap.jpg

Natural Earth I with Shaded Relief and Water, 1:50m (`NE1_50M_SR_W`), version 3.2.0, reprojected to Web Mercator (spec 012, ADR 0014).

- Source: https://naciscdn.org/naturalearth/50m/raster/NE1_50M_SR_W.zip (linked from https://www.naturalearthdata.com/downloads/50m-raster-data/50m-natural-earth-1/)
- Licence: public domain. "All versions of Natural Earth raster + vector map data found on this website are in the public domain" (https://www.naturalearthdata.com/about/terms-of-use/).
- Made 2026-10-28 with GDAL 3.11.0 (hand-run dev tool, not a dependency):

```sh
gdalwarp -s_srs EPSG:4326 -t_srs EPSG:3857 -te -20037508.34 -20037508.34 20037508.34 20037508.34 -ts 2048 2048 -r average NE1_50M_SR_W.tif merc.tif
gdal_translate -of JPEG -co QUALITY=85 merc.tif basemap.jpg
```
