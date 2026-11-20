# CAM Slicer

A slicer-style CAM app for 2.5D CNC milling: drop in an STL or STEP file, pick tools, and get verified G-code files in run order.

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # CAM engine tests (gouge check, rest machining, G-code)
npm run build    # static site in dist/
```

## 2.5D vector strategy (flat-level parts, e.g. acrylic signs and plaques)

It produces three files, run in this order with the same XY zero, re-zeroing only Z after each bit change:

1. **Roughing** with the large tool. Contour-parallel pocketing, climb milling, stay-down links, and helical-ramp entries. Each region's final layer lands exactly on its flat Z level. Followed by an optional floor pass.
2. **Rest and detail** with the small tool. Only the areas the large tool couldn't reach (region minus its opening by the large radius). Plus an optional full-depth wall-finishing pass with tangent arc lead-in and lead-out.
3. **Cut-out** with the large tool. A profile outside the outline, stepping down to stock bottom minus the through depth. Holding tabs are evenly spaced and kept off sharp corners; zig-zag ramps.

Geometry is vector-sliced from the mesh: plane cross-sections become polygons, with Clipper2 (`clipper2-ts`) for offsets and booleans. Rings are simplified to ≤ 0.01 mm and refitted to G2/G3 arcs, and no point is snapped to a grid. Lines are ≤ 70 characters and arcs stay under 180° with incremental I/J.

## Machine / controller

Pick the controller under **Settings**. The toolpaths are identical for every choice; only the G-code dialect changes, and each file is checked against its own dialect's rules before export.

| Controller | File | Differences |
|---|---|---|
| GRBL / FluidNC / grblHAL | `.nc` | `( )` comments, `G4 P3` (seconds), ends `M5 M30`. No M6/G28/G30. |
| LinuxCNC / PathPilot | `.ngc` | Adds `G91.1` (incremental arc centres) and `G64 P0.01`. |
| Mach3 / Mach4 | `.tap` | Adds `G91.1 G40 G49`. Dwell assumes seconds (Mach's default). |
| Marlin (Snapmaker, MPCNC, LowRider) | `.gcode` | `;` comments, `G4 S3`, no `G17/G94/M30`. `M3 S` is RPM. |
| Fanuc / Haas | `.nc` | `%` and `O####` wrapper, `G54`, `T# M6` + `G43 H#`, `G4 P3000` (ms), decimal point on every axis value, upper case, ends `G91 G28 Z0.` `M30`. |

Every export is first **verified** by simulating the actual G-code text on a 0.1 mm heightmap. It checks for gouges, exact floors, rapids into material, axial engagement, plunges into material, tab attachment and maximum depth. Files that fail are not exported. The report includes run time, a per-operation summary and a top-down PNG with gouges in red.

```sh
npm run cam25d -- "part.stl" out/            # writes .nc files only if verification passes
npm run cam25d -- "part.stl" out/ params.json  # override any Job25 field (tools, tabs, stepdowns...)
```

## Tools and tabs

- Select any number of flat end mills. They always run **largest-first**, whatever order you pick them in. The largest bit roughs and does the cut-out; each smaller bit only machines what the next larger one couldn't reach. A tool with nothing left to cut gets no file, and the UI and report say why.
- Tab top = final cut-out depth + tab height. With 3 mm stock, 0.3 mm through depth and 0.8 mm tab height, that's Z−2.5. The tool rides flat over each tab for exactly the tab width. Because the cutter is on either side, the material bridge left behind is tab width − tool diameter wide (6 − 3.175 ≈ 2.8 mm with the defaults).

There is one generator, the 2.5D engine in `src/cam25d/`. The earlier heightmap/raster engine has been removed.
