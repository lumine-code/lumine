# Fuzzy review performance evidence

The completed file-picker measurements preserve every measured complete ordered result set and show similar elapsed query times before and after the correctness fixes. They do not establish that responsiveness never regressed: several larger-list timer-gap measurements increased, and those increases were not resolved before the task was narrowed to fixing SelectList bugs. No standalone library performance comparison was run.

## Revisions and isolation

The [raw report](../benchmark/results/fuzzy-search-review-2026-10-23.json) retains individual samples, full ordered-ID hashes, source hashes, runtime details and process timestamps. The [launcher](../benchmark/fuzzy-review-run.js) uses the [actual picker harness](../benchmark/fuzzy-fleet-spec.js) and a [coherent snapshot loader](../benchmark/fuzzy-review-snapshot.js).

| Frozen sources                                            | Before                                     | After                                      |
| --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Core fuzzy matcher, SelectList, model, helpers and worker | `f4bd7403934e4396adff4a51dae1d77b5822b3da` | `1660bf2bc603b67f54151339001100f81cc2130f` |
| Fuzzy search library                                      | `0ac7a0f8021ff20e751cba2b06af24583d9af76c` | `af482c76d090ce4e204d46989d4a3646652d2b3c` |
| Fuzzy files                                               | `174110f80cdf93fff4477c91fc0dc30babcc9db3` | `00c552024bbb0bc16c367f994fa30dccc9b0cece` |
| Fuzzy explorer                                            | `f21d4fe`                                  | `a4091fa28b3e43d021652ba9d6017b060f5a88cd` |

These are frozen fuzzy implementations inside the same current editor runtime, not complete historical editor installations. Shared InputDialog, host, component and factory sources are hashed and checked for equality across processes. The view imports its own frozen model, preserving the private record Symbols. The real Chromium worker receives the selected library's bytes; all six worker library files are hashed and checked. Fuzzy-files also starts its frozen metadata helper. The installed after-library runtime files were byte-identical to the frozen after-library. No working checkout, installed library or global module cache was replaced.

The historical `reference` mode in the older fleet benchmark disables workers and is not used here. Both picker packages explicitly choose Command-T. The 100-item control sets `search.worker: false`; all larger cases use the default Chromium worker.

## Corpus and procedure

The frozen source inventory contains 13018 Git-tracked paths from 280 active flat workspace repositories. Paths are deterministically repeated under unique `copy-NNN` directories to produce 100, 30253, 100000 and 500000 candidates. These are synthetic path snapshots derived from real repository names and paths, not the earlier October 20 corpus or a real 500000-file directory tree. Only the fixed active document, `project/copy-000/lumine/src/select-list.js`, exists in the neutral capture directory. Its proximity context is identical in both variants. The report contains hashes rather than corpus paths.

Measurements ran on Windows x64, an Intel Core i9-10900K with 20 logical processors and 64 GiB RAM, using Electron 45.0.0 and its Node 24.22.0 runtime. Local `CI` was unset. Each fresh process performs one initial open/query sequence and three measured reopen sequences, in before/after/after/before order. Each sequence is `s`, `se`, `sel`, `se`, `s`, empty, `a`, `ab`, `a`, empty, followed by ten selection moves. Queries are submitted sequentially through `setQuery()` and awaited through layout; this is not a physical keyboard-to-paint measurement or a rapid supersession benchmark.

The initial open includes the package's metadata-helper startup and source snapshot, with normal speculative worker preparation. The initial query is recorded separately. Later reopen trials clear the matcher before opening and again after opening, so their first-letter query cannot inherit speculative preparation. Package activation, corpus loading and full-result hashing are outside the measured intervals. Hashing remains between queries and can affect subsequent allocation pressure.

Each implementation normally has six measured samples per query and two initial-open samples. A second complete 30253-item ABBA block investigated an initially elevated refinement median; both blocks are retained, giving twelve query samples and four initial-open samples there. Report medians average the middle pair. The nearest-rank p95 is the maximum for six samples, so it is descriptive and does not estimate a production tail reliably.

Process inventories gated launches while other Node/Electron tests were observed. Three attempts were excluded conservatively when competing tests were present at process completion. Valid earlier samples were retained. The final 500000-item baseline resumed at 14:12:40 UTC, after the two after processes finished at 14:01:39 UTC; timestamps preserve that gap. No external test process was observed at the accepted runs' boundaries. This was a shared desktop, not an isolated performance lab: the one-second preflight aggregate CPU idle fraction ranged from 58% to 98% overall, and from 86% to 94% for the accepted 500000-item runs. Short activity entirely between boundary observations is not ruled out.

## Completed results

All 400 retained process/query output records agree on full ordered IDs within each package/corpus scenario, including the empty-query results. Repeated samples are also checked against their process's first measured sequence. No result limit was reduced; the rendered page remains separate from the complete matching result.

The following query times are medians in milliseconds, shown as before → after. Initial source construction is excluded from these cold-on-reopen queries.

| Candidates / package        |          Cold `s` |       `s` → `se` |    `se` → `sel` | Backspace `sel` → `se` |   Clear query |
| --------------------------- | ----------------: | ---------------: | --------------: | ---------------------: | ------------: |
| 100 / Explorer, synchronous |     17.55 → 16.80 |    13.75 → 13.90 |   14.60 → 15.35 |          17.75 → 16.80 | 16.85 → 16.70 |
| 100 / Files, synchronous    |     17.35 → 17.15 |    13.65 → 14.45 |   15.00 → 14.65 |          17.15 → 17.65 | 17.60 → 17.75 |
| 30253 / Explorer            |   150.90 → 150.05 |    57.00 → 57.50 |   33.70 → 34.25 |          19.40 → 17.80 | 10.20 → 10.30 |
| 30253 / Files               |   136.15 → 134.95 |    51.35 → 53.25 |   35.45 → 37.60 |          24.05 → 25.40 |   9.45 → 9.40 |
| 100000 / Explorer           |   364.10 → 366.55 |  164.85 → 159.20 |   84.85 → 81.80 |          17.90 → 17.65 | 10.40 → 10.15 |
| 100000 / Files              |   312.10 → 306.35 |  144.45 → 149.90 |   84.50 → 82.50 |          73.45 → 74.35 |   9.60 → 9.10 |
| 500000 / Explorer           | 1675.95 → 1714.10 | 953.60 → 1004.00 | 509.00 → 519.65 |          57.75 → 63.20 | 16.95 → 14.10 |
| 500000 / Files              | 1410.20 → 1423.05 |  849.85 → 854.90 | 445.30 → 454.30 |        523.50 → 526.85 | 13.10 → 14.10 |

The 30253-item Files refinement initially measured 36.05 → 42.10 ms. Its independent confirmation measured 35.10 → 34.90 ms; retaining both gives 35.45 → 37.60 ms, with p95 54.10 → 52.20 ms. The original elapsed increase did not reproduce in that confirmation. The corresponding median timer-gap proxy nevertheless increased from 6.55 to 8.60 ms.

At 500000 candidates, cold-`s` p95 is 1694.10 → 1757.40 ms for Explorer and 1449.70 → 1432.20 ms for Files. Their synchronous call medians are 2.95 → 3.05 ms and 2.80 → 3.00 ms. Selection-layout medians remain approximately 16.5 ms. All other per-query p95 values and samples remain in the raw report.

Initial opening is materially different from reopening. These initial-open medians include source preparation; the adjacent reopen medians reuse the immutable snapshot.

| Candidates / package | Initial open, before → after | Reopen, before → after |
| -------------------- | ---------------------------: | ---------------------: |
| 30253 / Explorer     |                58.75 → 59.05 |          20.95 → 21.20 |
| 30253 / Files        |              291.85 → 284.40 |          20.80 → 20.65 |
| 100000 / Explorer    |                77.50 → 86.75 |          21.45 → 22.00 |
| 100000 / Files       |              742.15 → 742.80 |          21.70 → 21.10 |
| 500000 / Explorer    |              307.20 → 323.75 |          22.65 → 23.35 |
| 500000 / Files       |            3402.05 → 3548.40 |          22.15 → 21.90 |

The first-ever 500000-item query, after that initial opening, measures 1802.00 → 1758.80 ms for Explorer and 1518.85 → 1508.90 ms for Files. Those two-sample initial-use comparisons are not broad latency distributions.

## Unresolved measurements and scope

The timer-gap proxy samples the renderer event loop every 4 ms and records the largest interval during each operation. It is not a strict task duration. The 500000-item cold-query median gap changed from 25.80 to 27.70 ms for Explorer and from 22.30 to 23.30 ms for Files. Reopening gaps increased more: 16.30 → 23.25 ms and 14.90 → 21.35 ms, despite similar total reopen latency. Explorer's 100000-item reopening gap also increased from 12.65 to 16.65 ms. Other large-list query gaps have increases in the raw report. These observations remain unresolved; they should not be converted into a blanket claim of no responsiveness regression.

The user narrowed the active task after UI collection completed. No further timing runs, hotspot investigation, standalone two-algorithm library ABBA or long-trace performance measurements were performed. The standalone library driver is preparation only; its presence is not measurement evidence. This report covers the completed Command-T picker workload and synchronous small-list control only. It does not replace correctness tests or cross-platform CI.
