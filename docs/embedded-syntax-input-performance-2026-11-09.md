# Embedded syntax and interactive input

The syntax worker preserves reusable root and embedded-language trees when preparing an atomic text edit. Interactive input has a bounded request/reply contract and takes priority over optional presentation work. The renderer still publishes text, whitespace and selections together; language indentation queries remain the source of indentation behavior. See [syntax ownership](syntax-worker.md) and [indentation plans](text-buffer-tree-sitter.md#indentation-plans) for the contracts.

## Changes

`SyntaxSnapshot` captures available published trees with parent identity, grammar/query generation, injection properties, owner extent and included ranges. A candidate shares the immutable source, replays its exact local edit journal and rediscovers topology. It lazily copies a tree only after the new owner and ranges match. Matching uses an index per parent and revision; absent, stale or ambiguous baselines require a fresh parse. Capture is bounded and unused layers allocate neither markers nor copied WASM trees. Included language ranges remain distinct from parser boundary hints.

`prepareInputIndentation()` handles at most 128 changes, 65536 inserted UTF-16 units and 128 requested rows. It returns one complete plan without stream acknowledgements. Larger mutations, moves and pastes use the existing range stream. Both routes share cancellation, coverage validation, indentation application and the editor's atomic commit machinery. No second set of Python or IPython heuristics was introduced.

Input requests hold a worker priority barrier while preparing their exact result. Presentation waits at tile, retry, preview and acknowledgement boundaries; fold preparation yields after a cooperative 4 ms allowance. The barrier handles concurrent and nested input, independent view cancellation and host shutdown. Its wakeup runs after the input reply's microtask, preventing resumed paint from delaying delivery of that reply. Private input candidates also have explicit parser priority ahead of preview and focused-document work, while scheduler aging continues to admit background slices. A native query already running still has to reach its own cooperative boundary; the allowance is not an end-to-end latency guarantee.

## Diagnosis and causal controls

The original private regression fixture contained 53,527 UTF-8 bytes and 1,463 rows. Enter inserted CRLF at the end of display line 120. Its source and raw private traces remain outside the repository.

Before the change, the private syntax candidate copied only the IPython scaffold tree. Its combined Python injection started with no previous tree and parsed nearly the complete document again. Independent Node profiling attributed about 282 ms of a representative 287 ms request to that parse. A diagnostic control reusing the existing injection tree reduced the worker median from 287.90 to 7.04 ms, with matching AST structure, ranges, revisions and error flags. This established the cause before implementing general layer matching.

The first production snapshot implementation reused both trees, but actual renderer publication still took roughly 33–43 ms while presentation was active. Worker tracing showed offscreen paint tiles running between the root and Python parse steps. The Python parse itself took about 1.3 ms. Diagnostic controls measured about 17.5 ms without fold warming and 5.1 ms without paint. These controls were instrumented experiments, not final performance measurements. The input-priority barrier addresses this scheduling competition.

## Renderer measurements

The final runtime revision is `ce120f8ebc23185894a4b118ed89768ec25813de`. It ran in a fresh isolated dev profile with the default syntax service, complete grammar registry, Electron 45.2.3, Chromium 156.0.8078.80 and Node 24.22.2 on Windows. The registry and every language mode were asserted to use the worker. No worker, rendering or service methods were overridden. No other test or benchmark ran concurrently. Measurements use editor API calls rather than operating-system key injection or compositor capture.

Each fixture records its first Enter separately, then five warm Enter/undo cycles. Publication is the first applied-text event, completion is the returned input promise, layout is explicit component update and grammar settlement is `whenGrammarSettled()`. Offscreen presentation may continue after grammar settlement. Every cycle verifies one exact atomic publication, CRLF text, complete undo and restored cursor; the original disk file remains unchanged. The two pauses sample different phases of background work rather than proving that the worker is idle.

| Private fixture               | Pause before Enter | First publication | Warm publication median / maximum | Warm completion | Warm grammar settlement |
| ----------------------------- | -----------------: | ----------------: | --------------------------------: | --------------: | ----------------------: |
| IPython, original             |              50 ms |           39.5 ms |                    16.4 / 18.6 ms |         16.8 ms |                 28.1 ms |
| Python, identical text        |              50 ms |           17.9 ms |                     8.8 / 19.3 ms |          9.2 ms |                 21.5 ms |
| IPython, indentation disabled |              50 ms |            0.7 ms |                      0.5 / 0.7 ms |          0.6 ms |                 16.6 ms |
| IPython, twice the text       |              50 ms |           25.4 ms |                    17.8 / 20.1 ms |         18.1 ms |                 30.2 ms |
| IPython, three times the text |              50 ms |           18.7 ms |                    19.7 / 20.2 ms |         19.9 ms |                 33.8 ms |
| IPython, original             |             250 ms |            7.1 ms |                      5.1 / 5.4 ms |          5.4 ms |                  9.5 ms |
| Python, identical text        |             250 ms |            5.7 ms |                      5.1 / 5.7 ms |          5.5 ms |                  9.3 ms |
| IPython, indentation disabled |             250 ms |            0.6 ms |                      0.6 / 0.8 ms |          0.8 ms |                  7.0 ms |
| IPython, twice the text       |             250 ms |           13.1 ms |                     9.8 / 10.3 ms |         10.1 ms |                 16.9 ms |
| IPython, three times the text |             250 ms |           33.5 ms |                    31.7 / 37.8 ms |         32.1 ms |                 58.0 ms |

An earlier eight-trial run on `d13aa2dbc637af18d9521353082acbad61b6a27b`, using the same 50 ms pause, measured a warm publication median of 446.9 ms and range 418.1–479.6 ms after excluding the first trial. A separate two-frame comparison measured 478.4 ms; it is a different sampling condition and is not pooled with the final table. There was no pre-change 250 ms measurement, so that pause is reported separately. Background work still affected the tripled fixture after 250 ms; a longer pause is not a guarantee of an idle worker. The observed first-operation and background-contention costs remain visible in the table.

## Public synthetic benchmark

The [benchmark](../benchmark/embedded-input-benchmark-spec.js) constructs public synthetic Python/IPython record definitions, HTML with JavaScript/CSS templates and Markdown wrapping the HTML fixture. Sizes are 100 and 300 records. Single Enter, immediately queued typing and an actively parsing competing document make 24 cases. Each case has one warmup and five measured trials, for 144 complete edit/undo cycles. All expected text, publication counts, selections and undo checks passed.

The [raw results](../benchmark/results/embedded-input-performance-2026-11-09.json) retain every sample, medians, sample p95, runtime versions, source/code hashes, fixture input/output hashes, exact configuration and measurement timestamps. The benchmark asserts the worker registry, asynchronous language modes, a shared service and asynchronous Enter preparation. Earlier synthetic runs accidentally used the Jasmine runner's default inline backend; they are excluded from worker performance evidence. The public table reports the final worker run, not a controlled before/after comparison with those inline runs.

| Language | Single Enter publication, 100 / 300 records | Publication with competing document, 100 / 300 records |
| -------- | ------------------------------------------: | -----------------------------------------------------: |
| Python   |                              28.8 / 19.4 ms |                                         23.8 / 21.5 ms |
| IPython  |                              22.3 / 24.9 ms |                                         22.0 / 25.9 ms |
| HTML     |                              11.3 / 10.3 ms |                                         15.3 / 19.4 ms |
| Markdown |                               9.5 / 11.2 ms |                                         15.1 / 19.4 ms |

Queued typing measures a different operation: its final publication median reaches 68.6 ms and grammar-settlement median reaches 129.6 ms in this matrix. The largest observed first publication is 42.3 ms, queued final publication is 78.8 ms and grammar settlement is 137.8 ms. The competing document completes separately in about 648–2071 ms. Low foreground publication latency does not imply constant settlement cost or an improvement in every background metric. Five samples describe this local run, not a cross-machine latency guarantee.

Reproduce with an isolated `LUMINE_HOME`, `CI` unset, `LUMINE_SYNTAX_EXECUTION=worker`, `LUMINE_EMBEDDED_INPUT_BENCH_CONFIG={"sizes":[100,300],"samples":5,"warmups":1}` and `LUMINE_EMBEDDED_INPUT_BENCH_OUTPUT` set to the output JSON path, then run `npm run test:only -- benchmark/embedded-input-benchmark-spec.js`. Keep source/package versions and fixture fingerprints fixed when comparing runs. CI runs a small worker-only correctness matrix without latency thresholds on all three platforms.

## Correctness coverage

Differential snapshot tests compare every node's type and coordinates, included ranges and source against a clean parse. They cover nested and same-language sibling layers, combined holes and cell splits/merges, endpoint insertions, adjacent replacements, deleted owners, grammar and query changes, mutable injection properties, root policies, stale parents, missing journals and unused-candidate disposal. A deterministic 1000-sibling test guards linear matching work without timing thresholds.

Transport tests exercise the real service/client/endpoint/host path, inline cardinality and limits, cancellation, changing input intent and release of speculative sessions. Renderer tests preserve atomic publication, markers, hooks, multicursors, queued input and undo/redo. Priority tests cover waiting and overlapping inputs, cancellation, host shutdown, viewport changes after acknowledgement, timeout retries, delayed previews and cooperative fold preparation.

The first broad priority run exposed an old test assumption that all fold queries finish in one task. The test now waits for the fold notification while holding the original color acknowledgement, preserving its actual ordering and backpressure assertion. A separate 128-row transport test uses a controlled query clock because elapsed query budgets are covered independently. Neither adjustment relaxes production resource limits.
