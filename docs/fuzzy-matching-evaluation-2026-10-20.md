# JavaScript fuzzy matching evaluation

This initial evaluation retained `@lumine-code/fuzzy-native`. The later [refinement follow-up](fuzzy-refinement-2026-10-20.md) removes the material query-extension regression and adopts the optimized JavaScript port. The measurements and initial reasoning below are preserved as the baseline.

At this stage, the standalone [fast-fuzzy](https://github.com/lumine-code/fast-fuzzy) port was implemented and tested, but new Fuzzaldrin query extensions remained slower in JavaScript. Faster repeated queries did not compensate for that regression under the migration's acceptance condition. The editor kept the independently useful model and consumer improvements.

## Implementations and method

The native reference is source revision `4d3c3d4d0f302a634e48a2494cbfcbf232210f12`, with its existing thread count of available parallelism minus one, capped at eight. Native matching remains synchronous even when its internal workers run in parallel. The JavaScript port preserves both Command-T and Fuzzaldrin, including Unicode 17 simple folding, optional query separators, diacritic expansion and UTF-16 highlight positions. Exact ties in JavaScript are deterministic by candidate ID.

The corpus contains 5141 real workspace source/spec paths. Larger sets repeat those paths under distinct project prefixes; they are scaling fixtures, not a claim that a real project contains 100000 independent source files. The corpus is identified by SHA-256 in every result. No filesystem traversal, language server or network request is included in query timing.

The renderer benchmark constructs the real SelectList, shows its host, sets each query, awaits the component update and forces layout. The input sequence is `s`, `se`, `sel`, backspace to `se`, return to `s`, `slv`, then a missing query. Command-T includes a file-search-like score modifier. It also records synchronous query work separately: frame scheduling can make a shorter computation wait longer for the next update, especially below 10000 items. Query-to-layout timing is not a measurement of physical screen presentation.

Final renderer processes run in baseline/JS/native-improved/native-improved/JS/baseline order, with two warmups and nine samples per scenario. Both runs of each implementation use the same source hashes. The benchmark loads explicitly frozen reference methods only inside its test process; it does not rewrite installed modules or switch the user's editor. See `benchmark/fuzzy-search-spec.js` and the accompanying result artifact for source/binary hashes, runtime versions and all samples.

The library driver distinguishes preparation, uncached query scoring, repeated requests, incremental typing, top-200 versus all results, and one-text highlighting. CPU profiles are diagnostic runs, excluded from final timings. Separate processes with explicit GC measure retained heap and process RSS before preparation, after preparation and after eight queries. RSS includes allocator/JIT effects and is not an exact accounting of native-owned objects.

## Renderer results

Times are milliseconds: the mean of two independent process medians, each based on nine samples. The baseline and improved native implementation use the same native source revision. The [raw artifact](../benchmark/results/fuzzy-matching-2026-10-20.json) retains the complete sample sets, observed p95 values, synchronous measurements and hashes.

| Scenario                                | Original native integration | JS with improved integration | Native with improved integration |
| --------------------------------------- | --------------------------: | ---------------------------: | -------------------------------: |
| Command-T, 10000 paths, first query     |                       30.50 |                        22.75 |                            34.95 |
| Fuzzaldrin, 10000 paths, `s` → `se`     |                       22.60 |                        26.80 |                            19.95 |
| Fuzzaldrin, 10000 paths, `se` → `sel`   |                       16.00 |                        22.20 |                            14.20 |
| Command-T, 100000 paths, first query    |                      308.60 |                       201.50 |                           308.95 |
| Command-T, 100000 paths, `se` → `sel`   |                      111.60 |                        87.90 |                            86.10 |
| Fuzzaldrin, 100000 paths, first query   |                      285.20 |                       189.50 |                           265.50 |
| Fuzzaldrin, 100000 paths, `s` → `se`    |                      195.95 |                       214.90 |                           164.50 |
| Fuzzaldrin, 100000 paths, `se` → `sel`  |                      112.40 |                       159.65 |                            88.35 |
| Fuzzaldrin, 100000 paths, return to `s` |                      212.65 |                        42.10 |                           186.55 |

The JS port materially improves first-query and repeated-query cases. Its cached return to `s` is particularly fast. However, `se` → `sel` with Fuzzaldrin is about 42% slower than the original integration and 81% slower than improved native at 100000 paths. The synchronous measurements show the same regression, so it is not merely a frame-boundary artifact. That blocks an unconditional replacement. The native model improvements are also not a universal speedup: the 10000-path Command-T first query is slightly slower in this cohort. The complete artifact makes those tradeoffs visible.

## Isolated library results

These are milliseconds, averaged across two process medians in native/JS/JS/native order. Each process uses three warmups and nine samples; explicit GC after setup is outside the timed region. Construction is outside cold-query timing and included in the separate build-plus-missing-query row. The same corpus, driver hash and runtime are recorded for both implementations.

| Public API workload                                                 | Native |     JS |
| ------------------------------------------------------------------- | -----: | -----: |
| Prepare 10000 candidates and reject a missing query                 |  7.252 |  4.364 |
| Command-T, 10000 candidates, cold `s`, all results                  | 12.213 | 12.481 |
| Command-T, 10000 candidates, cold `s`, top 200                      |  1.325 |  4.426 |
| Fuzzaldrin, 10000 candidates, cold `slv`, all results               |  1.926 |  3.748 |
| Fuzzaldrin, 10000 candidates, cold `slv`, top 200                   |  1.130 |  3.148 |
| Fuzzaldrin, 10000 candidates, seven-query typing/backspace sequence | 65.069 | 64.152 |
| Fuzzaldrin, 10000 candidates, repeated `s`, all results             | 11.873 |  1.674 |
| Fuzzaldrin, 100 single-text highlights, prepared-query API          |  0.855 |  0.609 |

Native top-N matching retains a substantial advantage. JS avoids repeated scoring and result marshalling when a cached query can be reused, but the cold scorer does not consistently match native throughput. The final diagnostic CPU profile is led by Fuzzaldrin computation, text preparation and Command-T alignment; it is retained locally and its sample summary is included in the raw artifact. Profiling-run timings are excluded.

## Memory

For 100000 paths, these are mean process-RSS increases over a post-GC baseline with the input strings already allocated. Two fresh processes were measured per implementation. The final compact ASCII representation is used.

| Stage                      |     Native |        JS |
| -------------------------- | ---------: | --------: |
| Prepared candidates        |  42.11 MiB | 47.00 MiB |
| After eight queries and GC | 139.39 MiB | 98.79 MiB |

Native candidate storage is outside the V8 heap, so heap-used figures alone would be an invalid comparison. RSS after queries includes retained allocator capacity from transient result objects. The earlier JS prototype with per-character arrays was substantially larger; compact strings removed that disadvantage. Memory is not the final reason for retaining native.

## What changed

The JS port reuses prepared queries, bounded score/order arrays and basename scores, uses a heap for limited requests, provides ID-only results and can highlight an existing candidate. ASCII candidates retain compact strings instead of allocating per-character code-point and boundary arrays. Unicode uses the pinned source tables and explicit original-offset maps. Candidate mutations invalidate cached scores; score modifiers run afresh before final ordering.

Profiles identified candidate preparation, scoring, sorting and allocation as the main costs. A separate two-row alignment scorer was also tested with an exhaustive short-input oracle and ranking fixtures. Its renderer results did not remove the new-query regressions, so it was not retained in the final library. Its experiment remains in the repository history; it is not a production selector.

The production SelectListModel now reuses immutable candidate descriptors and their membership set within a generation, keeps each custom matcher's input array independently writable, copies the filter-text cache only on a write, and avoids rebuilding unchanged filtered records. SelectList avoids redundant candidate-text arrays and temporary score wrappers. Its matcher cache distinguishes a fresh attempted transaction even when a failed update reuses the same numeric generation. Highlight caches distinguish alternate labels for the same item.

## Consumer review

The review covered all 36 workspace packages using the shared list or direct matcher APIs. Only the editor directly depends on the matching library; packages consume `lumine.tools.fuzzyMatcher` or SelectList. Autocomplete already has its own JavaScript completion model and is outside this replacement.

| Consumers                                                                                                                                                                                                                                  | Finding and disposition                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| outline-view                                                                                                                                                                                                                               | Replaced per-symbol score-plus-match calls with a prepared batch. Match the original text with `ignoreDiacritics`, preserve expansion offsets, merge adjacent highlight units, and refresh search results when ignored symbol kinds change. |
| recent-list                                                                                                                                                                                                                                | Prepare all project paths as one batch, retain the original best-path and recency/depth policies, and refresh after in-place path changes.                                                                                                  |
| symbol                                                                                                                                                                                                                                     | Batch workspace-symbol matching, reuse unchanged names across fresh provider objects, and associate highlights with the latest objects. Query sources continue to own filtering.                                                            |
| fuzzy-files, fuzzy-explorer, fuzzy-workspace                                                                                                                                                                                               | Retain Command-T. File-search score modifiers remain before final sorting; limiting raw native results early would incorrectly discard potential winners.                                                                                   |
| command-palette, bib-finder, project-list, sofistik-tools                                                                                                                                                                                  | Checked concatenated filter fields, offsets, query parsing, explicit algorithms and score modifiers. They use the shared model improvements without changing ranking policy.                                                                |
| git-center, git-command, git-diff, bookmarks, snippets, theme-selector                                                                                                                                                                     | Checked filter text versus displayed labels/details, source refresh and generation ownership. No separate matcher replacement is needed.                                                                                                    |
| build, code-format, encoding-selector, grammar-selector, graviss, ide, image-editor, jupyter-prompt, jupyter-repl, latex-tools, launcher, line-ending, linter, lumine-mcp, marker, navigation-panel, pdf-view, terminal-spawn, typst-tools | Shared SelectList consumers; reviewed their search/render registrations and source lifecycles.                                                                                                                                              |
| One local maintainer package                                                                                                                                                                                                               | Uses the same SelectList contract; included in local validation, omitted from the public package inventory.                                                                                                                                 |

## Correctness and limits

The final two-algorithm library passes 123 specs. A seeded differential corpus performs 1079026 result comparisons against the native reference: eligibility and highlight indexes agree exactly; scores agree within `max(1e-6, nativeScore * 1e-5)`. The driver also checks ordering across strictly separated score groups. It does not claim deterministic parity inside native score ties.

The focused editor/consumer run passes 343 specs, including source mutation, alternate-label caching, per-request matcher array ownership, original Unicode offsets, fresh workspace-symbol objects and package lifecycle behavior. One existing recent-list expectation still named the old application menu; it was corrected to the current command description.

Each of the 36 consumer packages was then tested in its own editor process: 6743 specs, with five already-disabled Jupyter specs. The first sweep found two Windows temporary-directory cleanup failures in graviss and launcher. Teardown now awaits asynchronous deletion with the same retry limits so pending I/O/IPC can progress during retries. Both complete suites were rerun successfully (481 and 106 specs), leaving no failures in the final consumer results. These were harness fixes, not changes to fuzzy matching.

These are local Windows performance results. Cross-platform CI validates correctness and packaging, not equivalent performance on macOS or Linux. Fast-fuzzy has no runtime dependencies and its complete npm audit reports zero vulnerabilities. The unchanged editor graph has eight moderate advisories in the electron-builder development dependency chain; this task does not upgrade that unrelated toolchain.
