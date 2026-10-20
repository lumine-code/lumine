# Fuzzy search and SelectList performance

The JavaScript implementation remains adopted as `@lumine-code/fuzzy-search`. The native predecessor is retired under `.archived/fuzzy-native`, with a GitHub archive flag and the standard README deprecation warning. The [earlier evaluation](fuzzy-matching-evaluation-2026-10-20.md) and [refinement experiments](fuzzy-refinement-2026-10-20.md) record the native comparison and VS Code research. This follow-up measures the actual editor lists, including a fixed 500000-file dataset.

## What changed

SelectList now uses one dedicated Chromium worker per list by default, with explicit `search.worker: false` for lists that are always small. There is no automatic size threshold or user backend setting. The [search contract](select-list-search.md) describes startup, cancellation, callback ownership and completion promises.

Candidate normalization is retained across query changes. Compact ASCII and one-to-one transliterations avoid unnecessary offset arrays; expanding Unicode folds retain their original UTF-16 mapping. Prepared query data is shared across visible highlight operations. Identical candidate snapshots reuse preparation, while changed text invalidates the relevant cached generation. Pure score modifiers are evaluated afresh.

Core avoids copying full item arrays to count matches, move selection or build unused action snapshots. Full-result indexing uses dense positions where appropriate. File-picker path and directory-depth work is cached outside the per-candidate scoring callback. Symbol, outline and recent-list integrations reuse matchers and compute highlights for visible rows.

The worker prepares text, scores candidates, orders all matches and traces the first page. Main-thread candidate extraction and score adjustment yield in batches. Existing rows stay visible until the next complete result is available; stale requests cannot replace newer ones. Source loading has its own message. Filtering uses the Actions affordance, with a 250 ms spinner delay and no restart of that delay while typing.

## Measurement

[fuzzy-fleet-spec.js](../benchmark/fuzzy-fleet-spec.js) opens the actual fuzzy-explorer and fuzzy-files hosts, types through the mini editor, waits for matching and layout, and moves selection. The inputs are fixed snapshots containing 30253 explorer paths and 500000 project paths. The latter preserves the original large workspace workload; no directory exclusion or reduced result limit is credited as a performance improvement. The local `.dev` exclusion added during investigation was removed.

The [raw report](../benchmark/results/fuzzy-search-fleet-2026-10-20.json) contains individual samples, runtime metadata, driver and source hashes, input hashes, match counts and hashes of every ordered result set. It contains no corpus paths. Every query must produce the identical complete ordered result set within its active-document scenario. The default rendered page remains 99 rows; all matches remain selectable through pagination.

The reference freezes both the earlier JS library (`57c451b6ccc6a95eafcdc3b920a77b0054398e5f`) and earlier core/package implementations. Current library measurements use `71d84aad4859e41d9186f7eb16347f84b1459079`. Alternating runs use reference, cooperative main-thread, worker, worker, cooperative main-thread, reference order. Each process performs one warmup and three measured samples, giving six measured samples per balanced implementation. Separate cold and prepared confirmations contain three samples each. The final confirmation explicitly selects its active document and reruns the reference with that same document: file-distance weighting changes with its directory, so those ordered hashes are compared within the confirmation rather than against the earlier session.

These measurements use Windows and Electron 44.9.0. Numbers below are medians in milliseconds. The timer-gap metric samples the renderer event loop every 4 ms and reports its largest observed interval during a query; it is a responsiveness proxy, not a physical input-to-paint measurement or a strict maximum task duration.

## Full-list results

The following balanced comparison records core `01cbfea339933766989a62fbbd076b0b67174233` with the current library. Preparation on idle is deliberately cleared before the cold first query. Later spinner and lifecycle fixes were separately confirmed at core `95eb543e78a93415c90b0454b31b95d8cd176df3`; both sets of samples remain in the raw report.

| Interaction                                 | Reference | Cooperative main thread |  Worker |
| ------------------------------------------- | --------: | ----------------------: | ------: |
| Explorer, 30253 items: open                 |     31.85 |                   35.35 |   31.75 |
| Explorer: first `s`, complete results       |    172.65 |                   92.10 |  157.45 |
| Explorer: first `s`, synchronous call       |    161.45 |                    3.40 |    3.45 |
| Explorer: first `s`, largest timer gap      |    172.70 |                   12.60 |    8.75 |
| Explorer: `s` → `se`, complete results      |     52.25 |                   59.60 |   63.25 |
| Explorer: `se` → `sel`, complete results    |     35.90 |                   42.40 |   45.40 |
| Files, 500000 items: open                   |   1238.60 |                 1091.40 | 1217.90 |
| Files: first `s`, complete results          |   2608.65 |                 2178.40 | 1986.00 |
| Files: first `s`, synchronous call          |   2598.55 |                    3.30 |    4.25 |
| Files: first `s`, largest timer gap         |   2608.65 |                   34.80 |   31.00 |
| Files: `s` → `se`, complete results         |   2047.25 |                 1704.25 | 1663.50 |
| Files: `se` → `sel`, complete results       |   1969.45 |                 1681.55 | 1697.60 |
| Files: repeat cached `s`, complete results  |   1002.50 |                  836.15 |  805.60 |
| Files: clear query                          |     98.25 |                   23.90 |   25.05 |
| Files: selection movement, synchronous call |     16.85 |                    6.30 |    6.80 |

The worker chiefly protects UI responsiveness. It is not uniformly faster in elapsed time: on 30253 candidates, cold worker startup costs more than cooperative matching, and some refinements are slower than the synchronous reference. For the 500000-file workload, scoring and ordering still take roughly 1–2 seconds, but they no longer occupy the renderer continuously for that interval.

## Preparation cost

The separate prepared confirmation measured 144.10 ms from opening to readiness for the explorer and 2398.10 ms for the full file list. These include opening the list; they are not zero-cost warmups. After preparation, the first `s` completed in 55.30 ms and 1012.20 ms respectively, versus 148.50 ms and 2181.90 ms in the paired cold confirmation. Preparation shifts work before input and must be reported separately.

## Final default-worker confirmation

Core `45badb9e8cfa3e39e96576078c0993e7422aa623` includes the default-worker policy and updated bundled consumers. Fuzzy-files `ba9ceaa` also stops rebuilding unrelated windows' snapshots: changing the active file within the same directory does not change relative-path weights and no longer restarts matching. Changing the directory refreshes only that window. The integration test exercises both cases.

The final reference and worker runs use identical candidate snapshots and an explicitly identical active document. All complete ordered-result hashes match between the reference, cold worker and prepared worker.

| Interaction                                 | Reference | Cold worker | Prepared worker |
| ------------------------------------------- | --------: | ----------: | --------------: |
| Explorer, 30253 items: first `s`            |    167.10 |      146.30 |           55.90 |
| Explorer: first `s`, largest timer gap      |    167.10 |        7.50 |            7.50 |
| Explorer: `s` → `se`                        |     50.20 |       64.30 |           65.90 |
| Explorer: `se` → `sel`                      |     34.90 |       36.20 |           35.80 |
| Files, 500000 items: open                   |   1222.80 |     1129.70 |         1124.20 |
| Files: first `s`                            |   2552.00 |     1816.40 |          846.00 |
| Files: first `s`, synchronous call          |   2542.60 |        3.30 |            3.30 |
| Files: first `s`, largest timer gap         |   2552.00 |       23.80 |           20.40 |
| Files: `s` → `se`                           |   1934.70 |     1576.10 |         1570.40 |
| Files: `se` → `sel`                         |   1954.90 |     1606.60 |         1588.20 |
| Files: clear query                          |     96.30 |       23.20 |           21.40 |
| Files: selection movement, synchronous call |     15.65 |        5.75 |            5.70 |

Opening through completed preparation costs 131.80 ms for the explorer and 2125.50 ms for the file list in this confirmation. The prepared column excludes that earlier work from the query interval. These three-sample confirmations support the balanced experiment; they are not a substitute for a broad latency distribution.

## Correctness and remaining costs

The library passed 144 specs and 1378951 comparisons against the native reference with no score or match-index differences. Single-character Command-T and basename-bound experiments were rejected rather than adopted without a repeatable benefit. Worker tests cover both algorithms, score modifiers, Unicode offsets, complete ordering, cancellation, source replacement, destruction, constructor queries, section flattening, custom sort context, explicit opt-out, delayed progress and cross-window recent-item updates.

Constructing and opening the complete 500000-row source still takes approximately 1.2 seconds. This work includes source records, identity validation and package snapshots; worker matching does not eliminate it. Main-thread score callbacks, custom sort callbacks, result publication, layout and garbage collection also remain. The measured 20–37 ms timer gaps are a large improvement over second-long stalls, not proof that all frames meet a 16.7 ms budget.

The archived native binary is used only when explicitly supplied to the differential benchmark. Active package manifests and lockfiles do not retain fuzzy-native or fast-fuzzy dependencies.

Final local validation covers 349 dialog/list specs, 267 workspace specs and 6748 cases across 36 consuming packages, with zero failures; five existing Jupyter REPL cases remain pending. Consumer tests await the search completion contract rather than assuming one render frame completes matching. Jupyter Prompt recall now publishes the query and empty-selection policy atomically. The package review also fixed an unrelated Windows temporary-directory cleanup race in the MCP receipt specs with bounded asynchronous filesystem retries.

Core implementation and consumer pin commits are `ba30954f771001d49f712972bcdd9b51aeb51e34` and `45badb9e8cfa3e39e96576078c0993e7422aa623`. Earlier core commit `01cbfea339933766989a62fbbd076b0b67174233` inadvertently included concurrently staged text-model work alongside fuzzy changes; that published history was retained, and subsequent commits use explicit file lists. The measurements record the relevant source hashes.
