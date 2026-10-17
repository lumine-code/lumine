# Shared native edit ownership experiment

This report records the October 17 experiment with immutable native text shared by buffer mutation and undo history. Its patches preserve the measured prototype. The production implementation follows the [document edit contract](document-edit-contract.md), with explicit prepared-edit lifetimes, a patch-only history interface and a revisioned change stream.

## Boundary and variants

The baseline is editor `4c8ed3293222b11c4c822ee2b1a8b54489f0f9d6` with Superstring `14f39ee40d749f37d2b554f026e974fa43d07f98`. This includes the earlier JavaScript transaction and notification improvements. All variants use frozen sources and locally built Windows Release addons. The `shared` and `prepared` variants use the identical experimental binary; only their editor integration differs, so the `shared` build still contains the unused preparation entry point and revision tracking.

The `shared` variant uses the unchanged editor with an experimental Superstring. Patch nodes own `shared_ptr<const Text>` blocks. Copying, inversion and composition can retain the same text and line-offset index; overlapping edits create new text instead of mutating a block visible to another patch. Ordinary read results remain borrowed views, as before; composition explicitly requests owning records so its inputs remain valid while it mutates a patch.

The `prepared` variant adds the editor integration. A read-only native preparation creates event metadata, the history patch and a one-shot apply closure. Applying reuses the prepared input for buffer mutation, avoiding its second JS-to-native conversion and line indexing. The closure keeps its buffer alive until application or collection. A native revision check rejects a consumed or stale edit without mutation; the editor then uses its existing mutation path, preserving behavior when a will-change observer performs another edit. Reset and deserialization also invalidate preparation. Fractional coordinates and custom history-provider subclasses use the existing path.

JavaScript still owns transactions, checkpoint grouping, undo policy, markers, display notifications and event order. Public old/new strings are still materialized. The prepared path shares inserted text with buffer mutation; deleted text is still extracted from the buffer into a separate block that history copies can share. This does not provide zero-copy public events, persistent ropes, incremental parsing or a replacement document engine. Whole-buffer replacement retains its existing materialization step so subsequent typing does not repeatedly concatenate the entire replacement patch. Overlapping patch composition still copies the affected text; sharing is not an algorithmic cure for repeatedly growing one large patch node.

## Validation

The candidate passed 151 Node specs and 62 native test cases locally. The final native run contains 115774 assertions; randomized inputs make this count vary between runs. Native ownership tests verify pointer identity across the buffer, history, copied/inverted/composed patches, isolation after mutation and release after the last owner disappears. Node tests exercise consumed and stale prepared edits, clipping, CRLF, astral and unpaired UTF-16 code units, snapshots, serialization, patch mutation and collection of the original buffer variable.

Both editor variants passed the same 929 integration specs. A separate differential trace matches reentrant will-change edits, a custom history provider including its argument count, fractional positions and aborted transactions, including events and undo/redo results. A renderer smoke check also passed. The dedicated [Windows, macOS and Linux CI matrix](https://github.com/lumine-code/lumine/actions/runs/39068104885) applies the archived native patch. These checks validate the experiment; they do not make its extra preparation API a supported extension contract.

## Measurement method

The three variants run serially in twelve fresh processes, four per variant, in the order baseline, shared, prepared, prepared, shared, baseline, shared, baseline, prepared, prepared, baseline, shared. Each model case has three warmups and nine measured samples per process. Setup, assertions, explicit garbage collection and fixture destruction are outside the timer, and the runner yields between samples to release deferred callbacks. Model measurements cover 48 buffer/editor insert, replace, undo and redo cases at 128, 1000000 and 8000000 UTF-16 units.

An initial pilot also made ordinary change reads own their text. Its first three process runs showed concerning multiline regressions, so that series was stopped and retained separately under `pilot-owned-reads`. The refined version removes reference-count churn from borrowed reads. Pilot samples are not pooled with the final comparison. This is an architectural refinement motivated by a performance signal, not a controlled attribution of the entire pilot regression to reference counting.

An additional series covers 100 sequential keystrokes in a multiline document, the same after whole-buffer replacement, insertion at 100 cursors, 1000 folds and soft wrapping at 20 columns. The latter cases check the display mapping that also uses native patches. A separate Electron series includes command execution and synchronous component/DOM updates for paste, undo and redo, using seven samples after two warmups per process. It excludes physical presentation, clipboard IPC and syntax parsing, so it is not a direct input-to-paint measurement. The frozen renderer driver records the actual loaded addon hash and editor source hashes.

Median-ratio intervals resample the four process clusters per variant 3000 times. Four process clusters provide limited confidence about smaller effects. Median and p95 changes are assessed in absolute milliseconds as well as ratios; the experiment does not require every individual metric to improve.

Separate fresh processes measure retained process memory and peak RSS for forty history entries and twelve independently edited buffers. Native text is not fully represented by JavaScript heap or external-memory counters, so RSS is included. RSS after release can remain high because allocators retain pages; it is not by itself evidence of a leak.

## Results and decision

The full prepared path is a useful native direction: it reduces large flat insertion cost, gives a modest repeatable rendered paste improvement, and substantially reduces memory in independently edited buffers. Sharing patch storage alone does not demonstrate a rendered paste/redo speedup. This supports a narrowly defined internal prepared-edit contract inside the existing Superstring boundary, with JavaScript retaining transaction and event policy. It does not establish a broad editor speedup or justify promoting the benchmark integration unchanged.

The production integration would need one explicit internal contract for prepared edits, revision validity and history ownership. The prototype's extra `applyChange` argument, optional history-provider argument and constructor identity check are experimental plumbing, not the intended long-term extension interface. The existing path remains necessary for custom providers and exceptional coordinates. No runtime source or dependency pin was changed by this experiment.

### Editor model

All times below are milliseconds per operation. These replace an interior range between a short prefix and suffix; they are not measurements of a whole-buffer formatter replacement.

| Operation                    | Baseline median | Shared median | Prepared median | Baseline p95 | Prepared p95 |
| ---------------------------- | --------------: | ------------: | --------------: | -----------: | -----------: |
| Insert, flat, 1M units       |           7.565 |         8.262 |           4.825 |       10.275 |        7.972 |
| Insert, flat, 8M units       |          66.718 |        65.854 |          52.722 |       84.805 |       63.778 |
| Replace, flat, 8M units      |          93.626 |        88.885 |          82.443 |      107.465 |       95.215 |
| Insert, multiline, 8M units  |         597.091 |       587.114 |         585.806 |      721.462 |      668.089 |
| Replace, multiline, 8M units |         641.783 |       461.481 |         633.984 |      726.475 |      725.910 |
| Undo, multiline, 8M units    |          21.993 |        18.945 |          20.761 |       30.974 |       28.627 |
| Redo, multiline, 8M units    |         551.747 |       505.418 |         563.464 |      666.105 |      677.642 |

Prepared flat insertion has a median-ratio interval of 0.511–0.865 at 1M units and 0.630–0.926 at 8M units. The other large editor-model intervals shown here include one. In particular, the attractive shared multiline replacement median is not demonstrated as a repeatable improvement. Multiline process timings vary substantially, and neither native variant resolves their dominant latency.

Three buffer-only redo cases trigger the diagnostic increase threshold of both 5% and 0.5 ms for the prepared variant. Their median-ratio intervals include one; the largest median increase is 35.736 → 38.596 ms for multiline 8M redo. These observations remain in the raw report. They do not demonstrate a consistent slowdown, but they also do not support a claim that every model operation improved.

### Renderer and confirmation

The first twelve-process renderer series has 28 measured samples per variant. Values are paired command-plus-component times, not sums of independently summarized phases.

| Operation | Baseline median / p95 | Shared median / p95 | Prepared median / p95 |
| --------- | --------------------: | ------------------: | --------------------: |
| Paste     |           37.8 / 47.4 |         38.2 / 56.3 |           35.4 / 44.1 |
| Undo      |            6.1 / 12.1 |           5.7 / 9.7 |            5.7 / 15.0 |
| Redo      |           35.7 / 38.8 |         36.1 / 44.3 |           35.9 / 37.2 |

The prepared undo p95 increase and shared paste/redo tails warranted a separate confirmation, without changing implementation or discarding the first series. The confirmation uses the same twelve-process order, fifteen samples after three warmups per process, giving 60 samples per variant. These samples are reported separately, not pooled with the first comparison.

| Operation | Baseline median / p95 | Shared median / p95 | Prepared median / p95 |
| --------- | --------------------: | ------------------: | --------------------: |
| Paste     |           37.5 / 45.7 |         37.2 / 45.7 |           35.4 / 42.6 |
| Undo      |             6.0 / 7.7 |           5.7 / 8.0 |             5.5 / 7.3 |
| Redo      |           35.5 / 38.0 |         35.5 / 42.7 |           35.4 / 37.4 |

The prepared paste median improves by 5.6% in confirmation, with ratio interval 0.934–0.957; undo improves by 0.5 ms with interval 0.833–0.965. Redo remains effectively unchanged, with interval 0.983–1.008. The prepared undo tail regression does not reproduce in confirmation. The shared-only redo p95 remains higher in both series; that variant is not a clear responsiveness win simply because it avoids a new editor API. All 24 renderer processes passed text, selection and DOM checks. These results support the prepared path in this rendered workload, while remaining short of a physical input-to-paint or subjective usability test.

### Ordinary interaction

For typing in the loaded editor model, the per-keystroke median/p95 is 0.130/0.208 ms at baseline, 0.127/0.193 ms with shared patches and 0.133/0.218 ms with preparation. After whole-buffer replacement it is 0.130/0.273, 0.127/0.266 and 0.131/0.281 ms respectively. The prepared buffer-only typing loop has a repeatable relative slowdown, but the absolute editor keystroke difference is a few microseconds. That is not a substantial interaction penalty in these cases.

The 100-cursor insertion medians are 17.286, 17.597 and 17.751 ms, with intervals spanning one. The 1000-fold insertion is 0.913, 0.848 and 0.773 ms, also inconclusive. Soft-wrapped insertion is 0.703, 0.708 and 0.637 ms; preparation has an interval below one, but the absolute benefit is small. The batch-of-100 typing p95 after replacement increases from 23.621 to 25.500 ms with preparation; the per-key figures above put that aggregate difference in context. These are model measurements without DOM work, distinct from the renderer series.

### Memory

Each cell is the median of four fresh-process measurements. Retained RSS is the increase from the process's post-import, post-GC starting point; peak RSS is the absolute process high-water mark. Values are MiB, not JS heap size.

| Workload and metric                                        | Baseline | Shared | Prepared |
| ---------------------------------------------------------- | -------: | -----: | -------: |
| Forty edits, retained RSS increase                         |    23.69 |  24.87 |    24.21 |
| Forty edits, peak RSS                                      |    98.12 |  88.40 |    88.07 |
| Twelve independently edited buffers, retained RSS increase |    61.62 |  62.48 |    32.76 |
| Twelve independently edited buffers, peak RSS              |   143.88 | 114.60 |    84.84 |

The independent-buffer case retains twelve 1120000-unit insertions with their undo histories. Preparation reduces the retained RSS increase by about 47%, consistent with the native identity tests showing that buffer and history share the inserted block. Sharing patches alone reduces transient peak use, but not the retained increase in this workload. Forty successive insertions into one document do not reduce retained RSS, because overlapping buffer patches concatenate their text into new blocks. The memory benefit is therefore workload-dependent, not a claim that editor memory use is halved generally.

## Artifacts

The [Superstring patch](../benchmark/experiments/shared-edit-superstring.patch) contains the implementation and native/Node ownership tests. The [editor patch](../benchmark/experiments/shared-edit-editor.patch) contains the optional preparation integration. Apply each to its baseline revision in a disposable checkout. The dedicated workflow applies the native patch before building and testing the library; it never changes the editor's dependency pin.

Frozen checkouts, build/test logs, compiled addons, differential traces, measurement drivers and raw process outputs are retained locally under `.dev/benchmarks/shared-edits/2026-10-17` at the workspace root. The native experiment changes no dependencies. Its Windows, macOS and Linux jobs validate package contents with `npm pack --dry-run`.

The [raw comparison](../benchmark/results/shared-edit-ownership-2026-10-17.json) retains every measured model, interaction, renderer and memory sample, process order, source and binary hashes, both renderer series, confidence intervals and diagnostic flags. It records Node 24.18.0 and an Intel Core i9-10900K for model measurements, and Electron 44.9.0 / Node 24.22.0 for renderer measurements, on Windows x64. Reproduce the model comparison with the existing `benchmark/editor-superstring-benchmark.js` against the frozen source and selected binding; the archived local drivers also reproduce the interaction, renderer and memory cases.
