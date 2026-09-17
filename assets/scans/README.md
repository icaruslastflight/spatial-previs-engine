# Scan assets

## Current state: placeholder only

A survey of every repository reachable from this session found **no Pittsburgh
point cloud assets** -- nothing matching `.ply`, `.las`, `.laz`, `.splat` or
`.spz` under either `aetherevents` (4 repos: DeepDream, Notion, Graffiti,
PromidialAgent) or `icaruslastflight` (2 repos: my-portfolio,
spatial-previs-engine). The only Pittsburgh references found were resume prose
in the portfolio site, not geometry.

So `point-state-park-bounds.geojson` stands in: a georeferenced bounding volume
for the site, sized to the park triangle at the confluence plus its load-in
apron, with 30 m of vertical headroom for ground-support towers.

## Dropping in a real capture

1. Put the file in this directory (`public/assets/scans/`). Vite serves
   `public/` verbatim, so it is fetchable at `assets/scans/<file>` at runtime.
2. Register it in `manifest.json` under `scans`:

   ```json
   {
     "id": "point_state_park_2026_survey",
     "url": "assets/scans/point_state_park.splat",
     "format": "splat",
     "anchor": { "latitude": 40.4417, "longitude": -80.0075, "height_m": 184.963 },
     "enu_offset_m": [0, 0, 0]
   }
   ```

3. `anchor` is the capture's own georeference. `enu_offset_m` is a manual
   nudge in local East/North/Up meters for when the capture's origin does not
   sit exactly on its stated anchor.

Gaussian splat captures (`.splat`, `.ply`, `.spz`) load through
`@mkkellogg/gaussian-splats-3d`. LiDAR (`.las`, `.laz`) needs conversion to
3D Tiles or `.ply` first -- neither is a browser-native format.

**Do not commit large binaries to git.** A multi-hundred-megabyte scan belongs
in a release asset or an external bucket, fetched at runtime. The $0 budget
rules out Git LFS bandwidth beyond the free tier.
