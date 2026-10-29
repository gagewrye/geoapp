# 0008: Interim AEF fixtures from public data
**Status:** Accepted (Gage, 2026-10-26). Shelved by spec 013 (2026-10-28).
- **Context:** ADR 0007's script needs mangrove-embed chips that exist only on Gage's machine.
- **Decision:** Stand-in chips from the AEF 2021 Everglades COGs, labelled by ESA WorldCover 2021 (10..100 -> 1..11; mangrove 95 -> 10).
- Pipeline: Node helper -> numpy packer -> ADR 0007's script, unchanged. Only the script's outputs are committed.
- Format details live in spec 002.
- **Consequences:** No new npm or Python dependency (geotiff 3.0.5, proj4 2.22.0; checked 2026-10-26).
- The NOTICE credits AlphaEarth and ESA WorldCover (both CC BY 4.0).
- Criterion 10 then checks our logreg against sklearn on WorldCover labels, not mangrove-embed's benchmark.
