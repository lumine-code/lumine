# Syntax ownership and repeated interaction work

This investigation separates three costs: cancelling obsolete syntax and completion work, uninterruptible WASM tree operations, and publishing syntax or symbols to consumers. It compares successive JavaScript-model versions on Windows, not JavaScript against Superstring.

The host has an Intel Core i9-10900K, 20 logical CPUs and 64 GiB RAM. Editor measurements use Electron 44.9.0 and web-tree-sitter 0.27.1; the standalone worker experiment uses Node 24.18.0.

## Changes

Large-buffer syntax updates now share a wait before submitting another parse and creating its cancellation controller. The owning language-layer transaction stays active throughout the wait, preserving indentation requests, publication metadata and grammar-settlement promises. Later edits move the quiet-period deadline without creating a new timer for every key. Destruction releases the wait. Small buffers and explicitly synchronous parsing bypass it.

The IDE completion provider avoids cancelling an already cancelled controller. Uncached automatic remote completion requests share a minimum 50 ms dispatch interval per editor; only an actual dispatch advances that deadline. This limits traffic during continuous typing without requiring a pause. Complete cache hits, manual invocation and server trigger characters bypass the gate. Superseded waits release their timers and cannot send a stale request. The tradeoff is up to approximately 50 ms of additional waiting for an uncached automatic remote request, plus event-loop scheduling. Other providers can compute immediately, but autocomplete currently merges through `Promise.all`, so publication of the combined list can inherit this wait. This change does not establish an improvement in popup latency.

## Diagnostic evidence

Frozen core baseline `8e081fd4ef2c5254881c47bd0b964cb73fe4ba35` and frozen package sources avoid the concurrent fuzzy-matcher migration. Both variants use the baseline's protected native fuzzy dependency. The supplied large document is read into memory only, never copied or saved. It has 8400039 bytes and approximately 196000 rows. Each process opens it twice, edits the middle and then near EOF, scrolls after typing and observes idle work. Outline is closed; the full 195778-symbol cache is required before typing. The LSP scenario explicitly activates 43 packages and the local-symbol scenario 38.

The initial CPU profiles and synchronous-call probes use 1800 characters at 60 Hz per opening. Candidate diagnostic runs use the same call probes without the CPU profiler. Counts are work evidence; instrumented durations are not the accepted latency comparison. Nested spans must not be added together.

| Work during one 1800-character sequence               |    Baseline | Candidate |
| ----------------------------------------------------- | ----------: | --------: |
| `parseAsync` submissions during typing                |        1798 |         0 |
| Active syntax aborts, middle / near EOF               | 1799 / 1798 |     1 / 0 |
| Wire completion requests with LSP                     |        1799 |       600 |
| Repeated aborts of the same LSP completion controller |        1799 |         0 |

Normal cancellation of active completion requests remains necessary. The gate reduces remote work rather than making current-request ownership optional. Syntax still publishes after typing; the absence of parse submissions during the burst does not mean parsing has been disabled.

The baseline profiles capture `getChangedRanges` at 19–21.3 ms after typing and a single tree deletion at 121.7–123.1 ms during reopening, with and without LSP. Candidate probes still record comparisons at 17.5–24.7 ms and individual deletions at 95.2–105.9 ms. These are synchronous native calls that a JavaScript deadline cannot interrupt. The previously reported 300 ms spike was not reproduced in these profiles.

## Editor latency without instrumentation

Eight fresh Electron processes compare baseline and candidate for letters and Enter, with and without LSP. Each process performs 600 inputs at 60 Hz at each of the two positions, followed by three seconds of scrolling and six seconds of observation. This gives 9600 measured inputs. Runs are serial, with no CPU profiler, synchronous-call probe or forced GC. Edited text and syntax input/revision/extent/error-state checks agree across each pair. There is one process per variant and condition, so small timing differences are not evidence of statistical significance.

| Condition              | Position | Input p99 before, ms | Input p99 after, ms |
| ---------------------- | -------- | -------------------: | ------------------: |
| Letters, LSP           | Middle   |                  1.6 |                 1.6 |
| Letters, LSP           | Near EOF |                  1.0 |                 1.1 |
| Enter, LSP             | Middle   |                  3.5 |                 3.5 |
| Enter, LSP             | Near EOF |                  0.9 |                 0.8 |
| Letters, local symbols | Middle   |                  1.2 |                 1.2 |
| Letters, local symbols | Near EOF |                  0.9 |                 0.7 |
| Enter, local symbols   | Middle   |                  3.0 |                 3.1 |
| Enter, local symbols   | Near EOF |                  0.7 |                 0.7 |

The principal result is less discarded work and fewer remote requests, not a demonstrated reduction in every keypress's latency. The maximum individual input remains approximately 17.5 ms. Scheduling delay is mixed: for local-symbol typing in the middle its p99 rises from 1.7 to 6.6 ms, while near EOF it falls from 6.1 to 4.2 ms. Wheel scheduling delay still reaches approximately 21 ms in both variants. Local-symbol typing still records a roughly 33 ms RAF interval. RAF timestamps are not physical display latency, and callback lag is reported separately by the harness.

Final syntax readiness remains approximately 190–220 ms after middle-of-file character input and approximately 54–77 ms in the other cases. The 600-character LSP cases send 599 wire completion requests before and 200 after. No 300 ms pause is established by these accepted input/scroll measurements.

A separate integration run overlays the changes on core `4d27487c37f47fbfda4baf557ed8660297b5bf85`, which includes the JavaScript fuzzy matcher. Two more processes perform another 2400 inputs with LSP. All result checks pass; letter-input p99 is 1.5 ms in the middle and 1.1 ms near EOF, and Enter p99 is 3.3 ms and 0.9 ms respectively. These are integration observations, not an isolated estimate of the fuzzy migration's effect.

## Publication investigation

The probes distinguish synchronous entry cost from promise latency. CPU samples additionally cover asynchronous symbol and breadcrumb work. With local symbols, sampled self time across the profile includes approximately 232 ms in hierarchy construction and 134 ms in breadcrumb-index preparation. These are accumulated samples across work on large symbol sets, not single blocking tasks. Existing cooperative scheduling and shared generation caches remain in place.

Presentation flush attempts occur frequently during typing but their aggregate synchronous cost is small in these profiles. The baseline LSP run spends roughly 5–10 ms in these entries over each 30-second typing sequence. This evidence does not justify another full publication-API rewrite or claiming that every consumer update fits a frame. No speculative publication-cache change is included.

## Worker ownership experiment

[syntax-worker-experiment.cjs](../benchmark/syntax-worker-experiment.cjs) runs the same isolated parser actor inline and in a Node worker in inline/worker/worker/inline order, with two openings per actor. Each actor owns a JavaScript document model and raw WASM trees. Initial text crosses the worker boundary once per opening; 120 subsequent edits transfer only revisioned UTF-16 deltas, totalling 120 inserted code units. Parsing uses cooperative 4 ms slices; copying, comparing and deleting trees remain synchronous inside the owner.

Every edited result is checked against an independent uninterrupted fresh parse, including a hash of the entire syntax-tree representation. Text hashes, revisions, extent and error state agree between variants. Full-tree serialization and the independent parse belong to a separately labelled validation phase and are excluded from the interaction comparison.

In the large-document experiment on Node 24.18.0, closing the inline owner delays an 8 ms heartbeat by 82–98 ms; the worker variant records approximately 8–11 ms. Windows timer granularity contributes to that floor. These are event-loop heartbeat delays, not display-frame times. Worker initialization belongs to the first open, while inline initialization is recorded in setup; opening times must not be compared without accounting for both.

The deletion itself still costs approximately 90–92 ms in either owner. Offloading moves that work rather than accelerating it. Tree copying takes only 0.02–0.21 ms here and does not independently justify a worker. Comparisons in this shorter 120-edit actor scenario take 0.84–1.78 ms; they do not reproduce the longer editor scenario's 17–25 ms comparison.

This is an ownership experiment, not a production editor worker. It does not implement the current renderer's synchronous Tree/Node/query APIs, the complete injection pipeline, or worker cancellation under concurrent document generations. It also does not measure a production worker's total memory overhead. A worker removes these tree operations from the renderer, but does not guarantee absence of all pauses; even the deliberately expensive validation phase has occasional host scheduling outliers.

The isolated result motivates testing a worker as the sole parser owner, with revisioned, serializable results for visible highlighting, folds and symbols. Consumers would request bounded results and retain a validated cache instead of receiving WASM node pointers. This remains an untested architecture, not an accepted implementation plan. Further worker testing was deferred after the integration experiment below.

## Withdrawn duplicate-parser integration

A subsequent Electron prototype added a worker-owned document and syntax tree while retaining the renderer's existing parser. Four fleet processes covered local symbols and LSP, each with the worker disabled and enabled, for 4800 character inputs across middle-of-file and near-EOF openings. Outline remained closed and the full 195778-symbol cache was populated. The prototype passed seven Node tests and 172 editor integration specs; bounded worker captures agreed with the renderer.

| Condition     | Position | Input p99 without worker, ms | Input p99 with worker, ms |
| ------------- | -------- | ---------------------------: | ------------------------: |
| Local symbols | Middle   |                          1.2 |                       1.2 |
| Local symbols | Near EOF |                          0.7 |                       0.8 |
| LSP           | Middle   |                          1.5 |                       1.6 |
| LSP           | Near EOF |                          1.1 |                       1.0 |

Worker readiness took approximately 1.82–1.94 seconds on opening. The observed process RSS decrease after closing worker sessions was approximately 302–317 MiB; GC and other process activity make this an estimate, not an isolated worker-allocation measurement. Each opening transferred the full text once, followed by 600 delta batches containing 600 inserted UTF-16 units. Final worker syntax readiness took approximately 126–129 ms after middle-of-file typing and 6–7 ms near EOF. There was only one process per condition, so small latency differences are not statistically established improvements.

The renderer still owned its original tree, so its expensive synchronous WASM operations remained. Duplicating the parser added memory and initialization cost without demonstrating an interaction benefit. The integration was therefore removed, including its runtime files and prototype-specific specs. The standalone benchmark above remains available as an optional experiment; it is not loaded by the editor.

The current editor parses on the renderer thread. Cooperative scheduling yields between parse slices but does not create a separate thread. A future sole-owner worker test must replace renderer tree ownership and account for synchronous consumers, injections, cancellation, initialization and memory. The rejected duplicate-parser result does not establish the performance of that different architecture.

## Validation

Implementation commits are `fc201a27` in core and `4d0726a` in IDE. They are local commits; this investigation does not push or repin packages.

The final test set passes 815 tests: 246 editor/IDE integration specs, 97 Node runtime tests and 472 autocomplete specs. Coverage includes large-buffer indentation and grouped undo, immediate text after a deferred newline, editor destruction while queued, synchronous overrides, root ranges, nested and combined injections, snapshot publication, request preparation and cancellation, completion cache reuse and manual/trigger-character bypass. The worker experiment additionally checks fresh-parse equivalence across reopening for the supplied large document and generated JavaScript with CRLF, accented identifiers and surrogate pairs.

Changed sources pass ESLint and formatting checks. Tests run locally on Windows with `CI` unset; this is not cross-platform CI evidence. No dependency pins are part of this change, and concurrent fuzzy work is preserved. CPU profiles, raw traces (stored in ZIP archives after cleanup), private-input configuration and detailed run output remain in local diagnostic storage. These are historical measurements; cleaning the diagnostic storage does not constitute a new performance run.

## Reproduction

Use [post-edit-refresh-benchmark-spec.js](../benchmark/post-edit-refresh-benchmark-spec.js) with isolated homes, frozen runtime sources and `CI` unset. `inputCount`, `inputInterval` and `idleMs` select sustained input; `diagnostic` enables [interaction-probe.js](../benchmark/interaction-probe.js). Leave `diagnostic` and CPU profiling off for latency comparisons. `requireSymbols` and `measureSyntaxSettlement` verify initialization and final syntax readiness. Input scheduling delay and RAF callback lag are recorded separately from command duration and RAF timestamp intervals.

Run the standalone worker experiment with `node benchmark/syntax-worker-experiment.cjs INPUT GRAMMAR_JSON OUTPUT`. Its output contains measurements and hashes, not document text. The input must never be used as the output path.
