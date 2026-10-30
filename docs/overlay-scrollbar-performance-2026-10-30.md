# Overlay scrollbar performance

The shared overlay rails replace native dummy scrollbars in the virtual editor and provide local chrome for DOM scrollports. Their thumb position is independent of marker canvases, text wrapping and layout discovery. [Measurements, source hashes and validation](../benchmark/results/overlay-scrollbars-2026-10-30.json) include both an original-native comparison and a separately identified intermediate-prototype audit.

## Original native comparison

Three paired rounds alternate the original native implementation at `f6fd84b6cf089f806bf8242332a1a3a740d1bddc` and the final primary-overlay implementation at `b68ae7b3abf16af2ef3c0cb6357185643ee1a510`. Each fresh renderer uses Electron 45.0.0, the same physical installed dependency tree, identical Python/IPython grammars, an isolated profile and the unchanged deterministic 120 Hz wheel benchmark. The source lockfiles differ after fleet dependency updates; both variants deliberately resolve through the same isolated installation, whose 662-package resolution table and installed lockfile are hashed before and after measurement. This installation is separate from the working workspace's dependencies, and the current source comes from a clean committed snapshot. A new extraction of the unchanged original archive uses that same isolated installation. The generated input contains 12,462 lines and 659,570 bytes. The benchmark and wheel animator are byte-identical in both source trees. All source, input and shared dependency integrity checks pass.

The same neutral harness mounts every benchmark editor as a direct child of `.item-views` in both variants. The final editor reports `layout: "overlay"` for all twenty cases. This placement matters because a standalone editor now uses reserved gutters. The JSON retains the earlier comparisons at `7b8422b7e2121c600b8f1cf4068c4abec38900f0` and `889ca0e40a6aca84875b3a60923e7d5c058bb8d2` as superseded context; their timings are not pooled with the final run.

The twenty cases cover plain text, Python and IPython, LF/CRLF, bursts, sparse input and slowing wheel input. The font is Courier 16 with line height 1.5 and device pixel ratio 1. No UI theme is active. These measurements cover synchronous wheel handling and renderer work in an offscreen window; they exclude compositor, display and physical input latency.

| Metric                                             |    Native |   Overlay |
| -------------------------------------------------- | --------: | --------: |
| Median aggregate renderer work across three rounds | 4859.0 ms | 3780.1 ms |
| Maximum target-position error                      |         0 |         0 |
| Work intervals above 16.7 ms across raw rounds     |         2 |         0 |
| Work intervals above 50 ms                         |         0 |         0 |

Median aggregate work decreases by 22.2% in this workload. Every case's median total work decreases, and no case's median P95 increases in this run. Native has two raw work intervals above 16.7 ms; overlay has none. Their maximum intervals are 18.7 ms for native and 16.6 ms for overlay. Earlier recorded comparisons included small P95 regressions, so the three-round sample and deterministic input do not establish a general latency improvement or a bound on every file and package combination.

## DOM and marker work budgets

The integration benchmark exercises the real DOM manager and a real bound Simplemap. One thousand ordinary scroll events cause zero discovery scans, geometry reads, marker paints or geometry notifications. One thousand cached geometry/track reads cause no invalidations or layout reads. One thousand unchanged invalidation requests coalesce into one geometry read and no notifications.

Discovery rejects the editor token subtree before traversal: a fixture containing 5,000 token nodes produces zero token visits or computed-style reads. One hundred descendant mutation records produce one geometry read and no observer disconnect/reobserve cycles. Class changes, text growth inside a fixed-size child, same-document moves, controller replacement and cross-document adoption retain working geometry observations. Track clicks set the exact offset immediately even when the authored scrollport uses smooth CSS scrolling.

The prototype audit compares two intermediate custom-runtime snapshots identified by their source hashes; it does not measure the final three-group layout or form a second native-scrollbar comparison. Its operation counts demonstrate removal of 5,000 token visits and 100 redundant observer registrations. Single-observation prototype timings are omitted.

## Reproduction

Run `npm run benchmark:text-editor-scroll` for the standalone wheel workload and `npm run test:only -- benchmark/overlay-scrollbars-spec.js` for DOM and marker work budgets, with `CI` unset locally. The standalone command exercises gutter layout under the current policy; the primary-overlay comparison additionally needs the neutral placement described below.

To reproduce the paired comparison, archive the original revision without modifying it and give it a `node_modules` directory link to the final revision's installed tree. Use a neutral first spec beside a minimal `package.json` without `specPackages`, so neither source tree's optional test-package list shadows the installed grammars. In that spec's `beforeEach`, wrap `jasmine.attachToDOM`: for each `lumine-text-editor`, create a `div.item-views`, append the editor and attach that parent through the original helper; attach other elements unchanged. Assert that the final component's `getScrollbarLayout()` returns `"overlay"`. Pass this neutral spec first and each variant's unchanged `benchmark/text-editor-scroll-spec.js` second to the same Electron executable with `--no-sandbox --enable-logging <source> -f --dev --test <neutral-spec> <source-benchmark>`. Set `LUMINE_RESOURCE_PATH` to that source and a fresh, empty `LUMINE_HOME` for each variant, with `CI`, `NODE_PATH` and inherited `LUMINE_*` overrides cleared. Run three rounds in native/overlay, overlay/native, native/overlay order. Preserve source, harness, fixture and installed-resolution hashes with the raw JSON. The committed result records the exact measured revisions, environment and hashes.
