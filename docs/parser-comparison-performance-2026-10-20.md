# Comparing syntax once against the displayed revision

This follow-up to [journal coalescing and checkpoints](journal-coalescing-performance-2026-10-20.md) removes a redundant changed-range comparison. A checkpoint update previously compared the new tree with the healthy parsing base and then compared it again with the last displayed tree. Only the latter result was used for presentation.

## Contract and ownership

Parser jobs now accept an optional `comparison: { previous, edits }` independently of the parsing `previous` and its `edits`. Omitting it keeps the existing comparison against the parsing base. Explicit `null` disables comparison. A separate comparison base must be a published tree of the parser's language, and its descriptor identity participates in job resumption. `changedRangesBaseRevision` on the immutable result identifies the revision being compared; it is `null` for fresh parses and explicitly untracked results.

The separate private copy is prepared only after incremental parsing finishes. An incremental job with a comparison base makes exactly one native `getChangedRanges` call to supply the final ranges. Cancelled, closed and fresh jobs do not prepare that copy. Both private copies are disposed after success or comparison failure. `prepareTree` now also deletes its private copy if applying edits throws. The mode verifies that returned ranges refer to the last displayed revision, so repairing text back to the older healthy checkpoint still invalidates the former error scopes correctly.

The error-free checkpoint, the unsafe-resumption fallback, journal bounds, 50 ms burst coalescing and first-two-slow-update policy are unchanged. This is a change to comparison ownership and the parser API, not a change of grammar, WASM build or dependency pins.

[Raw samples and source fingerprints](../benchmark/results/parser-comparison-performance-2026-10-20.json) preserve the measured variants.

## Method

The baseline is core `2b72dea02e24ef401e978d8a19535136b609d5bb`. Candidate commit `8b6acfb874484f031eec8746ee92c3832a358b9d` implements the measured change. Frozen source trees share installed dependencies and activate the same 37 packages from the working fleet. Source fingerprints are checked before and after each process. No package sources were intentionally changed; a pre-run whole-fleet fingerprint was not captured. Activation does not exercise every optional panel or command.

Three serialized ABBA rounds use before/after/after/before processes. The ordinary typing round opens generated JavaScript and CRLF Python files for 240 commands at 60/s and separately for 120 commands at 8/s. The long round uses 1800 commands at 60/s for each language. An isolated SOFiSTiK control uses 600 commands at 60/s on the supplied 8,400,039-byte, 195,789-line file. Generated JS contains 30000 exported functions; Python contains 24000 assignments; both include Unicode. Input starts near the end, with word boundaries and an Enter every sixtieth command. Intermediate syntax may be invalid.

Command duration covers synchronous editor/package work. Settlement is the interval after the final insertion returns until grammar and indentation settle. Renderer CPU is process user plus system CPU from input start through settlement, including UI, packages and other renderer threads. Frame gaps are requestAnimationFrame timestamps, not physical presentation. A callback arriving after settlement is not recorded. These are timer-driven editor API commands, not OS keyboard dispatch. Initial readiness/scrolling, final syntax hashing, serialization and close are outside the measured input/settlement interval. Input, final text and named syntax-tree hashes must agree across variants, and the final tree revision/input must be current. No files are saved.

Correctness tests finish before timing. Timing processes run one at a time without concurrent tests, profiling or forced GC. Two processes per variant provide observations on this workstation rather than confidence intervals. The 120-command slow-input control is longer than the preceding report's 24-command case; comparisons here use the same workload on both variants rather than comparing across reports.

## Results

### Ordinary typing

CPU columns are means of two processes; settlement columns show both results as a range. Command/frame p95 pool equal-sized samples.

| Grammar    | Commands / rate | Renderer CPU ms before → after | CPU change | Settlement ms before → after | Command p95 ms before → after | Frame-gap p95 ms before → after |
| ---------- | --------------: | -----------------------------: | ---------: | ---------------------------: | ----------------------------: | ------------------------------: |
| JavaScript |      240 / 60/s |                    3594 → 3641 |       1.3% |            157–166 → 132–150 |                     4.3 → 4.4 |                     16.8 → 16.7 |
| JavaScript |       120 / 8/s |                  14547 → 13500 |      -7.2% |             114–128 → 87–103 |                     3.0 → 2.9 |                     33.3 → 16.7 |
| Python     |      240 / 60/s |                    3000 → 3148 |       4.9% |            164–168 → 163–177 |                     3.3 → 3.5 |                     16.8 → 16.8 |
| Python     |       120 / 8/s |                  15328 → 14649 |      -4.4% |             116–161 → 98–106 |                     1.0 → 1.0 |                     16.8 → 16.7 |

At 8/s, renderer CPU decreases by 7.2% for JS and 4.4% for Python. JS frame-gap p95 drops from 33.3 to 16.7 ms, while Python remains near 16.7–16.8 ms. Mean final settlement falls by approximately 26 ms for JS and 36 ms for Python. This is the clearest renderer benefit: the comparison is paid repeatedly while syntax publishes between keys.

The rapid 240-command cases are mixed. JS settlement improves, but its command median rises from 0.8 to 1.5 ms and backlog p95 from 141.6 to 162.0 ms. Python CPU rises 4.9%, settlement is similar, and maximum frame gap rises from 200.0 to 266.7 ms. These observations are retained rather than treating every change in timing as a win.

### Long streams

CPU columns are means of two processes; settlement columns show both results as a range. Command/frame p95 pool equal-sized samples.

| Grammar    | Commands / rate | Renderer CPU ms before → after | CPU change | Settlement ms before → after | Command p95 ms before → after | Frame-gap p95 ms before → after |
| ---------- | --------------: | -----------------------------: | ---------: | ---------------------------: | ----------------------------: | ------------------------------: |
| JavaScript |     1800 / 60/s |                  19774 → 19211 |      -2.8% |            172–235 → 171–172 |                     2.5 → 2.6 |                     16.7 → 16.7 |
| Python     |     1800 / 60/s |                  16954 → 16969 |       0.1% |            202–255 → 187–190 |                     2.8 → 1.0 |                     16.7 → 16.7 |

Long-stream JS command median stays at 1.4 ms and p95 changes from 2.5 to 2.6 ms; Python median stays at 0.6 ms and p95 falls from 2.8 to 1.0 ms. CPU changes by −2.8% for JS and +0.1% for Python. Final settlement is lower, but two processes cannot isolate every source of variation. Maximum frame gaps remain high: 150.0 → 166.7 ms for JS and 216.5 → 233.3 ms for Python. The change does not solve startup observations or guarantee a frame deadline.

### SOFiSTiK control

| Variant | Mean renderer CPU ms | Command median ms | Command p95 ms | Frame-gap p95 ms | Maximum frame gap ms |
| ------- | -------------------: | ----------------: | -------------: | ---------------: | -------------------: |
| before  |                 9195 |               5.8 |            7.9 |             16.8 |                 66.7 |
| after   |                 9618 |               5.6 |            7.6 |             16.8 |                 50.0 |

SOFiSTiK command median/p95 improve slightly in this sample, but renderer CPU rises 4.6%. This control does not establish a general CPU improvement or absence of all overhead.

### Isolated comparison control

Separate Node processes use generated JavaScript with an error-free reuse tree, a displayed tree containing an error and a further local edit. Each process discards four warmup parses and records twenty synchronous parses. The baseline performs both comparisons, matching the former mode behavior; the candidate supplies the displayed comparison base to the parser. Both final syntax hashes and changed-range hashes agree, and every measured job asserts the native comparison count. These timings isolate parser work and do not represent renderer latency.

| Variant | Comparisons per parse | Total parse median ms | Total parse p95 ms | Comparison median ms | Comparison p95 ms |
| ------- | --------------------: | --------------------: | -----------------: | -------------------: | ----------------: |
| before  |                     2 |                 78.74 |             100.12 |                29.04 |             40.26 |
| after   |                     1 |                 63.77 |              79.28 |                14.97 |             17.64 |

The isolated median spent in comparisons falls from 29.04 to 14.97 ms, and complete synchronous parse median from 78.74 to 63.77 ms. This supports the specific removal of redundant native work; it is not a claim that every editor command saves 15 ms.

## Validation and limits

All validation suites pass: node (127), core (524), autocomplete (455), bracket-matcher (215), language-javascript (35), language-python (44), line-ending (60), symbol-tree-sitter (55), outline-view (86), indent-guide (28), language-sofistik (86). The 20 focused parser tests and five focused renderer specs overlap these counts. New tests cover one comparison against the displayed revision, immutable ranges and preserved old nodes, resumption identity, deferred comparison preparation, close/reset cleanup, preparation/query exceptions, null comparisons, fresh fallback and invalid comparison bases. The large-buffer regression also asserts a single native comparison and verifies ranges after repair back to the healthy text. ESLint, formatting and whitespace checks pass; dependency pins and lockfiles are unchanged.

The first expensive synchronous updates and individual native comparisons/destructors can still exceed a frame. A file without a usable healthy checkpoint can still fall back to fresh parsing. This round does not change those policies or repeat the earlier long memory-residency experiment. Fixtures, frozen sources and orchestration remain under `.dev/parser-comparison-20261020`; the private file's path and contents are excluded from committed results.
