# Text change boundary performance

Historical measurements. Native comparison tooling and prototype patches were retired on 2026-10-21; commands and source paths below describe the recorded checkout, not the current one. See [current model validation and benchmarks](javascript-document-core.md#validation-and-performance).

Measurements and architectural decisions for reducing repeated text conversion around editor transactions.

## Ownership and implementation

Superstring owns text storage and general patch composition. JavaScript owns transaction sequencing, undo/redo policy and event delivery. Implementation `a78b0b348e81388c213f0750e9c62f0d4b99e5c6` keeps that boundary and removes three kinds of redundant work: internal checkpoint grouping can omit its unused materialized result, a single ordinary change can reuse its existing JavaScript strings for notifications, and line counting uses `indexOf` instead of requesting a regex match result for each newline.

The single-change helper does not implement patch composition. Multiple changes, fractional coordinates and cases requiring native coercion or saturation use the existing native path. Fresh plain coordinate objects preserve the independence of public event ranges and retained transaction snapshots. Public checkpoint grouping keeps its previous return value, and the ordering of history updates and change notifications is preserved.

## Method

The October 17, 2026 comparisons use frozen editor source based on `2ff74551c73c12d261e2ed530490ab9d77fddaec`, Superstring source `14f39ee40d749f37d2b554f026e974fa43d07f98`, Node 24.18.0, Windows x64 and an Intel Core i9-10900K. Each model comparison alternates eight fresh processes in A–B–B–A–B–A–A–B order: four processes per variant, three warmups and nine measured samples per case in each process. The production comparison covers 48 buffer/editor cases with 128, 1000000 and 8000000 UTF-16 code units, including insert, replace, undo and redo. The separate native experiment covers twelve editor insert/replace cases. Each comparison uses one identical native binary for both variants; the experimental binary is distinct from the installed binary used in the production comparison.

Fixtures, setup edits for undo/redo, spatial indexing, explicit garbage collection before and after setup, assertions and destruction are outside the timed operation. The benchmark yields between samples so deferred callbacks can release destroyed fixture buffers. Every sample verifies text and event count; editor samples also verify selection restoration. Model timings include synchronous history, selection and display-layer work and exclude DOM updates, painting, syntax parsing, clipboard IPC and paste providers. Confidence intervals resample the four process clusters per variant 3000 times; the raw report retains every sample and process median.

The initial fully synchronous benchmark sweep retained destroyed buffers through pending debounce timers and exhausted the baseline process's default heap. Yielding between samples corrects that measurement artifact. Earlier exploratory series, including the failed sweep, are retained separately and are not pooled into the results below. That failure is not evidence that ordinary editor use leaks the same amount of memory.

## Production comparison

| Editor model operation       | Before median (ms) | After median (ms) | Before p95 (ms) | After p95 (ms) |
| ---------------------------- | -----------------: | ----------------: | --------------: | -------------: |
| Insert, flat, 1M units       |             11.275 |             6.025 |          15.493 |         10.030 |
| Replace, flat, 1M units      |             18.711 |             9.397 |          25.205 |         15.216 |
| Insert, flat, 8M units       |            105.197 |            53.628 |         120.056 |         79.174 |
| Replace, flat, 8M units      |            173.948 |            75.161 |         198.575 |         99.638 |
| Undo, multiline, 8M units    |             48.732 |            20.754 |          59.426 |         28.966 |
| Insert, multiline, 8M units  |            547.756 |           441.971 |         635.689 |        636.051 |
| Replace, multiline, 8M units |            575.438 |           468.137 |         702.180 |        682.727 |

The flat large-edit and large-undo improvements have median-ratio intervals below one. The 8M multiline insert and replacement intervals include one, so their lower medians are observations rather than demonstrated repeatable gains; the multiline insertion p95 is effectively unchanged. Display-layer work remains a substantial cost of multiline edits. None of the 48 cases crosses the diagnostic threshold of an increase exceeding both 5% and 0.5 ms in median or p95. This threshold is a signal for investigation, not a requirement that every result improve or an automatic acceptance gate.

## Renderer comparison

A separate eight-process comparison uses Electron 44.9.0, Node 24.22.0 and the same installed native binary. It inserts 1048576 UTF-16 units, comprising 16384 newlines, into an already-open document of the same size. Each process has two warmups and seven measured cycles, giving 28 samples per variant. The actual editor component is attached to the test DOM at 1000 by 800 pixels, with wrapping disabled, the null language mode, 13px `Menlo, Consolas, DejaVu Sans Mono, monospace` and device pixel ratio 1. Deferred stopped-changing aggregation and resetting the fixture happen outside timing.

The table combines the command and explicit `component.updateSync()` durations for each individual sample before calculating statistics. It includes DOM/layout work and uses the local Windows offscreen test runner. It does not measure physical presentation, input-to-paint latency or perceived responsiveness directly.

| Operation | Before median (ms) | After median (ms) | Before p95 (ms) | After p95 (ms) |
| --------- | -----------------: | ----------------: | --------------: | -------------: |
| Paste     |               42.2 |              38.5 |            50.8 |           49.5 |
| Undo      |                8.9 |               6.3 |            11.9 |           12.2 |
| Redo      |               38.8 |              35.5 |            60.1 |           37.8 |

All three renderer median-ratio intervals are below one. The undo p95 increases by 0.3 ms; this small absolute variation does not outweigh the lower medians, improved redo tail and simpler data flow. These results support a modest improvement in this rendered workload, not the much larger speedup seen in the synthetic flat-text model cases.

## Native preparation experiment

The subsequent [shared native edit ownership experiment](shared-edit-performance.md) tests the shared storage hypothesis left open by this preparation-only prototype.

The prototype adds a read-only `TextBuffer.prepareChange(range, text)` method that returns edit metadata and an already-built native Patch. Mutation still happens through the existing buffer operation so the history-before-notification ordering can be preserved. The benchmark integration passes the prepared patch through the editor's change application and history provider. This prototype does not test shared native text ownership between mutation and history, nor a replacement document engine.

Compared with the improved JavaScript variant on the same experimental binary:

| Editor model operation      | JS control median (ms) | Native preparation median (ms) | JS control p95 (ms) | Native preparation p95 (ms) |
| --------------------------- | ---------------------: | -----------------------------: | ------------------: | --------------------------: |
| Replace, flat, 1M units     |                  8.478 |                          9.589 |               9.527 |                      12.223 |
| Insert, flat, 8M units      |                 66.297 |                         57.741 |              84.890 |                      67.188 |
| Insert, multiline, 8M units |                496.743 |                        544.620 |             587.647 |                     681.226 |

The prototype has a real benefit in the large flat insertion case, but the multiline insertion adds about 48 ms to the median and 94 ms to p95. The flat 1M replacement also regresses. Their process-bootstrap intervals exclude one in the respective directions. The broader decision weighs absolute stalls, workload relevance and ownership boundaries: these mixed results do not justify making the extra native contract and patch handoff the general editing path. This rejects this particular prototype, not native computation as a whole. Superstring's production source and installed dependency remain unchanged.

The native and editor prepared-change prototype patches were retired with the native comparison tooling. Their implementations and original validation remain available in Git history.

## Evidence and reproduction

The [raw report](../benchmark/results/text-change-boundary-2026-10-17.json) contains source and binary hashes, process order, all model and renderer samples, confidence intervals and diagnostic flags. Frozen checkouts, prototype binaries, build logs, the failed baseline sweep and superseded exploratory series remain locally under `.dev/benchmarks/prepared-edits/2026-10-17` at the workspace root.

Use one benchmark file against immutable before/after sources and the same saved native binary in fresh processes, alternating their order:

```sh
node --expose-gc benchmark/editor-superstring-benchmark.js --source /path/to/source --binding /path/to/superstring.node --units 128,1000000,8000000 --samples 9 --warmups 3 --gc-after-setup --filter "^(buffer|editor-model)/" --output result.json
npm run benchmark:superstring-renderer
```

The renderer writes JSON when `LUMINE_SUPERSTRING_RENDERER_BENCHMARK_OUTPUT` is set. Use isolated test homes and matching runtime, font and viewport settings for comparisons. Local runs keep `CI` unset. The recorded renderer comparison used the same spec outside both snapshots, resolving its three core imports through `LUMINE_RESOURCE_PATH`; the report records that driver adaptation and verifies normalized source hashes against the model snapshots.

The final source passed 990 local integration specs with zero failures, including clipping, file changes, selection, editor and checkpoint coverage. New differential cases compare the single-change shortcut with native patch results across Unicode, line endings, rebased coordinates and saturation; additional cases cover fractional insertions and event-range independence. The eight renderer processes also passed their state and DOM checks. These are correctness checks, separate from performance comparisons.
