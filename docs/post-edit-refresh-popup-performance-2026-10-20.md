# Post-edit refresh and first completion popup

This round follows [cold completion and scroll protection](interaction-latency-performance-2026-10-20.md). It removes redundant symbol requests, avoids rebuilding equivalent semantic classifications, and reduces the work needed for the first completion menu. [Raw measurements, source fingerprints, revisions and validation](../benchmark/results/post-edit-refresh-popup-performance-2026-10-20.json) include the unfavorable cases as well as the gains.

## Changes

The symbol registry already invalidates the previous revision immediately on a text change. Its later stop-changing event now preserves a current in-flight request or completed cache entry. It still notifies views, whose getters join that current generation. Explicit provider invalidation and subsequent edits continue to invalidate normally. This avoids cancelling and restarting a valid request when a consumer asks for symbols before the edit debounce expires.

Semantic classifications are compared with the edit-translated token index in cooperative 4 ms slices. An equivalent answer retains the index and its markers. Modifier arrays belong to the consumer snapshot, so a provider mutating its own array cannot conceal a classification change. When a dense classification changes, equivalent token records retain their markers; only different decorations are recreated. Old-index traversal is used only when at least half its records have markers. Otherwise the viewport's small marker set is rebuilt, avoiding a full old-index scan merely to retain a few hundred decorations. A comparison overtaken by another edit cannot publish.

Snippet completion reads scoped metadata without parsing bodies or constructing tab-stop models. Actual expansion still uses the existing parser and scope precedence. Autocomplete prepares popup modules independently of provider preparation, so loading presentation code cannot hold up data requests. Caret-offset measurement runs in the document read phase rather than forcing a separate editor update inside popup creation.

## Method

Each accepted scenario runs before/after/after/before in fresh Electron processes on Windows. Changed package sources are frozen and checked against their fingerprints. Tests and diagnostic CPU profiles run separately from accepted timings; no GC is forced. The baseline is the preceding JS model, not Superstring. Each condition has two process-level observations per variant, so reported ranges describe these samples rather than population tail latency.

The completion scenario activates 37 packages and opens the generated 30000-function JS fixture three times. It tests immediate typing after activation and typing after 500 ms idle. Popup readiness checks actual rows and both initialization/visibility gates, then waits two animation frames. A boolean identity assertion replaces an expensive diagnostic formatting of the editor object in the harness. Absolute frame values should therefore not be compared directly with the previous report's harness. Neither these readiness checks nor requestAnimationFrame intervals measure physical display presentation.

The real-file scenario activates 43 packages, including the actual SOFiSTiK LSP and its consumers, with Outline closed. The supplied 8,400,039-byte, 195,789-line file is tested at the middle and near EOF. Sixty Enter edits are followed immediately by three seconds of wheel scrolling and another six seconds of observation. Two consumers request the symbol tree/flat list 50 ms after typing, before the stop-changing debounce. The benchmark uses a 10-second symbol-provider timeout so both variants can complete the 195778-symbol answer; the default two-second budget sometimes timed out in preliminary runs. Wire request counts are collected at the connection, avoiding double-counting the session's recursive partial-result dispatch.

A separate scenario isolates decoration work from RPC using a deterministic provider through the real service with 38 active packages. It tests 20000 tokens with all 20000 markers materialized, and 100000 indexed tokens with 415 viewport markers. Each sequence includes an unchanged answer, one changed type, and another unchanged answer; the large case also changes the last token. Work time awaits the manager's fetch, including its cooperative yields. Presentation time includes two subsequent animation frames. Materialized markers are not equivalent to that many visible DOM spans.

## Results

### Symbol and semantic refresh on the supplied file

The early-consumer scenario sends two document-symbol requests before the change: the first is cancelled by the debounce and the second completes. After the change it sends one request. All four cases per variant complete with 195778 symbols. The unchanged 23558-token classification rebuilds its index in all baseline cases and retains it in all candidate cases. Maximum post-edit frame intervals remain approximately 16.8 ms in both variants; these runs demonstrate less redundant work, not a newly achieved frame-rate improvement.

### Decoration work

Durations below are milliseconds for the first unchanged refresh and the indicated partial change.

| Classification               | Operation          |     Before |     After | Candidate marker retention |
| ---------------------------- | ------------------ | ---------: | --------: | -------------------------: |
| 20000 tokens / 20000 markers | Unchanged          | 97.6–103.8 |       1.6 |                      20000 |
| 20000 tokens / 20000 markers | One changed type   |  88.0–92.9 | 15.7–16.3 |                      19999 |
| 100000 tokens / 415 markers  | Unchanged          |  23.1–24.1 |   5.7–6.0 |                        415 |
| 100000 tokens / 415 markers  | First type changes |  14.1–15.0 | 17.9–18.6 |                          0 |
| 100000 tokens / 415 markers  | Last type changes  |  11.6–11.9 | 18.9–19.5 |                          0 |

There is a real tradeoff: checking equality costs several milliseconds when a large response actually differs, particularly when the difference is late in the sequence. Sparse partial changes remain about 4–8 ms slower than baseline, although measured frame intervals in these cases stay around 16.7 ms. The sparse-case guard avoids an additional old-index scan that was measurably more expensive in the preliminary implementation. Repeated unchanged large answers take 3.7–4.1 ms instead of 16.5–16.6 ms. These results support reuse for equivalent replies and dense decorations, not a claim that every update is faster.

### First popup

| Condition                | Suggestion publication before |       After | Popup readiness + two frames before |       After |
| ------------------------ | ----------------------------: | ----------: | ----------------------------------: | ----------: |
| Immediate typing         |                   186.0–195.2 | 133.0–133.9 |                         235.9–236.3 | 220.2–223.0 |
| Typing after 500 ms idle |                   112.6–119.7 |   81.9–82.7 |                         165.7–168.2 | 120.1–128.8 |

The first input command remains comparable: roughly 14–15 ms for immediate typing and 22–24 ms after idle. Data becomes available earlier, but fully cold presentation still competes with parsing/comparison and editor rendering. Immediate-start maximum frame intervals remain approximately 67 ms; this does not close the 16.7 ms budget. After idle, measured initial frame intervals improve from 33–50 ms to approximately 16.7 ms in these samples. Diagnostic profiles identify removal of snippet-body parsing from the menu path and reduced synchronous popup work, while native syntax comparison remains a separate cost.

## Validation and reproduction

All 1076 package tests pass: snippets 217, autocomplete 468, symbol 219 and semantic-tokens 172. Coverage includes scope metadata, actual snippet expansion/tab stops, cancelled loading, shared symbol requests, view notification, modifier ownership, late-result cancellation, equivalent refreshes, partial marker reuse and the sparse-case guard. ESLint passes for the changed packages and benchmarks. Dependency pins are unchanged. Commits are local; no CI or cross-platform result is implied.

Use [autocomplete-cold-benchmark-spec.js](../benchmark/autocomplete-cold-benchmark-spec.js), [post-edit-refresh-benchmark-spec.js](../benchmark/post-edit-refresh-benchmark-spec.js) and [semantic-refresh-benchmark-spec.js](../benchmark/semantic-refresh-benchmark-spec.js) through the editor's dev test runner with isolated homes, linked package variants and `CI` unset. Their environment-config keys are documented in the source. Cold cases do not activate semantic-tokens; their active package sources match final code. The refresh and decoration comparisons use the final sparse guard. Private input contents, input paths and diagnostic traces are excluded from the committed artifacts.
