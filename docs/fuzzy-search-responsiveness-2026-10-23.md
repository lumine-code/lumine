# Fuzzy responsiveness investigation

This follow-up investigates the larger timer gaps in the [earlier performance report](fuzzy-search-review-performance-2026-10-23.md). The historical investigation compares the same frozen before/after fuzzy implementations inside a common editor runtime. Separate verification families isolate the publication fix and check it with the current ranking cache; their source identities and results are kept distinct.

The old timer increases do not establish a responsiveness regression. Independent confirmation did not reproduce the suspected opening regression, and cold first-letter queries have comparable input delivery and frame intervals. However, targeted Backspace confirmation and CPU profiling found a real synchronous result-index construction block shared by both implementations. The investigation therefore produced both measurement corrections and a production fix for that publication bottleneck. Real occasional stalls remain in the evidence, including one unusually slow process whose cause could not be established.

## What the old timer measured

The old harness created a new 4 ms browser interval for each operation, then took the maximum of its callback gaps and the unobserved interval between the last callback and completion. When no callback ran, that final tail was effectively the entire operation. Waiting for layout, scheduler delays and timer alignment could therefore increase the value without adding an equally long renderer task. Calling the value a longest-task duration was misleading.

Calibration confirms the distinction on this machine. Idle/frame controls produced legacy gaps of 15.7–17.2 ms; the frame control's longest renderer task was below 0.4 ms and its input-delivery p95 was 2.3 ms. A deliberate 80 ms block produced an approximately 80 ms renderer task, delayed input and an approximately 81 ms frame interval. The Long Tasks observer detected all ten DOM-message blocks but none of the ten blocks entered through a genuine Node timer. Its absence is consequently not evidence that this Electron renderer stayed responsive.

The new [monitor](../benchmark/fuzzy-responsiveness-monitor.js) retains the old metric for comparison and adds continuous native browser and Node timers, animation-frame timestamps, externally generated input probes and renderer task traces. The input probes are intercepted before application commands. Their latency measures delivery to the renderer, not physical keyboard-to-paint latency; animation-frame intervals are callbacks, not measured screen presentations.

## Workload and controls

The [batch runner](../benchmark/fuzzy-responsiveness-batch.js) uses before/after/after/before order with one picker per fresh process, rejects overlapping detected tests, waits for greater than 90% aggregate CPU idle before launch and verifies source/corpus hashes before and after each process. Every scenario has two independent processes per implementation; repeated operations within one process are not independent machine-level replications. The desktop remains shared, so brief unrelated load during a run cannot be ruled out by the boundary checks.

The scenarios distinguish reopening with the retained worker from the older benchmark's forced worker teardown. The latter is a cold-worker control, not ordinary reopening. Each process performs 20 opens per mode. Queries use `s`, `se`, `sel`, `se`, `s`, empty. A separate cold-query series clears the worker before each sequence's first `s`, then reuses it for refinement and backspace. The complete ordered results are checked in a separate replay after timing; the timed path also verifies the query and completed filtering state. The later harness records match counts: all 504 recorded historical timed-query counts agree with their replay counts in a post-measurement check. The first traced cohort's 192 timed queries did not record this field. No result cap is reduced.

The trace captures renderer tasks, garbage collection, style and layout without enabling the CPU sampling profiler. Task durations include the full intersecting task as well as phase-clipped totals; they measure wall time, not CPU consumption. Each process must start with a visible document and end with probes draining through two frames; visibility is not continuously recorded. A trace-disabled series checks whether the trace itself changes the comparison. Large raw traces remain local; the published evidence retains aggregates, per-process measurements and hashes.

Two diagnostic costs were removed before confirmation: Jasmine RPC spies retained every worker-upload argument array, and full-result hashing allocated large arrays between timed queries. Direct reversible wrappers now record only the few worker lifecycle events needed by the experiment; validation runs after timing. The first trace series is retained and labelled with its earlier observer implementation. The later external input producer requests an 8 ms interval because a requested 16 ms interval fired approximately every 30–31 ms on this Windows host. Cohorts with different instrumentation are reported separately.

## Reopening attribution

The first traced 100000-item Files cohort showed a roughly 2 ms increase in median renderer task time. Every before/after retained open performed the same two Layout and eleven UpdateLayoutTree operations, with identical dirty-node counts and geometry. The confirmation using the lighter wrappers measured longest-task medians of 9.53 → 9.48 ms, input-delivery p95 of 10.92 → 10.44 ms and frame-interval p95 of 17.71 → 17.61 ms. The initial increase did not reproduce.

The trace-disabled fleet cohort nevertheless contains a real slow process: the second after-process for 100000-item Files had cold-open input delays up to 80.5 ms and frame intervals up to 78.3 ms. Its source identity and visibility checks passed, so it is retained. Its independent Node input producer and CDP round trips also slowed, while the other after-process and both before-processes were normal. This is consistent with broader process or host load, but does not prove an external cause. The following independent trace-disabled ABBA confirmation did not reproduce it: cold-open input-delivery p95 was 11.92 → 9.87 ms, maximum delay 15.30 → 11.40 ms and frame-interval p95 17.70 → 17.62 ms.

## Confirmation results

All numbers below are milliseconds, before → after. Task values are medians of each operation's longest whole renderer task; input and frame values are pooled event p95 values. A trace-disabled run has no task-duration evidence and is shown as unavailable. The [compact evidence](../benchmark/results/fuzzy-search-responsiveness-2026-10-23.json) preserves every comparison, per-process aggregates, missing-probe counts, correctness checks, source identities and artifact hashes; these selected rows do not replace the full evidence.

| Scenario                                                         | Longest renderer task | Input delivery p95 | Frame interval p95 |
| ---------------------------------------------------------------- | --------------------: | -----------------: | -----------------: |
| Files 100000, retained reopen, lighter traced confirmation       |           9.53 → 9.48 |      10.92 → 10.44 |      17.71 → 17.61 |
| Files 100000, retained reopen, independent untraced confirmation |           unavailable |        9.00 → 8.99 |      17.51 → 18.00 |
| Files 100000, cold reopen, independent untraced confirmation     |           unavailable |       11.92 → 9.87 |      17.70 → 17.62 |
| Explorer 500000, cold first `s`                                  |         29.71 → 30.21 |        3.00 → 2.90 |      17.90 → 17.80 |
| Files 500000, cold first `s`                                     |         24.98 → 21.73 |        3.90 → 3.61 |      18.00 → 18.00 |

First-query completion is much longer than these UI delays: the traced cold-query medians are 2704.90 → 2715.80 ms for Explorer and 2241.45 → 2286.20 ms for Files. That is time until results, including worker preparation and search, not continuous UI blocking. Instrumented end-to-end times should be compared within their own cohort, not subtracted from the earlier lightweight benchmark's times.

The cold Explorer sequence has a worse Backspace-to-`se` comparison: task median 20.20 → 23.55 ms and input p95 16.28 → 23.27 ms, while frame p95 is 36.71 → 35.76 ms. The same transition in the earlier warm traced cohort has task median 20.24 → 18.44 ms and frame p95 33.54 → 31.76 ms, but input p95 increases 15.74 → 16.55 ms; the untraced cohort has frame p95 33.48 → 31.02 ms and input p95 10.28 → 12.28 ms. A targeted cold ABBA confirmation retains the smaller regression: task median 22.60 → 24.16 ms, input p95 15.25 → 21.12 ms and frame p95 36.48 → 39.17 ms. This case warranted profiling despite the better opening results.

The cold cohorts each have six sequences per implementation and picker, from two fresh processes. The independent opening confirmation has forty opens per implementation and mode, also from two processes. Across the six complete historical cohorts, all 280 recorded complete ordered-result vectors pass equality checks. Initial attempts stopped on concurrent dependency changes are not pooled into the complete cohorts. The original slow process is not excluded, and neither timing outliers nor task durations are presented as proof of a specific operating-system cause.

## Result publication bottleneck

A separate diagnostic CPU profile attributes 70–89% of samples in the three long Backspace tasks to `resultIndex()` in `select-list-model.js`, primarily `positions[records[index].sourceIndex] = index + 1`. Those tasks contain no layout or parsing; the third also includes garbage collection. This synchronous O(matches) pass builds selection positions after the worker has returned. Its implementation is unchanged between the historical snapshots: the profile identifies an existing main-thread bottleneck, not proof that the historical code changes introduced that loop. CPU-profile times are not included in the performance comparison because profiling adds overhead.

The fix builds that index alongside the adapter's existing yielding result-preparation loop. Both the rows and their index stay private until preparation completes, cancellation is checked and the model commits the result. The prepared index is reused only for the same complete result array, source-record array and identity map. Custom sorting still constructs positions after the final sort, preserving its order. The synchronous fallback path retains its direct loop, avoiding per-record builder overhead. This does not eliminate the initial typed-array allocation or make arbitrary custom sort callbacks asynchronous.

An isolated ABBA experiment applies only the two source-file changes from `e09cdb19c3c0868960ed495fa4277ccad1d317c7` to the historical after graph (`1660bf2bc6`). The other 23 frozen modules, including the library and both packages, are identical. This is a separate comparison family: historical after → publication fix, not historical before → after and not the full current editor revision. All eight processes completed and all 48 replay result vectors agreed.

| Publication-fix scenario, 500000 candidates | Longest whole task median | Input delivery p95 | Frame interval p95 | Result completion median |
| ------------------------------------------- | ------------------------: | -----------------: | -----------------: | -----------------------: |
| Explorer, cold first `s`                    |             29.07 → 14.88 |        3.50 → 2.70 |      18.00 → 18.00 |        2684.40 → 2604.90 |
| Explorer, Backspace to `se`                 |              22.57 → 9.74 |       20.48 → 6.79 |      35.05 → 21.24 |            74.40 → 58.25 |
| Files, cold first `s`                       |             24.18 → 12.30 |        4.30 → 3.39 |      17.90 → 17.80 |        2223.60 → 2240.75 |
| Files, Backspace to `se`                    |             18.21 → 14.69 |        8.94 → 5.14 |      18.00 → 18.10 |          517.70 → 552.85 |

The result-index change reduces blocking in both independent processes per implementation. Files' longer completion time for some broad backspace queries is retained as a tradeoff: more opportunities to deliver input can cost elapsed time even when the UI becomes more responsive. This table does not claim every operation completes faster. A separate untraced current-code comparison covers the later ranking-cache implementation and final synchronous-loop follow-up.

## Current-code confirmation without tracing

The final family compares the full six core fuzzy modules at `5c9e880988bf237f3bd923a40faf7120bde35f4c` and `ce822b1eff9864889a0d1c49899f8782ad57a5f0`. Both sides use the installed library `13c554dd0e8e673691f2985632891c65da17289f`, Files `0855dce5910e7d73d7a101ba10ea78a0be256ec7` and Explorer `a4091fa28b3e43d021652ba9d6017b060f5a88cd`. The installed library was verified byte-for-byte against its Git revision. Exactly the same two core modules differ; the other 23 frozen files remain identical. The final follow-up preserves direct synchronous indexing while retaining the yielding worker-result change.

This ABBA family has eight processes, forty reopen operations per process and two prepared-worker query sequences. Results retain cache warming across the sequences: a sequence-start `s` is not a cold worker initialization or a first-ever query. There are four measured occurrences of each query stage per implementation and picker, from two independent processes. No renderer-task durations are inferred from these untraced runs.

| Current code, 500000 candidates | Input delivery p95 | Frame interval p95 | Result completion median |
| ------------------------------- | -----------------: | -----------------: | -----------------------: |
| Explorer, sequence-start `s`    |       12.17 → 5.38 |      19.14 → 18.53 |          482.75 → 488.75 |
| Explorer, Backspace to `se`     |       14.32 → 5.78 |      27.21 → 19.22 |            58.35 → 64.00 |
| Files, sequence-start `s`       |       10.30 → 5.88 |      21.70 → 18.71 |          417.90 → 408.45 |
| Files, Backspace to `se`        |      11.07 → 16.68 |      33.01 → 23.10 |            48.95 → 66.10 |
| Files, Backspace to `s`         |      22.40 → 10.00 |      27.96 → 22.48 |            53.10 → 40.75 |

The current Files Backspace-to-`se` row is mixed, not an across-the-board improvement. Its input p95 has only twelve before and fourteen after events; the increase is driven by two 16.5–17 ms deliveries in the first after-process, while the second after-process has p95 9.62 ms. The higher elapsed time is retained rather than hidden by the faster neighboring queries. Clearing Explorer also has a worse input p95, 8.68 → 17.04 ms, from only eight events on each side; its frame p95 remains 17.26 → 17.72 ms. These sparse tails do not establish uniform latency improvement. Retained reopening remains approximately 23 ms in both packages with frame p95 near 18 ms.

The corrected publication path demonstrably removes the large synchronous indexing pass and substantially reduces the profiled blocking cost. It does not guarantee every query returns sooner, every event arrives sooner or every frame meets its deadline. All 48 current-family replay vectors agree, and all 96 timed-query counts agree with replay; the isolated fix family additionally checks 48 vectors and 144 timed counts. Together with the historical investigation, the evidence contains 68 accepted processes and 376 complete ordered-result checks, without pooling different comparison families.

The final source passed all 266 SelectList specs, including eight new cases for dense mixed IDs, section provenance, custom-sort order, atomic publication, cancellation and stale/incomplete index rejection. ESLint, formatting and API documentation checks passed. No dependency pin changed as part of this fix.

## Reproduction and fixes

The committed harness expects the frozen source graphs and corpus documented in the earlier report under the workspace's local `.dev/fuzzy-performance-review-20261023` directory. The new results go to `.dev/fuzzy-responsiveness-20261023`. Rebuild those inputs with the earlier snapshot tooling when reproducing elsewhere; the compact report is evidence, not a bundled 500000-path corpus.

```powershell
node benchmark/fuzzy-responsiveness-batch.js --sizes 100000,500000 --series example-trace --mode trace
node benchmark/fuzzy-responsiveness-batch.js --sizes 100000,500000 --series example-plain --mode plain
node benchmark/fuzzy-responsiveness-batch.js --sizes 500000 --series example-cold --mode cold-query
```

Analyze traces with `fuzzy-responsiveness-analyze.js` before calling `fuzzy-responsiveness-summary.js --manifest <batch.json> --output <summary.json>`. The summary now separates the first and second occurrences of the same query (`queryOccurrence: 0` and `1`), preventing a cold first `s` from being pooled with Backspace to `s`. Missing input samples remain null, never zero. The old operation-local timer remains a diagnostic scheduling proxy; renderer-task, input and frame measurements are the evidence for responsiveness.

Set `LUMINE_FUZZY_SNAPSHOT_ROOT` to an explicit comparison directory containing `before`, `after` and `corpus.json` when reproducing a different family. Use a new series name. The batch records the resolved root and refuses to resume a series against a different one. The publication verification preserves both complete manifests and patch provenance, so the composite historical graph cannot be mistaken for a complete later editor revision.
