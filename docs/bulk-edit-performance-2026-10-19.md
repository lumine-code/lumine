# Bulk text edits and parser integration performance

This pass batches independent edits through storage, history and display, extends the API to disjoint edits on the same row, and synchronizes marker-history coordinates once per batch. Search replace-all and sparse formatter results use that path. Large web-tree-sitter transactions invalidate presentation and injection state once while retaining the exact public edit journal. See [the batch contract](bulk-text-edits.md), [parser ownership and coordinates](text-buffer-tree-sitter.md), [final raw results](../benchmark/results/bulk-edits-2026-10-19.json), and [validation record](../benchmark/results/bulk-edits-validation-2026-10-19.json).

## Final commands with active packages

These are actual editor/package operations through grammar settlement and explicit DOM/layout update. Two fresh processes per variant use two warmups and seven measured samples per scenario, in before/after/after/before order. Tables report the median of the two process medians. Exact samples, p95 values and command/settlement/layout/timer measurements remain in the raw report. Both variants use the JS document model and web-tree-sitter; this is not a native-backend comparison.

| Scenario                        | Before (ms) | After (ms) |
| ------------------------------- | ----------: | ---------: |
| search-replace-single-2000/edit |     1566.80 |     144.05 |
| format-edits-2000-js/edit       |      378.30 |     172.45 |
| format-plan-2000-js/edit        |       68.20 |      51.10 |
| format-edits-html-500/edit      |      829.25 |     428.30 |
| format-edits-python-500/edit    |      120.00 |      55.55 |
| html-1000-injections/edit       |       48.80 |      52.80 |

The search case performs 4000 replacements in one 28000-unit unwrapped line. JavaScript formatting returns 4000 edits over 2000 rows. HTML formatting edits 500 script regions and paragraph text, with 1500 replacements; Python formatting performs 1000 replacements over CRLF/Unicode input. Providers return deterministic prepared results, so these timings do not include an external formatter or language server. All runs use the same 20 active package/grammar sources per comparison.

| Scenario                        | Before (ms) | After (ms) |
| ------------------------------- | ----------: | ---------: |
| search-replace-single-2000/undo |     1447.80 |      94.80 |
| search-replace-single-2000/redo |     1464.65 |      69.65 |

Complete format plans keep their existing single whole-document write and explicit selection translation. An exploratory attempt to route them through sparse batches was slower and was removed. The final full-plan control is 68.20/51.10 ms, but this is not evidence of a new full-plan algorithm: surrounding allocations, warm state and runtime variation can contribute. The ordinary 1000-injection control is 48.80/52.80 ms; small differences are not a reliable speedup claim.

The before UI fixture restores only the optimization files from each repository's recorded HEAD. Shared files are read once and copied to both variants, so concurrent marker, line-clipping and search-publication work is present on both sides. Exact runtime source hashes are authoritative; repository commits alone do not describe captured shared working changes. Source and package fingerprints, dependency definition and output/syntax/screen-line signatures were checked during the run.

## Text model stress cases

The model benchmark runs TextBuffer with display geometry and history markers. Every measured edit, undo and redo is checked against a scalar reference for text, marker positions and validity, and screen lines. Fixture construction, verification and forced GC are outside timing. The before samples here come from the earlier frozen beginning-of-pass JS model; final samples also contain concurrent marker-index and clipping improvements, so the whole gain must not be attributed solely to this patch.

| Scenario                        | Before (ms) | After (ms) |
| ------------------------------- | ----------: | ---------: |
| replace-1000/edit               |       49.37 |      10.38 |
| replace-1000-markers/edit       |       83.51 |      14.64 |
| replace-1000-dense-markers/edit |      367.23 |      43.61 |
| replace-5000-markers/edit       |      390.83 |      69.98 |
| replace-one-line-1000/edit      |      458.60 |      24.38 |
| replace-one-line-5000/edit      |    12002.03 |      99.06 |
| independent-5000/edit           |      167.00 |      82.91 |
| multiline-replacement-1000/edit |      213.06 |     201.14 |
| single-edit-control/edit        |        1.15 |       1.22 |

The 5000-replacement single-line case is a 45000-unit line wrapped at 80 columns. Its historical baseline repeatedly rebuilt the same wrapped line; the final implementation updates layout once. Dense-history-marker cases also avoid visiting every history entry after every splice. Single-edit and multiline-replacement controls remain on their ordinary paths and do not demonstrate a general-purpose speedup.

## Broader exploration and limits

The [earlier broad matrix](../benchmark/results/bulk-edits-exploration-2026-10-19.json) includes whitespace transforms, sorting, 1000 cursors, long wrapped lines, a million-unit single line, Python, HTML injections and minified JSON. It exposed the full-plan regression and variable control timings. It predates the final parser and linear-coordinate refinements, so its candidate timings are not presented as final-head results. Pilot and interrupted candidate runs are excluded from the final report.

Measurements ran serially on Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz, Windows x64; correctness suites ran after capture. The final scripts are benchmark/bulk-edit-benchmark.js and benchmark/document-editor-integration-spec.js. The latter accepts LUMINE_DOCUMENT_BENCH_CONFIG with packageCases, bulkSyntaxCases, filter, packages, samples and warmups. Frozen core/package inputs, isolated homes and identical driver bytes are required for reproducing a comparison. The model driver accepts --source, --samples, --warmups and --output and should run with --expose-gc.

Complete means command, grammar settlement and explicit layout, not physical presentation. The separate twoFrames metric adds two animation-frame callbacks. Timing variation is visible in the retained process medians; seven samples per process do not characterize rare production tail latency. No tests launched by this task ran concurrently with performance capture.

## Correctness

All 96 selected package suites passed: 4202 specs, including all 78 available grammar suites. Their frozen inputs and the core fingerprint remained unchanged. The final snapshot also passed 60 document-core tests, 46 parser-runtime tests and API documentation validation. Dedicated checks compare every syntax node's type, indices and positions against a fresh parse for JavaScript, Python and HTML injections, including CRLF, emoji, undo and redo. Randomized adjacent edits verify marker affinities, and native patch differential tests verify canonical patch construction.

The full editor run executed 6928 specs with one pending platform-specific test and eight environment failures. Seven Project failures came from the source snapshot lacking a Git repository; all 93 Project specs passed after initializing a disposable repository in that fixture. The ModuleCache filesystem-call assertion fails in both before/after snapshots with the shared dependency junction, while all six ModuleCache specs pass in the normal checkout with identical ModuleCache source. These controls resolve the failures without changing production code or hiding the initial result; this is cumulative validation rather than one all-green frozen run.

The pass also fixes regex replacements targeting either half of CRLF or a zero-width position inside it, rejects reentrant replace-all before preparing edits, and preserves text/selections/result markers when direct formatting or search replacement is refused by a read-only editor. Full text materialization for arbitrary RegExp matching remains. General multiline batches and the parser's 128-edit fresh-parse threshold remain separate optimization targets.

## Marker history locality follow-up

A later pass removes two repeated operations from scalar edits: history now reuses the touched marker ids returned by the index splice, and row-preserving edits query only starts that can shift on their last row. The bounded, unordered query stops after one thirty-second of the layer's marker count and falls back to the existing map scan for dense results. Custom range trackers still receive pre-edit ranges; multiline edits that shift rows retain the full translation path. Independent bulk edits retain their single history synchronization.

The [marker locality capture](../benchmark/results/marker-history-locality-2026-10-19.json) compares the JavaScript model immediately before and after this change, with shared core/package source bytes frozen once and only marker-layer.js and marker-index.js different. Two fresh processes per variant run in before/after/after/before order. The model has 15 samples and four warmups per process; the editor has seven samples and two warmups. Tables show the mean of the two process medians in milliseconds; the JSON retains raw samples, process medians, pooled p95, hashes and runtime versions. Timed sections exclude correctness checks and fixture creation.

| Model operation               | Before ms | After ms |
| ----------------------------- | --------: | -------: |
| typing-10000-markers          |     0.687 |    0.279 |
| scalar-batch-10000-markers    |    20.699 |    4.537 |
| bulk-batch-10000-markers      |     2.901 |    2.753 |
| same-row-10000-markers        |     1.970 |    1.868 |
| mostly-same-row-10000-markers |     1.740 |    1.740 |
| touching-row-10000-markers    |    25.313 |   21.413 |
| newline-10000-markers         |     1.254 |    1.284 |

Each model fixture contains 10000 rows. The scalar and bulk batches insert into 100 distinct rows; they demonstrate why callers that already have an edit plan should use the bulk API. Dense controls place every marker, or 90% of them, on the edited row. The touching control covers the edit with 10000 ranges. Single edits without markers and with ten markers are also recorded, but their sub-millisecond variation is not evidence of a general speedup.

| Editor operation with 20 active packages | Before ms | After ms |
| ---------------------------------------- | --------: | -------: |
| plain-1m-markers/edit                    |     3.500 |    3.450 |
| multicursor-1000/edit                    |   142.600 |  129.100 |
| format-edits-2000-js/edit                |    89.150 |   85.900 |
| format-edits-html-500/edit               |   280.800 |  292.300 |
| whitespace-trim-5000/edit                |    53.450 |   53.650 |
| autocomplete-popup/edit                  |    11.000 |    9.700 |

Editor timings include command execution, grammar settlement and explicit DOM layout; they exclude physical frame presentation. Formatting, whitespace and completion are controls, not claims of broad acceleration. This change reduces bookkeeping around edits and does not change parser policy, word indexing or package APIs. Output text, marker state, undo/redo and syntax signatures agree between both variants.

Validation passed 1901 focused editor specs, 107 Node tests and 3393 specs in 27 selected package/grammar suites, with marker-history/index verification enabled for editor and package tests. The index's bounded queries also have randomized differential coverage against the native oracle after lazy shifts. Frozen source and package fingerprints remained unchanged.

An exploratory larger bulk piece-compaction target reduced reader callback counts but did not establish a reliable edit-time gain, so the production piece sizes remain unchanged. The earlier unbounded marker query regressed the all-markers-on-one-row case; the shipped bounded query and dense fallback address that case. Neither pilot is presented as shipped performance evidence.

The main HTML control was about 4% slower, so it was repeated alone against the same frozen sources with reversed after/before/before/after process order, 15 samples and four warmups per process. That isolated comparison measured 299.70 → 301.45 ms. Both captures remain in the JSON: the first difference did not reproduce as a consistent slowdown, and neither capture establishes an HTML speedup. No correctness suites ran during either timing capture.

Run the model driver with `node --expose-gc benchmark/marker-history-locality.js --source <frozen-checkout> --output <report.json>`. Source and dependency identity must match across variants; the report records the active package set and configuration for the existing editor integration driver.

## Multicursor and multiline follow-up

The [multiline capture](../benchmark/results/multiline-edit-performance-2026-10-19.json) measures three changes together: disjoint multiline plans commit storage/history/display once; multicursor commands defer history maps after row-changing edits while preserving scalar selection callbacks; and transaction grouping builds large ordered, disjoint patch sequences in one pass. Overlapping/reordered patches retain general composition. Column-only selection edits retain local history updates. The public contract and CRLF fallback are documented in [independent text edits](bulk-text-edits.md).

Core and code-format source bytes were frozen together with 20 active package/grammar repositories. Both variants share those bytes except for the explicitly recorded runtime files, whose baseline comes from the recorded repository commits. Four fresh processes run before/after/after/before, with seven measured samples and two warmups per process. Tables show the mean of each variant's two process medians, in milliseconds. Raw samples, process medians, pooled p95, runtime versions, source/dependency hashes and all edit/undo/redo timings remain in the JSON.

| Core model operation            | Before ms | After ms |
| ------------------------------- | --------: | -------: |
| multiline-replacement-1000/edit |    218.13 |    35.59 |
| multiline-replacement-1000/undo |    232.49 |    49.95 |
| multiline-replacement-1000/redo |    231.68 |    38.71 |
| independent-5000/edit           |     65.46 |    60.50 |
| single-edit-control/edit        |      0.45 |     0.48 |

| Editor with the active package fleet | Before ms | After ms |
| ------------------------------------ | --------: | -------: |
| multicursor-1000/edit                |    198.70 |   217.70 |
| multicursor-newline-1000/edit        |    759.30 |   711.70 |
| multicursor-newline-1000/undo        |    592.70 |   269.95 |
| multicursor-paste-1000/edit          |    751.35 |   661.20 |
| multicursor-paste-1000/undo          |    670.60 |   253.15 |
| multiline-format-js-1000/edit        |    278.20 |    69.55 |
| multiline-delete-js-1000/edit        |    152.40 |    66.50 |
| multiline-format-html-500/edit       |   1203.80 |   462.50 |
| format-edits-2000-js/edit            |    155.00 |   134.65 |
| whitespace-trim-5000/edit            |     93.80 |    86.70 |
| autocomplete-popup/edit              |     14.30 |    19.60 |

The multicursor fixtures insert into 1000 distinct rows in a one-million-unit plain-text document. The multiline paste inserts three lines per cursor. These timed insertion fixtures disable automatic indentation; normal indentation behavior remains covered by core/package correctness suites. The formatter fixtures add line breaks in 2000 JavaScript replacements, replace 1000 two-line JavaScript ranges, and change 1500 matches across 500 HTML script regions plus text nodes. Complete formatter plans continue to use their previous whole-document replacement path.

Editor timing includes command execution, grammar settlement and explicit layout, excluding fixture setup, verification and physical presentation. Model timing covers the edit or history operation with a display layer and markers; full text/marker/screen-line hashes are checked outside the timer against scalar application. All editor output and syntax signatures match between variants. The existing single-line, whitespace and completion workloads are controls, not assumptions that every operation accelerates. No correctness tests launched by this task ran during capture.

Validation passed 1915 focused editor specs, 110 Node tests and 3394 specs in 27 package/grammar suites. Marker histories were checked against live indexes. Tests cover CRLF, Unicode, adjacent edits, invalid plans, snapshot retention, callback order, rollback after exceptions, word-index equivalence to scanning, and every syntax node's coordinates against fresh JavaScript/Python/HTML parses. Randomized multiline patches and ordered/overlapping composition are compared with the native oracle. Source and package fingerprints stayed unchanged.

The two-sample pilot predates the final composition optimization and is excluded from the final measurements. Instrumented profiling identified repeated history translation and patch insertion; its overlapping method timers are diagnostic, not benchmark results. Early mixed core/package smoke commands omitted code-format's declared test providers; all 232 targeted specs passed once the isolated home and explicit provider list were complete.

Reproduce the model subset with `node --expose-gc benchmark/bulk-edit-benchmark.js --source <snapshot> --filter "^(multiline-replacement-1000|independent-5000|single-edit-control)$" --samples 7 --warmups 2 --output <report.json>`. The editor driver accepts `multilineCases: true` in `LUMINE_DOCUMENT_BENCH_CONFIG`; the report retains its exact filter and active package set.

The main matrix showed a slower completion popup and a large spread in ordinary typing, so both were repeated separately against the same frozen sources, in reversed after/before/before/after order. The completion control used 15 samples and four warmups per process and measured 12.70 → 12.80 ms. The two cursor controls used nine samples and three warmups per process: ordinary insertion measured 219.95 → 219.45 ms, newline insertion 827.90 → 720.20 ms, and newline undo 719.90 → 278.15 ms. The slowdown in ordinary typing/completion did not reproduce in those isolated controls. Both the original matrix and the controls are retained; the controls do not establish an ordinary-typing or completion speedup. Timings from separate rounds should not be compared as if they shared machine load and warmup state.

The initial fleet run had two Windows EPERM failures while synchronously removing temporary file-opening fixtures in code-format, after the behavioral assertions passed. Cleanup now awaits asynchronous removal with the same path guard and bounded retry policy, allowing the renderer event loop to progress during handle release. The full 110-spec package suite then passed twice against the measured core; the original failures, changed spec hash and repeat results are retained in the report. Runtime sources were unchanged. The final green counts above are cumulative validation, not a claim that the first fleet run had no failures.
