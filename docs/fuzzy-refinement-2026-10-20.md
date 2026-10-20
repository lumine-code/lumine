# Fuzzy query refinement follow-up

The optimized JavaScript port meets the migration criterion on the measured Lumine workloads, so the editor now uses `@lumine-code/fast-fuzzy`. Extending `se` to `sel` over 100000 paths takes 93.70 ms, versus 155.90 ms for the first JS port and 90.60 ms for native. At 10000 paths it takes 14.75 ms, versus 22.05 ms and 14.95 ms respectively. The remaining 100000-path difference is about 3.4%; easier profiling and maintenance justify adopting JS at this level of similarity. This supersedes the initial decision in the [first evaluation](fuzzy-matching-evaluation-2026-10-20.md), which also documents the consumer review.

These are local Windows measurements. They establish the decision for this corpus and machine, not a universal claim that JavaScript outperforms native code or that a 100000-item synchronous search cannot block the renderer.

## Normalize each candidate once

Candidate construction prepares case folding, optional diacritic expansion, original highlight offsets, an ASCII letter mask and path metadata. The same prepared candidate is used for every query until the candidate set changes. ASCII candidates stay as compact strings; Unicode candidates retain code-point arrays and explicit original offsets. This does not remove non-ASCII text. Accent-insensitive matching remains an explicit option.

Only the new query is normalized when another letter is typed. The patch also removes a duplicate ASCII lowercase operation and moves path-end, basename and directory-depth work out of scoring. The list integration reuses its batch matcher across queries and obtains visible-row highlights from its prepared candidates. Alternate display labels use a bounded single-text cache. Consumer-owned query sources retain their own filtering policy.

## What can safely be reused

Fuzzaldrin first checks that all required query characters occur as a subsequence, then computes a score for the complete query. The eligible candidate set can only shrink when the required-character sequence is extended. The optimization stores every eligible candidate, including candidates whose previous score was zero, plus the earliest feasible end of its required subsequence. It never uses a top-N result set as the next search space.

The endpoint proof follows greedy subsequence matching: after each required character, the greedy endpoint is no later than the corresponding endpoint of any other embedding. An appended suffix fits after some embedding if and only if it fits after that earliest endpoint. Therefore only the appended required characters need another eligibility scan. A preferred scoring alignment does not provide this guarantee: for `xaxb/ab`, the earliest `ab` ends at offset 4, while the preferred basename occurrence ends at 7. Continuing from 7 would incorrectly reject `aba`.

Every surviving candidate is scored again against the full new query. Optional separators, acronym bonuses, basename scores and consecutive-run bonuses can change with the complete query. In particular, the eligibility endpoint must not clip the scoring matrix: Fuzzaldrin can score a partial alignment after its independent full-subsequence check. The regression fixture `cbxc` queried with `bc` covers this distinction. Changed options or candidate contents invalidate incompatible reuse; highlighting alone does not qualify a query as a completed candidate scan.

## Measured changes

The original profile led to work on alignment, repeated path inspection and selection/allocation. Each scoring change was checked against the native implementation before evaluating performance.

| Experiment                                                                 | Disposition                                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Reuse earliest subsequence endpoints and scan only eligible IDs            | Retained; correct rejection reuse, but a modest gain alone.                                                                   |
| Prepare path metadata and lowercase strings once                           | Retained; removes query-independent work.                                                                                     |
| ASCII alignment with direct character access                               | Retained; Unicode keeps the general scorer.                                                                                   |
| Avoid redundant float32 rounding for short integer DP sums                 | Retained for lengths at most 32, whose bounded integer sums are below 2²⁴; longer queries keep explicit rounding.             |
| Two- and three-character alignment using scalar rolling rows               | Retained; same recurrence and miss-budget ordering, materially faster refinement.                                             |
| Reuse the previous best scoring alignment or score only after its endpoint | Rejected as incorrect.                                                                                                        |
| Copy VS Code's scoring-window bounds into Fuzzaldrin                       | Rejected as a semantic mismatch; the full-eligibility guard and partial scoring must remain separate.                         |
| Replace the algorithm with VS Code's kernel                                | Measured separately on its supported domain; not adopted because ranking, path policy and long-text behavior differ.          |
| Persistent worker pool                                                     | Measured end to end; remains an experiment because startup and candidate-publication costs need a separate production design. |

The final library retains both Command-T and Fuzzaldrin. No worker pool, approximate scorer or query-length truncation is enabled in production.

## Renderer measurements

The corpus has 5141 real relative source/spec paths; larger sets repeat them under numbered project roots. Six fresh renderer processes ran in native/old-JS/new-JS/new-JS/old-JS/native order. Each process used two warmups and nine samples. Rows below are means of the two process medians in milliseconds, measured through actual SelectList publication and layout. Native uses up to eight threads. Source hashes, runtime versions, individual samples and synchronous timings are retained in the [raw artifact](../benchmark/results/fuzzy-refinement-2026-10-20.json).

|  Paths | Operation           | Native | Initial JS | Optimized JS |
| -----: | ------------------- | -----: | ---------: | -----------: |
|  10000 | Open list           |   8.85 |       8.50 |         8.40 |
|  10000 | First query `s`     |  29.30 |      23.10 |        21.90 |
|  10000 | Extend `s` → `se`   |  19.95 |      26.20 |        19.10 |
|  10000 | Extend `se` → `sel` |  14.95 |      22.05 |        14.75 |
|  10000 | Backspace to `se`   |  19.00 |       8.10 |         7.90 |
|  10000 | Return to `s`       |  20.95 |      14.10 |        14.70 |
| 100000 | Open list           |  43.85 |      41.70 |        40.80 |
| 100000 | First query `s`     | 269.80 |     188.65 |       190.85 |
| 100000 | Extend `s` → `se`   | 157.55 |     213.20 |       144.70 |
| 100000 | Extend `se` → `sel` |  90.60 |     155.90 |        93.70 |
| 100000 | Backspace to `se`   | 155.90 |      35.90 |        37.65 |
| 100000 | Return to `s`       | 183.65 |      42.10 |        43.70 |

The refinement improvement is about 40% at 100000 paths and 33% at 10000 paths relative to the first JS port. Repeated queries still benefit from cached scores. The initial evaluation's native advantage for some isolated cold/top-N library calls remains a limitation; full-result SelectList workloads, including modifiers applied before final ordering, are the basis for this integration decision.

Two additional renderer processes validated the final installed pin without replacing any prototypes. Fuzzaldrin `se` → `sel` measured 14.20 ms at 10000 paths and 94.80 ms at 100000; Command-T measured 13.20 ms and 92.70 ms. Both algorithms passed the complete seven-query sequence through real layout. These are a later confirmation cohort, not additional samples mixed into the six-process paired comparison.

## Isolated scoring and memory

An additional native/JS/JS/native sequence measured the public `match()` API in fresh Node processes, with three warmups and nine samples. Candidate construction and the preceding query were outside the timed region, followed by explicit GC. These calls allocate complete result objects; the editor uses `matchIds()` and prepared highlights. Node and Electron also use different V8 builds, recorded in the artifact. Consequently, these numbers must not be substituted for renderer latency.

|  Paths | Uncached operation |   Native | Optimized JS |
| -----: | ------------------ | -------: | -----------: |
|  10000 | `se` → `sel`       |  6.35 ms |     14.01 ms |
|  10000 | `s` → `src`        |  7.15 ms |     14.32 ms |
|  10000 | `ma` → `main`      |  2.71 ms |      3.87 ms |
| 100000 | `se` → `sel`       | 71.20 ms |     94.63 ms |
| 100000 | `s` → `src`        | 83.04 ms |    104.16 ms |
| 100000 | `ma` → `main`      | 26.95 ms |     37.90 ms |

Native remains clearly faster for these isolated cold refinements. The migration decision is therefore specifically about the measured editor integration and its maintenance benefit, not raw scorer parity for every library consumer.

Separate fresh processes measured post-GC RSS increases for 100000 candidates, with input strings already allocated before the baseline. Means of two runs are:

| Stage               |     Native | Optimized JS |
| ------------------- | ---------: | -----------: |
| Prepared candidates |  42.24 MiB |    67.00 MiB |
| After eight queries | 138.89 MiB |   112.38 MiB |

Cached metadata increases prepared JS memory relative to the initial compact port. After querying, JS retains less total RSS than native in this experiment. RSS includes allocator and JIT behavior; it is not exact retained-object accounting. The query LRU is capped by both entry count and an 8 MiB array budget, with active query state retained separately.

## VS Code comparison

The review used Microsoft VS Code revision `7c4967fad9776df2bf2dc830b8e37aa11a452bff`, rather than assuming that its current implementation is the same as older descriptions of it.

- [CompletionModel](https://github.com/microsoft/vscode/blob/7c4967fad9776df2bf2dc830b8e37aa11a452bff/src/vs/editor/contrib/suggest/browser/completionModel.ts) narrows a compatible extension to previously filtered items and recomputes their scores. It also selects a cheaper scoring mode for large candidate sets.
- [filters.ts](https://github.com/microsoft/vscode/blob/7c4967fad9776df2bf2dc830b8e37aa11a452bff/src/vs/base/common/filters.ts) reuses scratch tables, uses earliest/latest feasible positions to restrict its own alignment work and caps matching at 128 UTF-16 units. Its scoring recurrence differs from Fuzzaldrin's.
- [fuzzyScorer.ts](https://github.com/microsoft/vscode/blob/7c4967fad9776df2bf2dc830b8e37aa11a452bff/src/vs/base/common/fuzzyScorer.ts) caches item scores. [AnythingQuickAccess](https://github.com/microsoft/vscode/blob/7c4967fad9776df2bf2dc830b8e37aa11a452bff/src/vs/workbench/contrib/search/browser/anythingQuickAccess.ts) combines asynchronous file sources with bounded result selection; this does not mean all fuzzy scoring runs off the UI thread.

A local adapter measured the pinned VS Code kernel on 5132 ASCII paths restricted so every generated candidate fits its 128-unit bound. At 10000 candidates, `se` → `sel` took 7.15 ms, `s` → `src` 8.10 ms and `ma` → `main` 3.15 ms; optimized Fuzzaldrin on that same restricted corpus took 13.90, 14.44 and 3.88 ms. These are isolated kernel measurements under a different ranking contract, not comparable replacement-quality claims. The imported source and its MIT notice remain in local research scratch space; none of that source is shipped in fast-fuzzy.

## Worker experiment

The diagnostic pool keeps a fixed partitioned candidate set resident and merges results with the synchronous implementation's complete ordering. Browser Web Workers execute only library JavaScript and data tables; no Node integration or Electron security-setting changes are needed. A direct Node worker experiment from the renderer failed with `ERR_MISSING_PLATFORM_FOR_WORKER`, so the accepted renderer measurements use browser workers.

At 100000 paths, eight resident browser workers delivered `se` → `sel` through list layout in 76.1 ms, with about 10.1 ms spent synchronously on the caller. Opening and preparing that list took 133.5 ms, versus approximately 40.8 ms for the synchronous implementation. Four workers took 83.2 ms for the refinement and 167 ms to open. Each accepted run verifies all result IDs against the synchronous matcher. The experiment uses query-source publication with explicit first-item selection, matching the synchronous query-reset policy.

This is promising for large persistent datasets but not an unconditional replacement: candidate changes, cancellation, overlapping requests, arbitrary score modifiers, small lists and worker lifecycle still need a production contract. The synchronous JS migration does not depend on this experiment.

## Correctness and reproducibility

Fast-fuzzy revision `28c749f5bbe1fd9bd1eb7db1b5190485c29bfce5` passes 130 specs. The final native differential run performs 1079026 comparisons with no eligibility or highlight-index differences and no score differences outside `max(1e-6, nativeScore * 1e-5)`. It also checks ordering across strictly separated native score groups; native ties do not provide a deterministic ordering guarantee. New tests cover exhaustive short subsequences, optional characters, mutations, generic-versus-specialized scoring at the float32 boundary, and cache limits when a score modifier throws.

The paired timing snapshot predates two correctness guards: trimming also happens before user score modifiers so exceptions cannot leave an over-budget LRU, and Command-T rejection reuse now requires unchanged original prefix characters. In Command-T, a long smart-case penalty can underflow to zero, and replacing existing uppercase query characters with lowercase can remove that penalty even when the folded prefix is unchanged. A dedicated regression test covers this case. These guards do not change Fuzzaldrin's scores or ordinary append-only ranking. The final pinned library is installed through npm in the editor; no sibling-repository resolution or manually edited lockfile stands in for the shipped dependency.

All 36 consumer packages passed against the installed refinement revision `35366b8`: 6743 specs, zero failures, with five previously disabled Jupyter specs. After adding the Command-T case-edit guard, the final installed revision passed the 343 focused editor/consumer specs again and the complete native differential comparison again. A subsequent complete graviss run also passed 481 specs after fixing the remaining synchronous temporary-directory teardown exposed by its Windows CI. Those cleanup changes preserve test assertions and await removal rather than blocking pending watcher/IPC callbacks.

The library's Windows, macOS and Linux CI passed for this revision. Its complete npm audit reports zero vulnerabilities. The editor's production audit reports zero vulnerabilities; the full development graph still reports eight moderate advisories in the unrelated electron-builder dependency chain. The previous editor CI formatting failures and a separate malformed public JSDoc header were corrected in a scoped documentation commit.
