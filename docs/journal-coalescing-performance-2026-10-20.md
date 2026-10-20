# Incremental parsing after long local edit streams

This follow-up to [parser work and cadence measurements](parser-work-performance-2026-10-20.md) targets grammar settlement after a burst. The preceding scheduling change avoided starting obsolete jobs, but a journal of 128 edits still forced a fresh parse even when every edit belonged to the same small fragment. This change composes connected edits before applying the existing bulk policy.

## Implementation and correctness

Only captured journals with at least 32 edits enter composition. Consecutive replacements that overlap or touch become one replacement; disjoint edits remain sequential. Coordinate transformations use exact UTF-16 journal positions. Captures preserve newEndIndex, so parser preparation and bulk classification do not request inserted text merely to get its length. Composed newText is lazy: a single connected group slices the final immutable snapshot; multiple groups reconstruct their intermediate piece roots only when an explicit consumer requests text. No whole-buffer flattening, clipped buffer point conversion or rescanning of inserted strings is required. The composition covers insertion, backspace, replacement, multiline input and undo. It does not change the journal's retention limits or bridge missing revisions. Legacy edits without point coordinates stay separate.

The parser's threshold of 128 remaining edits and its changed-text volume policy are unchanged. Distributed edits can still deliberately choose fresh parsing. A regression checks 150 independent identifier changes keep that fallback; another checks a 200-edit local stream and its undo stay incremental and match fresh parsing across all syntax nodes and their ranges. A deterministic replay test covers 18000 edit/undo iterations with CRLF, astral characters, unpaired surrogates, disjoint changes and overlapping replacements. Captured edit records and coordinates remain immutable, and retained older nodes preserve their text.

The upstream [cancellation contract](https://github.com/tree-sitter/tree-sitter/blob/master/lib/include/tree_sitter/api.h) supports resuming parsing; the error-grouping difference below was reproduced locally.

A separate correctness guard handles suspended incremental jobs whose previous tree already contains errors. Local reproduction with web-tree-sitter 0.27.1 produced different ERROR groupings depending on the slice boundary, despite identical text; fresh resumable parsing matched the reference. Such a suspended job now resets its private working tree and restarts fresh before resuming. Completed synchronous incremental parses and suspended jobs based on error-free trees retain reuse. A deterministic regression forces suspension and verifies the fresh result. The earlier faster results without this guard are excluded. To keep ordinary typing fast, large root layers retain at most one error-free tree and replay the exact bounded journal from it when the latest tree contains errors. If history is unavailable, that checkpoint is released and the safe fallback remains. Language changes, shrinking below the large-buffer threshold and destruction release or replace the checkpoint. Injection layers do not retain extra checkpoints. Presentation compares against an edited private copy of the last displayed tree, rather than the older checkpoint, so repairs invalidate the correct scopes without refreshing the entire document. A focused integration regression verifies reuse, repair back to the original text, history loss and release on destruction.

[Raw samples, source fingerprints and validation](../benchmark/results/journal-coalescing-performance-2026-10-20.json) record the final variants.

## Measurement method

The baseline is core `368469decc`, including the preceding 50 ms scheduling policy. Candidate commit `954fd5ebc025425daae70158da86a4f3c83973ff` changes `tree-sitter-document.js`, `tree-sitter-parser.js` and `tree-sitter-language-mode.js`. Both variants use the same installed dependencies and 37 packages from the local working fleet. The benchmark records source hashes before and after every process and rejects source drift. No package sources were intentionally changed during measurements. Package activation does not exercise every optional panel or command.

The final JS/Python comparison uses before/after/after/before processes. Each file receives 1800 commands at 60/s, followed by a separately opened 24-command case at 8/s. JS contains 30000 exported functions and Python contains 24000 assignments, both with Unicode strings; Python uses CRLF. A separate valid-JavaScript ABBA round uses 600 commands inside a block comment and asserts that final syntax remains error-free. An independent SOFiSTiK ABBA control uses 600 commands per process without preceding JS/Python cases. The supplied control file is 8,400,039 bytes and 195,789 lines. Every case starts near the end of a newly opened file and waits for initial grammar readiness. Input alternates letters with word boundaries and an Enter every sixtieth command; this can temporarily produce invalid syntax. Files are never saved and their hashes must stay unchanged.

Measurements include synchronous command duration, scheduled-input backlog, requestAnimationFrame gaps, final grammar settlement and renderer-process user plus system CPU from first input through settlement. CPU includes UI/packages and other renderer threads, not the whole application. Frame callbacks measure renderer scheduling, not physical presentation; callbacks arriving after settlement are not included. These are timer-driven editor API operations, not OS keyboard dispatch. Output serialization, syntax hashing, initial loading/scrolling and closing happen outside the input/settlement interval. Final text and named syntax-tree hashes must match across variants, and every tree must describe the latest revision. The benchmark also records whether the final published tree used incremental parsing.

Accepted timing processes run serially after correctness tests, without profiling, forced GC or other correctness suites alongside them. Two processes per variant provide a local comparison rather than a confidence interval. Fixtures, frozen snapshots and orchestration remain in `.dev/journal-checkpoint-20261020`; private file contents and its original path are excluded from committed results.

A separate Node microbenchmark measures document capture alone for journals of 1, 32, 240, 1800 and 10000 local edits, using the frozen source variants in ABBA order. It constructs the history outside timing, clears only the captured-edit cache between attempts, discards ten warmup attempts and records fifty captures per case. It does not measure parser, UI or package work, and runs independently after the final renderer comparisons.

## Results

### Long streams and isolated-edit control

Settlement is the range of the two process results. CPU is the arithmetic mean, and command p95 pools equally sized samples.

| Grammar    | Commands per case / rate | Settlement ms before → after | Mean settlement change | Renderer CPU ms before → after | Command p95 ms before → after | Final trees incremental before → after |
| ---------- | -----------------------: | ---------------------------: | ---------------------: | -----------------------------: | ----------------------------: | -------------------------------------: |
| JavaScript |              1800 / 60/s |            596–747 → 173–180 |                 -73.7% |                  20696 → 20914 |                     2.6 → 4.0 |                              0/2 → 2/2 |
| JavaScript |                 24 / 8/s |                78–88 → 89–98 |                  13.1% |                    2359 → 2664 |                   73.2 → 75.1 |                              2/2 → 2/2 |
| Python     |              1800 / 60/s |            442–484 → 192–193 |                 -58.4% |                  17875 → 17243 |                     0.8 → 0.8 |                              0/2 → 2/2 |
| Python     |                 24 / 8/s |             96–104 → 116–120 |                  17.7% |                    2837 → 3047 |                  93.2 → 107.4 |                              2/2 → 2/2 |

Final input, output text and named syntax-tree hashes agree across all four processes in each round. Initial slow synchronous observations remain in the command statistics, making p95 for the 24-command cases sensitive to their two expensive startup edits.

The reliable improvement in the long cases is grammar settlement. JS renderer CPU changes by +1.1% and Python by −3.5%; there is no broad throughput speedup claim. Long-stream JS command p95 increases from 2.6 to 4.0 ms even though its median drops from 1.9 to 1.7 ms. Python stays near 0.5 ms median and 0.8 ms p95. At 8/s, mean settlement rises by about 11 ms for JS and 18 ms for Python, and CPU is higher by 13.0% and 7.4%. Comparing against the last displayed error tree has a cost; these are two-run observations rather than an isolated estimate of that cost.

Frame-gap p95 is about 16.7–16.8 ms during long streams, but reaches 33.3 ms in the candidate 8/s controls. Long-stream maximum gaps remain 116.7 → 116.6 ms for JS and 216.7 → 200.0 ms for Python. The first expensive observations and uninterrupted native work remain relevant.

### Valid JavaScript: typing inside a block comment

All four cases assert error-free final syntax. With 600 commands at 60/s, settlement is 638–669 → 130–141 ms, a 79.3% mean reduction. Both baseline cases finish with fresh parsing; both candidate cases remain incremental. Renderer CPU averages 8134 → 7774 ms, and pooled command p95 is 4.8 → 4.0 ms.

### SOFiSTiK in isolation

| Variant | Mean renderer CPU ms | Command median ms | Command p95 ms | Backlog p95 ms | Maximum frame gap ms |
| ------- | -------------------: | ----------------: | -------------: | -------------: | -------------------: |
| before  |                 9547 |               5.3 |            7.2 |            6.9 |                 50.1 |
| after   |                 9828 |               5.3 |            7.2 |            6.9 |                 66.7 |

SOFiSTiK keeps the same 5.3 ms command median and 7.2 ms p95. Its mean renderer CPU rises by 2.9% and the observed maximum frame gap rises from 50.1 to 66.7 ms, so unchanged command percentiles do not establish an absence of every overhead or tail.

### Capture overhead

An eager composition prototype was rejected after its median capture time reached 73–85 ms for 10000 edits. The final implementation preserves coordinates and computes composed text lazily. The table shows the range of median times from two passes per variant in the isolated Node microbenchmark; it is not a renderer latency measurement.

| Journal edits | Capture median ms before | Capture median ms after | Captured edits after |
| ------------: | -----------------------: | ----------------------: | -------------------: |
|             1 |            0.0007–0.0013 |           0.0004–0.0010 |                    1 |
|            32 |            0.0108–0.0116 |           0.0079–0.0161 |                    1 |
|           240 |            0.0633–0.0875 |           0.0777–0.0902 |                    1 |
|          1800 |            1.3139–1.4526 |           1.5423–1.6641 |                    1 |
|         10000 |          10.2104–10.7741 |           9.5088–9.7486 |                    1 |

## Validation and limitations

The final integration run passes 123 Node tests and 524 core specs focused on Tree-sitter, indentation and scope resolution. Package suites also pass: autocomplete (455), bracket-matcher (215), language-javascript (35), language-python (44), line-ending (60), symbol-tree-sitter (55), outline-view (86), indent-guide (28) and language-sofistik (86). All have zero failures. The earlier 24 focused Node tests and five focused renderer specs overlap this run and are not added to its count. This is a targeted regression run, not a rerun of every editor spec. ESLint, formatting and whitespace checks pass for the changed implementation and tests.

This does not change the two initial expensive synchronous observations that precede adaptive scheduling. Individual native changed-range comparisons and tree destructors are still uninterruptible. Long streams beyond retained journal history still require fresh parsing. A file opened with errors and no usable error-free checkpoint still pays the guarded full-parse path when an incremental attempt suspends. Adjacent changes that alternate between distant cursor locations are not globally reordered or composed by this pass. Results apply to these workloads and this workstation, and do not establish a hard frame deadline or a new native-versus-JavaScript ratio.

The next priorities are the first two expensive foreground syntax updates, avoiding duplicate changed-range comparison when using a checkpoint, and lowering the remaining fallback cost for files opened with errors and no healthy revision. The longer memory-residency experiment from the preceding report was not repeated for this change; the checkpoint has a structural one-tree bound and explicit release tests, not a new whole-fleet leak proof.
