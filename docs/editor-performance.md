# Editor performance diagnostics

Benchmark procedures and recorded comparisons for the editor's display, injection routing, markers and captured-frame diagnostics. The records below describe their original measured revisions and environments; newer integration measurements live in [Superstring integration performance](superstring-performance.md).

## Display performance benchmarks

The editor repository provides `npm run benchmark:display` for display mapping, decoration queries, long-line edits and scrolling. Freeze the baseline before changing production code; the runner copies the source and the exact installed Superstring addon into the output directory. Use the same directory for the subsequent comparison:

```sh
npm run benchmark:display -- --phase baseline --profile quick --output ../.dev/benchmarks/display-legacy/my-run
npm run benchmark:display -- --compare --profile release --output ../.dev/benchmarks/display-legacy/my-run
```

The release comparison alternates baseline and candidate in three A–B–B–A blocks, giving six fresh processes per variant, five warmups and thirty measured samples per case. Run it on the same machine with fixed editor dimensions and font settings, after builds and other test processes finish. Raw samples, runtime and addon metadata, semantic checksums, medians, p95 and bootstrap confidence intervals remain in the output directory; generated reports are not committed.

Measure the complete operation rather than the native lookup alone: packed mapping still pays for JavaScript clipping and result allocation, and cached markers can be cheaper than a batch. Geometry reuse applies to short ASCII identifier replacements that preserve layout; parser highlighting events may invalidate a larger range afterwards. The component-update measurements report synchronous CPU and DOM work, not the time a frame is presented on screen.

### Recorded legacy display comparison

The September 30, 2026 comparison used Windows x64, Electron 44.5.0 and Node 24.21.0. A full 278-case release comparison covered six fresh processes per variant and 180 measured samples per case. A subsequent cached-decoration allocation cleanup received a separate 22-case comparison with the same process and sample counts; the original full results and intermediate control confirmations were retained. All comparisons matched their output checksums.

| Operation | Legacy median | Candidate median | Improvement |
| --- | ---: | ---: | ---: |
| Uncached decoration query, 256 endpoints with wrap | 1.3 ms | 0.7 ms | 46% |
| Uncached decoration query, 5000 endpoints with wrap | 33.0 ms | 14.5 ms | 56% |
| Uncached decoration query, 5000 endpoints with folds | 42.6 ms | 15.5 ms | 64% |
| Replacement to component update, 250k-character plain-text line | 3.5 ms | 1.0 ms | 71% |
| Replacement to component update, 1M-character plain-text line | 8.2 ms | 1.9 ms | 77% |

The decoration rows come from the final focused comparison; the replacement rows come from the full comparison, whose geometry implementation and native addon remained unchanged by the later collector cleanup. The final 22 cases had no median or p95 regression exceeding both 5% and 0.5 ms. The broad comparison initially had uncertain control regressions, which prompted isolated confirmations and a cleanup that avoids allocating unused batch structures for cached-only decorations.

These measurements apply to Superstring commit `57a49a92f51b088642a130d03bed70598906887d` and editor commit `87a2c435304f8064bdf6c94523952fa814fc45ae`. They are examples of the tested workloads, not an estimate of whole-editor speedup. Local artifacts are under `.dev/benchmarks/display-legacy/2026-09-30-targeted` and `.dev/benchmarks/display-legacy/2026-09-30-final-cached-cleanup`.

## Injection routing benchmarks

The focused `npm run benchmark:injection-routing` benchmark separates buffer-change routing, synchronous editing and the complete edit-to-syntax-settled interval. It uses 500 and 5000 independent WASM injections, with edits before, inside and after them, plus a length-changing control. Freeze the source before changing it, then compare against that snapshot:

```sh
npm run benchmark:display -- --freeze --output ../.dev/benchmarks/injection-routing/before
npm run benchmark:injection-routing -- --compare --profile release --baseline ../.dev/benchmarks/injection-routing/before/baseline/lumine --output ../.dev/benchmarks/injection-routing/comparison
```

The release comparison uses three A–B–B–A blocks, six fresh processes per variant, five warmups and thirty measured edits per case. Parser, tree-edit and injection discovery/reconciliation counters come from a separate diagnostic pass, not the timing loop. Semantic SHA256 checks cover the complete trees, included ranges and highlight boundaries after the final measured edit and diagnostic edit; they do not replace the functional suite. Runtime versions, loaded module/addon hashes and grammar/query hashes accompany the raw samples. `--electron <executable>` selects a separately provisioned runtime, and `--power-profile <description>` records the measured environment.

An equal-extent edit strictly before an injection can skip its tree edit only when both its owner and all known content ranges follow the edit. Boundary touches, coordinate shifts and unknown ranges keep the full update path. The root still parses and reconciles injection topology. This is a small legacy optimization, not a replacement parser or worker system.

### Recorded injection routing comparison

The September 30, 2026 final comparison used Electron 44.5.1 on Windows x64, with six fresh processes per variant and 180 measured edits per case. The baseline was editor commit `99d1dee32dffb251adf969cbea4fe77c362408d0`; the candidate was `335e8d733b2c69054c4c1d3682b65ac8178eca26`, including the fold-cache compatibility correction. Both sources were frozen separately from concurrent workspace edits. All eight cases matched their complete-tree/range/highlight checksums. Another Electron validation process was active on the machine, so these are paired results under that recorded background load, not a quiet-machine absolute latency gate.

| Case | Routing before | Routing after | Complete edit before | Complete edit after |
| --- | ---: | ---: | ---: | ---: |
| 500 injections, equal-extent replacement before them | 1.96 ms | 0.77 ms | 6.07 ms | 4.87 ms |
| 5000 injections, equal-extent replacement before them | 30.12 ms | 11.23 ms | 89.27 ms | 66.04 ms |
| 5000 injections, replacement inside the first one | 30.00 ms | 11.60 ms | 93.03 ms | 71.06 ms |

Leading replacements reduced child `handleTextChange`/`tree.edit` calls from 500 or 5000 to zero. An internal replacement routed to one child instead of all following children; both backends still parsed that one child. Neither backend parsed unchanged children for the leading edit, so this is routing/tree-edit savings, not newly introduced parser reuse. Fold predicates can inspect text outside a child's included ranges, so the shortcut still resets its fold cache; a same-row prefix regression is tested with both WASM and native runtimes. The 5000-layer leading routing ratio's bootstrap 95% interval was approximately 0.33–0.43; the complete edit improved by about 26%, not 63%. Ordinary insertion and deletion shift later coordinates and do not qualify for this shortcut.

The final trailing and length-changing controls showed no median/p95 regression exceeding both 5% and 0.5 ms in any measured phase. The earlier candidate's broad run had one routing p95 increase from 9.06 to 9.94 ms while its complete-operation p95 improved. Its separate six-process-per-variant trailing-only confirmation gave routing median 7.05 → 6.95 ms and p95 9.77 → 7.82 ms, consistent with an unchanged path and timing variability. These observations are retained, not substituted into the final results. Raw final results are under `.dev/benchmarks/injection-routing/2026-09-30/final-fold-cache`; the earlier `release`, `trailing-control` and short `orientation` runs remain alongside them. Absolute timings differ between these separate series, which is another reason to compare each paired baseline/candidate rather than mixing runs.

## Marker edit profiling

The injection runner also supports `--suites injections,markers,representative`. The general-marker suite covers 1000 and 10000 markers with no, sparse and dense change listeners; the representative suite uses real HTML, Vue and IPython injection providers. Insert/delete controls accompany equal-extent replacements. Grammar assets and provider/helper source hashes must agree across the comparison. Private provider instances and temporary registrations are disposed without unloading a live package generation.

```sh
npm run benchmark:injection-routing -- --compare --profile release --suites injections,markers,representative --baseline ../.dev/benchmarks/marker-splice/before/baseline/lumine --output ../.dev/benchmarks/marker-splice/comparison
```

The separate diagnostic pass counts and measures native text mutation, marker-index splices, JavaScript layer splices, marker range reads, transaction events, parser entry and injection discovery/reconciliation. Nested instrumented spans have inclusive and exclusive durations; async parse wall time is not CPU time. Instrumentation changes the workload, so these spans identify profiling candidates rather than replacing the uninstrumented edit latency. Native methods are shadowed only on actual buffer/index instances, not on a second loaded addon or a non-configurable prototype.

The September 30, 2026 experiment tried a small native shortcut for equal-extent edits strictly outside a singleton marker index. It added no API or cache fields, but its six-process-per-variant comparison did not demonstrate a worthwhile complete-edit improvement: all complete-edit bootstrap intervals included a ratio of one. For 5000 injections, leading edits were 50.50 → 51.85 ms and trailing edits 49.98 → 49.68 ms. The experiment was removed from production; its boundary, enclosing-range, exclusive-marker, maximum-coordinate and randomized regression tests remain. Artifacts are retained under `.dev/benchmarks/marker-splice/2026-09-30/native-only-release`, not substituted with the short exploratory run.

An instrumented 5000-layer diagnostic observed approximately 5000 native splices and 10000 marker range reads, with about 18 ms and 14 ms of inclusive method time respectively. These include wrapper/conversion and instrumentation overhead, not just C++ tree work. Layer event emission was much smaller in that probe. This points toward measuring boundary/allocation costs before changing the index algorithm or adding a subsystem. It does not yet justify a particular batch API.

The profiling work also reproduced independent correctness issues. Fold predicates can read a suffix outside their injection, and cached `isFoldableAtRow` results can depend on a different row: skipped syntax edits now invalidate the relevant fold context and clear the boolean cache once when row contexts overlap or ranges are unknown. Known different-row contexts keep that cache. Streamed native regex matches across a split CRLF now use logical coordinates and advance correctly after a pending CR; native CLI failures on Windows stay in stderr/nonzero exit status instead of opening a runtime dialog. These are correctness changes, not claimed performance gains.

The follow-up 38-case comparison used six fresh processes per variant and 180 edits per case, including real 50-block HTML/Vue/IPython fixtures and 1000/10000 general markers. Representative equal-extent edit medians remained approximately 1.17 ms, 1.98 ms and 0.86 ms respectively. With 10000 markers, no-listener edits were about 0.04 ms, sparse-listener edits 0.20 ms and dense-listener edits 15.87 ms. Synthetic 5000-injection trailing routing increased from 7.09 to 8.31 ms after the necessary fold invalidation, while the complete operation changed from 48.86 to 49.74 ms. Some component p95 values fluctuated or crossed the diagnostic regression threshold; this series is not reported as a speedup or a universal no-regression result. Paired data and all checksums are retained in `.dev/benchmarks/marker-splice/2026-09-30/final-all-release`.

A separate dense-search control alternated six fresh Node processes per variant with 180 samples per case. Normalizing every LF endpoint initially added avoidable cost to edited buffers; the final correction clips only a leading LF whose CR context can come from another chunk. At 10000 rows, edited newline-search medians changed from 1.067 to 1.125 ms and edited word-search medians from 3.530 to 3.753 ms, with identical outputs and no median/p95 increase exceeding both 5% and 0.5 ms. These are correctness-overhead controls, not gains. The final source is Superstring `c622eaa57af0cd31a7689cb504390f1507fa99c9`; both the initial `search-control` and final `search-control-offset0` datasets remain beside the other artifacts.

### Packed marker transfer comparison

The next legacy optimization adds two small Superstring methods, not another engine: `splicePacked` returns sorted id/flag pairs or `null` instead of four JavaScript Sets, and `getRanges` reads requested marker ranges into one owned typed array. The editor uses the first in its existing marker-layer splice and the second for owner-range routing at 64 or more injections. Smaller routing loops and older addons retain the scalar path. The native indexing algorithm, parser, public marker objects, event order and history remain in place; `null` means no touched markers, not unchanged positions.

The September 30, 2026 release comparison froze editor `bb6cc2e7e40b8e725bdeb04f2c6ca44fe4b72faf` with Superstring `c622eaa57af0cd31a7689cb504390f1507fa99c9` as baseline. The candidate facade is editor `ebed843446032d47a0726e0d8d1ec673ae18d7bb`, using Superstring `fc960bed66d93d483e00113d6e83b5817a3cb0f3`; editor `67615d05a8e5f53d68a38a4097b61083758b23a8` pins that dependency and its build permission. Both benchmark addons were compiled in Release with Node 24.18.0 and the same Windows toolchain, then frozen independently of the live installation. The measurement used Electron 44.5.1, Ultimate Performance on AC, three A–B–B–A blocks, six fresh processes per variant, five warmups and 180 samples per case. No local build or test suite ran alongside the timed processes; a pre-existing validation window remained open. All 38 cases matched their semantic checksums.

| Case | Complete edit before | Complete edit after | Median reduction |
| --- | ---: | ---: | ---: |
| 500 injections, leading equal-extent edit | 5.07 ms | 3.01 ms | 41% |
| 5000 injections, leading equal-extent edit | 72.67 ms | 44.10 ms | 39% |
| 5000 injections, edit inside the first injection | 78.80 ms | 45.67 ms | 42% |
| HTML, 50 blocks, leading equal-extent edit | 2.14 ms | 1.83 ms | 15% |
| Vue, 50 blocks, leading equal-extent edit | 3.76 ms | 3.10 ms | 18% |
| IPython, 50 blocks, leading equal-extent edit | 1.67 ms | 0.92 ms | 45% |

For the 5000-injection leading edit, synchronous edit time fell from 49.35 to 18.62 ms and routing from 15.13 to 2.44 ms. Complete-edit p95 fell from 90.72 to 59.57 ms. Its complete-edit candidate/baseline bootstrap 95% interval was approximately 0.49–0.70, and its synchronous-edit interval 0.31–0.44. Leading, trailing, length-changing and internal edits all reduced complete-edit medians by 39–42% at 5000 injections. Several smaller HTML/Vue cases have intervals crossing one, so their median changes are observations, not proof of a universal speedup. These are edit/settlement timings, not physical frame-presentation latency.

Diagnostics still count 5003 native splices for the 5000-layer case: the optimization removes transfer/allocation work, not those calls. One batch replaces the 5000 owner-range reads in routing; about 5000 scalar reads elsewhere remain. Root/child tree-edit and parse counts agree with baseline. Separate short splice-only and range-only comparisons support that attribution but do not replace the full release result.

General-marker controls showed no median or p95 regression exceeding both 5% and 0.5 ms. However, the broad series recorded a 10000-marker dense-listener leading median of 31.19 → 32.50 ms, a 4.2% increase whose interval excluded one. A separate six-process-per-variant dense-listener confirmation did not reproduce it: leading medians were 16.05 → 15.97 ms, insertion 21.17 → 18.20 ms, and deletion 30.30 → 30.33 ms; all complete-edit intervals included one and p95 did not increase. Both datasets remain, rather than substituting the confirmation into the broad series. The absolute variation between series is another reason not to promise a gain for ordinary markers or combine unrelated timings.

Artifacts are retained under `.dev/benchmarks/marker-transfer/2026-09-30/combined-release`, with the exploratory `combined-quick`, `splice-only-quick`, `ranges-only-quick` and separate `dense-marker-confirmation` runs alongside it. Exact addon/module hashes and frozen manifests identify each measured variant. Functional validation also covers invalidation strategies, boundary touches, null-result coordinate shifts, identity, undo/redo, serialization, reentrant/throwing listeners, Unicode/CRLF routing and both WASM/native grammar paths. This supports retaining the small boundary optimization; it does not reopen the document-engine migration.

The frozen Windows Release addon grew from 1144320 to 1146880 bytes, a 2560-byte increase, without new dependencies. Final integration pin `4d2b03f2b4dfd00d951de966293bc5b7599a556b` retains the measured production code and additionally pins git-diff `c7ae206c682a76f15f0969d823c7f0f6cb873219`. The first Windows CI run passed all editor/main-process specs but exposed a git-diff fixture cleanup race: an aborted promise could finish before its Git subprocess released the temporary working directory. The test-only correction drains owned work and awaits process `close`; deterministic string/Buffer-cwd regressions and all 40 installed package specs pass. The original failed run is retained, not retried or hidden. Separately, Superstring's pre-existing optional `test:threads` command references a missing file; native validation used the 122-spec Node suite and 53-case native suite, not that command.

## Captured-frame diagnostics

`npm run benchmark:presentation` drives a real visible, focused editor window through main-process `sendInputEvent`. It covers typing, benchmark-payload paste, undo and scrolling, plus HTML, Vue and IPython injections. A rendered pixel marker identifies the input revision after the editor DOM acknowledges the expected change, rejecting unrelated cursor frames and stale captures. The default run collects one hundred interactions per case and keeps failures, warmups and raw samples in its output directory.

```sh
npm run benchmark:presentation -- --samples 100 --output ../.dev/benchmarks/editor-presentation/my-run
```

Treat its latency as input-to-subscription-observed captured frame, not physical monitor scanout or the earliest presented frame. Electron 44.5.1 limits `beginFrameSubscription` to thirty captures per second and returns dirty crops in physical pixels; see the [Electron implementation](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/frame_subscriber.cc). Capture cadence cannot establish a 16.7 ms or 8.33 ms frame deadline or count missed monitor frames. A precise presentation gate requires a separate presentation-feedback/trace measurement.

The report separates captured-frame latency from instrumented component/editor method durations collected until settling; those method durations are not total renderer CPU, may overlap and exclude asynchronous parser work outside the wrappers. Syntax settles between samples, but the first captured frame does not prove syntax-correct paint. Paste uses an editor-scoped in-memory payload after native command dispatch, leaving the user's clipboard untouched and excluding clipboard transfer/providers. Smooth-scroll animation drains between samples, and the no-op control must not acknowledge or capture a changed revision. Font, viewport, DPI, packages, grammar assets and loaded addons are recorded. Do not run builds or other benchmarks concurrently, and do not reuse an output directory.

The first diagnostic series collected 1400 measured actions and 100 no-op controls on a 120 Hz Windows monitor, with zero failed interactions and zero observed long tasks. Plain-text typing had an input-to-capture median/p95 of 17.88/18.98 ms; the fixed 720-character paste into a reset 2000-line fixture had 101.58/114.67 ms. The paste's DOM acknowledgement reached the main process after a median of 13.09 ms, with another 88.27 ms to the accepted capture; those independently summarized phases must not be mistaken for physical presentation latency. This illustrates why captured-frame timing cannot substitute for editor CPU or a monitor-frame deadline. Raw results remain under `.dev/benchmarks/editor-presentation/2026-09-30-current-capture-100-primary`. That series used the original renderer method timer; later high-resolution method timing, summary metadata and orderly teardown received a separate smoke run, not a second 1400-action run.
