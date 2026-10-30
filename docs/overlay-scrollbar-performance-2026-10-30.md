# Overlay scrollbar performance

The shared overlay rails replace native dummy scrollbars in the virtual editor and provide local chrome for DOM scrollports. Their thumb position is independent of marker canvases, text wrapping and layout discovery. [Measurements, source hashes and validation](../benchmark/results/overlay-scrollbars-2026-10-30.json) include both an original-native comparison and a separately identified intermediate-prototype audit.

## Original native comparison

Three paired rounds alternate the original native implementation at `f6fd84b6cf089f806bf8242332a1a3a740d1bddc` and the integrated overlay implementation at `7b8422b7e2121c600b8f1cf4068c4abec38900f0`. Each fresh renderer uses Electron 45.0.0, the same installed dependencies and package lock, identical Python/IPython grammars, an isolated profile and the unchanged deterministic 120 Hz wheel benchmark. The generated input contains 12,462 lines and 659,570 bytes. The benchmark and wheel animator are byte-identical in both source trees. All source and input integrity checks pass.

The twenty cases cover plain text, Python and IPython, LF/CRLF, bursts, sparse input and slowing wheel input. The font is Courier 16 with line height 1.5 and device pixel ratio 1. No UI theme is active. These measurements cover synchronous wheel handling and renderer work in an offscreen window; they exclude compositor, display and physical input latency.

| Metric                                             |    Native |   Overlay |
| -------------------------------------------------- | --------: | --------: |
| Median aggregate renderer work across three rounds | 4743.3 ms | 3754.7 ms |
| Maximum target-position error                      |         0 |         0 |
| Work intervals above 16.7 ms across raw rounds     |         1 |         0 |
| Work intervals above 50 ms                         |         0 |         0 |

Median aggregate work decreases by 20.8% in this workload. Every case's median total work decreases, but P95 does not improve uniformly: plain-text sparse input changes from 0.4 to 0.5 ms, and Python LF with spaced Alt-wheel input changes from 3.3 to 4.6 ms. The small sample and deterministic input do not establish a general latency improvement or a bound on every file and package combination.

## DOM and marker work budgets

The integration benchmark exercises the real DOM manager and a real bound Simplemap. One thousand ordinary scroll events cause zero discovery scans, geometry reads, marker paints or geometry notifications. One thousand cached geometry/track reads cause no invalidations or layout reads. One thousand unchanged invalidation requests coalesce into one geometry read and no notifications.

Discovery rejects the editor token subtree before traversal: a fixture containing 5,000 token nodes produces zero token visits or computed-style reads. One hundred descendant mutation records produce one geometry read and no observer disconnect/reobserve cycles. Class changes, text growth inside a fixed-size child, same-document moves, controller replacement and cross-document adoption retain working geometry observations. Track clicks set the exact offset immediately even when the authored scrollport uses smooth CSS scrolling.

The prototype audit compares an earlier custom runtime from the same implementation session with the integrated runtime; it is not a second native-scrollbar comparison. Its operation counts demonstrate removal of 5,000 token visits and 100 redundant observer registrations. Single-observation prototype timings are omitted.

## Reproduction

Run `npm run benchmark:text-editor-scroll` for the wheel workload and `npm run test:only -- benchmark/overlay-scrollbars-spec.js` for DOM and marker work budgets, with `CI` unset locally. Keep source, grammars, input, dependency tree and runtime settings identical when comparing implementations. The committed result records the exact measured revisions and hashes; use those revisions when reproducing the original comparison.
