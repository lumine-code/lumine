# Cold completion and scrolling after edits

This round removes completion initialization from the first input handler and keeps queued Tree-sitter destruction out of an active scroll gesture. The comparison is against the preceding JS text model, not against Superstring. [Raw samples, source hashes, package revisions and validation](../benchmark/results/interaction-latency-performance-2026-10-20.json) accompany the results.

## Changes

Autocomplete registers its services synchronously and begins background preparation when an editor is watched. Small module loads share up to 4 ms of an idle turn; an individual CommonJS load remains non-interruptible. A real completion request promotes pending preparation to separate Node timer tasks instead of waiting for idle timeouts. Concurrent requests share initialization. Cold buffer events retain only the latest applicable context; cancellation, focus loss, cursor movement, subsequent edits and disposal prevent an obsolete response from opening the list. The built-in provider checks cancellation before querying buffers. Prepared requests retain their existing synchronous dispatch path.

The Tree-sitter disposal queue previously considered only edits and resumed after 100 ms without typing. A user who immediately started scrolling could therefore encounter a large WASM `Tree.delete()` during the gesture. Accepted wheel input and actual horizontal/vertical viewport changes now renew the quiet period, including scrollbar dragging and every smooth-scroll frame. Disposal waits for 250 ms without this activity. The existing 2 ms batch allowance remains soft for a single destructor; the existing 2048-job pressure threshold still permits progress under sustained memory pressure.

## Method

Runs use Windows, Electron 44.9.0 and an Intel Core i9-10900K. Correctness tests finish before accepted timings. No profiler, forced GC or parallel test suite runs during accepted measurements. Input files are never saved. These are renderer command durations and requestAnimationFrame intervals, not measurements of physical display latency.

Autocomplete compares `127021c926eb6ea86023995fbe25eb8be83cdfff` with `5d1ba01477ef51efa0eb7761eab6fe2e9aabf2f9`, using the same core runtime in both variants. Separate fresh renderers run before/after/after/before for immediate typing and for typing after 500 ms idle. Each process activates 37 packages, opens a generated 30000-function JavaScript file three times, inserts a character at an existing prefix, waits for actual popup contents and follows with 120 letter/space edits at 60 Hz. The first opening exercises cold completion; later openings exercise reuse. Suggestion hashes, final text and full syntax hashes agree across variants. Module caches are fresh; this is not a cold-OS-filesystem-cache experiment. Each cold condition has only two observations per variant, so ranges are more useful than tail-percentile claims.

Scrolling uses the supplied 8,400,039-byte, 195,789-line SOFiSTiK file. Each process opens it at the middle and near EOF, types 60 Enters at 60 Hz, immediately dispatches 180 wheel events at 60 Hz, then observes another six seconds. Before/after/after/before runs are separate for 37 packages without LSP and 43 packages with SOFiSTiK LSP, semantic tokens and its other consumers. Outline is closed. The LSP variant waits for the server/document to become usable and explicitly selects its document-symbol source. These two configurations are not a measurement of the isolated cost of a server process: additional consumers are active in the latter.

The disposal comparison freezes core at `4c1ee4d01465f19d0830afb0be6cfd82d7f2f027` and applies the disposal patch from `495114e9a2e714de5e9c68dde3346ad4d396ce78` to the candidate. Both use the same frozen autocomplete snapshot, fully prepared before input. A separate final verification uses the merged core, including the concurrent blank-line viewport-preservation change, and final autocomplete. Other packages and the configured local SOFiSTiK server use linked workspace sources; publication-time Git revisions are recorded where available. Runtime hashes identify the frozen variants precisely.

Large-file checks verify the settled revision, exact tree input, root extent, error state and matching output hashes. They deliberately avoid serializing the whole syntax tree between measured reopenings: an early diagnostic harness did so and introduced seconds of work and extra allocation pressure. Those diagnostic timings are excluded from the accepted comparisons.

## Completion results

All durations below are milliseconds; ranges cover the two cold observations.

| Condition                         | First command before | First command after | Suggestion publication before | Suggestion publication after |
| --------------------------------- | -------------------: | ------------------: | ----------------------------: | ---------------------------: |
| Immediate typing after activation |            33.4–35.9 |                15.1 |                   128.0–131.8 |                  163.5–196.8 |
| Typing after 500 ms idle          |            38.3–46.2 |           21.7–22.3 |                   132.1–138.1 |                  108.7–109.4 |

The immediate case protects the input handler at the cost of later first suggestions. It does not make all startup work disappear. With preparation time available, both first input and suggestion publication improve. Maximum frame intervals from first input through popup readiness fall from approximately 133 ms to 83–100 ms in the immediate case, and from 50–67 ms to approximately 33 ms after idle. Consequently this is not a guarantee that the first popup or every first command fits a 16.7 ms frame.

Prepared typing remains comparable: across the two conditions, command medians are 0.9 ms before and 0.8–1.0 ms after; p95 is 2.1–3.6 ms before and 1.7–3.8 ms after. These small differences do not establish a general warm-path speedup.

## Scrolling results

All 16 ordinary sequences have maximum active-scroll frame intervals of approximately 16.8 ms, before and after, with and without LSP. They do not reproduce a rare destructor every time. One candidate LSP case has a 33.4 ms interval after scrolling has stopped.

To exercise the diagnosed condition reproducibly, a separate four-process ABBA round independently parses one real full-size WASM tree before measurement, then places that retired tree in the disposal queue immediately after typing. This is controlled resource-retirement stress, not a claim that every normal edit destroys such a tree. It uses the same file, real destructor and 43-package LSP configuration, without forced GC.

| Controlled retirement | Maximum frame during scrolling | Maximum frame after scrolling |
| --------------------- | -----------------------------: | ----------------------------: |
| Before                |                  83.3–133.3 ms |                       16.8 ms |
| After                 |                        16.8 ms |                 83.3–116.6 ms |

The work is moved, not eliminated. Final merged-state verification also holds active scrolling to 16.8 ms: the measured destructor takes 115.4 ms and starts 250.4 ms after the scroll animation ends. This directly checks both the scheduling protection and eventual cleanup.

LSP responses still cause document-symbol processing, semantic-token updates and allocations. Their asynchronous arrival is distinct from a renderer stall. The reproduced large pause was in WASM tree destruction; these changes do not claim to remove every LSP-related or garbage-collection pause. A native destructor already running cannot be preempted, and memory pressure can override deferral.

## Validation and reproduction

Autocomplete passes 468 tests, the component/scroll suites pass 361 tests on the merged core, and the disposal queue passes five Node tests. Coverage includes cold-request cancellation and promotion, provider disable/re-enable, teardown, delayed requests, commit characters, Undo, scroll animation and pressure-driven cleanup. ESLint passes for autocomplete and the changed core/benchmark files. Dependency pins are unchanged; no CI or cross-platform result is implied.

Use [the completion benchmark](../benchmark/autocomplete-cold-benchmark-spec.js) with `LUMINE_AUTOCOMPLETE_COLD_CONFIG`, and [the scroll benchmark](../benchmark/typing-scroll-benchmark-spec.js) with `LUMINE_SCROLL_CONFIG`. Both run through the editor's dev test runner with an isolated `LUMINE_HOME`, `LUMINE_RESOURCE_PATH`, linked package variants and `CI` unset. Supply local absolute input/output paths; set `retiredTree: true` only for the controlled retirement scenario. The private source, its path and CPU traces are not included in the published artifacts.
