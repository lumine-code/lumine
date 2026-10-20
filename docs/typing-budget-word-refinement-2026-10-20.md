# Typing budgets and incremental word filtering

This round follows [symbol-coordinate pruning](symbol-coordinate-performance-2026-10-20.md). It reduces recurring syntax work in the input command and reuses completion filtering for unchanged word-index blocks. [Measurements and source fingerprints](../benchmark/results/typing-budget-word-refinement-2026-10-20.json) include the slower cases and syntax-publication delay.

## Implementation

Large buffers keep a shared foreground parse allowance of 2 ms instead of 8 ms. A complete synchronous syntax update exceeding 4 ms, previously 12 ms, switches subsequent large-buffer updates to the existing asynchronous path. This catches recurring 5–6 ms work that previously completed within the allowance on every keypress. Small buffers and explicit synchronous parsing retain their existing policy. Resumable parsing, cancellation, current-revision publication and the existing 50 ms burst coalescing remain intact. These deadlines are cooperative: native tree comparison and cleanup can still overrun them.

Each immutable word block retains one complete candidate list for its last nonempty folded query. A longer prefix filters that list, since a word rejected by a shorter subsequence cannot match its extension. An identical folded query reuses eligibility directly. An unrelated query scans the block again. Ranking, cursor distance, occurrence counts and range clipping are recomputed for the current request. Row translation reuses relative positions; an intersecting edit evicts the changed block. Only complete per-block filters are published, so interleaved and cancelled requests cannot expose partial candidate lists. The existing block/occurrence limits also bound retained filter entries. Matching checks its cooperative deadline every 64 candidates instead of every candidate.

## Method

Accepted fleet timings use separate frozen copies of the baseline core at `f535280717` and the candidate, plus copied package files. Both include the preceding symbol-coordinate optimization. Shared installed library dependencies remain pinned, including the native fuzzy dependency retained in the isolated core; the concurrent fuzzy migration is not part of this comparison. Runs are before/after/after/before in fresh Electron processes for each operation, with 43 packages, the real SOFiSTiK LSP, Outline closed and a complete 195778-symbol cache.

Each process opens the supplied 8400039-byte, 195789-line file at its middle and 100 rows before EOF. Sixty characters or Enter keys at 60 Hz are followed immediately by three seconds of wheel scrolling and six seconds of observation. A settlement observer measures time from the last input until syntax and pending automatic indentation are ready. Input contents are never copied or saved. The harness verifies unchanged input hashes, equal edited-text hashes and current syntax input, revision, extent and error state. Timings, tests and diagnostic profiles run separately.

The word benchmark uses 6000 generated rows with unique names, repeated words and Unicode. It records a cold query followed by eight cycles of repeated queries, prefix refinement, unrelated queries, Unicode queries or refinement interleaved with edits. Full result hashes match in every before/after run. Both experiments have two process-level observations per variant/condition; the ranges below describe those observations, not population tail guarantees.

## Fleet results

All durations are milliseconds for the complete synchronous editor command.

| Operation | Position | Median before | Median after | p95 before | p95 after |
| --------- | -------- | ------------: | -----------: | ---------: | --------: |
| Character | Middle   |           1.3 |      1.2–1.3 |    2.4–2.5 |   2.3–2.4 |
| Character | Near EOF |       1.2–7.1 |      1.1–1.2 |    8.1–8.5 |   1.4–1.6 |
| Enter     | Middle   |       3.0–3.1 |      3.0–3.1 |    3.8–4.1 |   4.3–4.6 |
| Enter     | Near EOF |       1.0–6.4 |          1.1 |    1.3–7.4 |   1.4–1.5 |

The principal gain is more consistent input near EOF. The earlier policy sometimes already deferred after an unusually expensive update; in those runs its median was also near 1 ms. Enter in the middle does not improve materially and its measured p95 is slightly worse. The candidate's maximum individual command remains 27.9 ms. Candidate typing-frame intervals stay around 16.8 ms, but wheel scrolling after middle-of-file character edits still has an interval around 33.2 ms. Frame timestamps are not physical display latency, and this is not a claim that every operation fits one frame.

There is an explicit publication tradeoff. Near EOF, final syntax readiness changes from 0.4–67.6 ms to 57.1–57.5 ms for characters, and from 0.2–59.7 ms to 55.8–63.4 ms for Enter. The near-zero baseline cases completed syntax in the input command itself. At the middle, character readiness remains approximately 250–261 ms and Enter readiness is approximately 59–68 ms. The improvement comes from spending less work on each keypress and coalescing bursts, not from making the parser's entire job disappear.

## Word-query results

Median completion-query wall time includes ranking and cooperative yields.

| Scenario              |    Before |     After |
| --------------------- | --------: | --------: |
| Prefix refinement     | 15.8–15.9 |   4.7–4.9 |
| Repeated query        | 14.8–15.6 |   2.0–2.3 |
| Refinement with edits | 16.0–16.2 |   5.0–5.1 |
| Unrelated queries     | 14.6–14.7 | 13.4–13.7 |
| Unicode queries       | 21.7–22.0 | 14.5–14.8 |

Across the full refinement sequence, query time falls from 909–913 ms to 382–391 ms; with edits it falls from 908–928 ms to 363–366 ms. Cold-query costs are not consistently improved: for example, the unrelated-query fixture's initial query measures 31.2–32.9 ms before and 34.0–39.3 ms after. The cache is intended for continued typing over existing blocks. It neither retokenizes the document on edits nor maintains an unbounded history of queries.

The final candidate's separate CPU profile attributes approximately 31–34 ms of sampled stack time to `WordIndex.find` across each 60-character sequence and about 1.7 ms to synchronous `updateRootLayer` work near EOF. Background parsing still runs outside that synchronous stack. These accumulated diagnostic samples are not individual pause durations or a substitute for the paired latency measurements.

## Validation

All 757 tests pass: 253 core syntax integration specs, 36 Node tests for the text store, completion matching and word index, and 468 autocomplete specs. The core integration suite covers large and small buffers, synchronous overrides, first-edit parser resumption, cancellation, nested/combined injections, scope publication, multiline paste, multiple cursors and undo/redo. It also checks immediate text entry after a deferred Python newline in a large file, including block indentation and grouped undo. Node tests compare indexed candidates against scanning across edits, range changes, Unicode, concurrent queries and cancellation; a work-count guard verifies that refining a prefix does not revisit rejected block words. Changed sources pass ESLint and formatting checks. This change leaves dependency pins untouched and preserves the concurrent fuzzy work.

Reproduce with [post-edit-refresh-benchmark-spec.js](../benchmark/post-edit-refresh-benchmark-spec.js), enabling `requireSymbols` and `measureSyntaxSettlement`, and [word-refinement-benchmark.js](../benchmark/word-refinement-benchmark.js) under Electron's Node mode. Keep local test environments free of `CI`. The results compare successive JS-model versions on Windows and do not establish cross-platform CI coverage or a new comparison against Superstring.
