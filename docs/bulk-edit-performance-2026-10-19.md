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
