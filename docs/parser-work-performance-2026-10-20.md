# Parser work during repeated input and large-buffer lifetimes

This follow-up to [typing-tail measurements](typing-tail-performance-2026-10-20.md) measures cancelled parser work and memory after repeated opens. It compares baseline core `44d783ec71ff148277f2a6e9db22da3035bbf911` with scheduling change `45c9a91cf412d5be02c9378767067813761f2168`. It is not a new native-versus-JavaScript comparison. [Results and source fingerprints](../benchmark/results/parser-work-performance-2026-10-20.json) separate instrumented diagnostics from ordinary timing runs.

## Change

An already-slow large root waits for a 50 ms quiet period when consecutive edits arrive less than 50 ms apart. This happens before capturing the document snapshot, assembling its edit journal or acquiring a parser. Aborted waits remove their timer and listener; a revision check rejects stale submitted ranges. The first edit after a pause starts immediately. The existing size threshold, observation of two expensive synchronous updates, parser slice budget, injection behavior and tree disposal policy are unchanged.

This reduces work that would otherwise be cancelled by the next key. It deliberately delays fresh syntax during a rapid burst. The delay is not a bound on final grammar settlement: the parse, changed-range comparison, presentation and indentation still have to finish. Consumers requiring current syntax continue to await `editor.whenGrammarSettled()`.

## Method

All runs use isolated Electron windows on the same Windows workstation, with 37 packages activated from the working fleet. That includes autocomplete, bracket matching, indentation guides, symbols, outline and linter providers. Activation does not exercise every optional feature or imply that every panel is visible. Core sources are frozen separately for the baseline and candidate; dependencies are shared. No package source was intentionally changed during measurements, but a pre-run whole-fleet content fingerprint was not captured.

The lifecycle diagnostic alternates the supplied SOFiSTiK document (8,400,039 bytes and 195,789 lines), generated JavaScript with 30000 exported functions, and generated CRLF Python with 24000 assignments. Generated strings contain Unicode. Each open receives 1800 commands at 16.667 ms intervals near the end of the file, with spaces every twelfth event and Enter every sixtieth. It waits for grammar settlement, idles five seconds, closes the modified buffer without saving, then idles five more seconds. Baseline runs 12 cycles; candidate runs 18, with only its first 12 used for the matched comparison. There is no undo in this diagnostic.

Instrumentation records parser jobs, synchronous elapsed time inside parser steps, public tree deletion calls, WASM memory growth, weak references to published root trees and disposal queue length. Parser-step elapsed time is not OS CPU usage and excludes snapshot capture, parser begin preparation and cancellation cleanup outside the step. Weak references do not count every internal native allocation. Four forced collections run only after all natural input/open/close cycles; these diagnose retention and are not part of normal typing performance. Full local diagnostics remain under `.dev/parser-work-20261020`; the committed data retains per-cycle aggregates, memory samples and disposal/growth events.

The separate timing comparison runs before/after/after/before, without parser instrumentation or forced collection. Each process tests JS and Python at 60, 30 and 8 commands per second, with 240, 120 and 24 commands respectively. It records command duration, requestAnimationFrame gaps, scheduled-input backlog, time from the last input to grammar settlement, and renderer-process user plus system CPU through settlement. Process CPU includes package/UI work and other renderer threads; it is not whole-application CPU. Text and syntax-tree hashes must agree across all four processes. AST stringification and hashing happen after timing stops.

Accepted measurements run serially without correctness suites or profilers alongside them. Initial grammar readiness, scrolling, output serialization and closing are outside measured input intervals. Timer-driven API calls exercise editor insertion rather than OS keyboard dispatch. Frame timestamps describe renderer scheduling rather than physical presentation, and a callback arriving after settlement is not recorded. Original file hashes are checked and no input file is saved; the private document's contents and path are excluded.

## Results

### Parser work in the matched first 12 lifecycle cycles

Each grammar receives four separate 1800-command streams. These are diagnostic step timings, not the ordinary CPU benchmark below.

| Grammar    | Started jobs before → after | Cancelled jobs before → after | Total parser-step elapsed ms before → after | Final settlement range ms before → after |
| ---------- | --------------------------: | ----------------------------: | ------------------------------------------: | ---------------------------------------: |
| SOFiSTiK   |                 7200 → 7200 |                         0 → 0 |                               33601 → 33922 |                            0–0.1 → 0–0.1 |
| JavaScript |                   7200 → 16 |                      7188 → 4 |                                40563 → 1979 |                        704–882 → 783–889 |
| Python     |                   7200 → 16 |                      7188 → 4 |                                45551 → 1574 |                        278–349 → 282–392 |

JS and Python each start four jobs per 1800-command stream instead of 1800, with three completing and one cancelled. Total time inside parser steps falls by 95.1% for JS and 96.5% for Python in this diagnostic. SOFiSTiK remains synchronous and does not use the coalescing delay. The final parse still costs time: this result is a reduction of discarded work, not elimination of settlement latency.

### CPU and responsiveness by input cadence

CPU columns are arithmetic means of two processes per variant. Command and backlog percentiles pool equal-sized samples. Settlement columns show both process results as a range. Two repetitions estimate this workload, not a confidence interval.

| Grammar    | Commands/s | Renderer CPU ms before → after | CPU change | Command p95 ms before → after | Backlog p95 ms before → after | Settlement ms before → after |
| ---------- | ---------: | -----------------------------: | ---------: | ----------------------------: | ----------------------------: | ---------------------------: |
| JavaScript |         60 |                    5571 → 4406 |     -20.9% |                     3.6 → 5.2 |                 541.7 → 163.9 |            536–544 → 592–878 |
| JavaScript |         30 |                    4477 → 2008 |     -55.1% |                     3.1 → 2.5 |                   10.1 → 19.4 |             78–112 → 132–172 |
| JavaScript |          8 |                    2703 → 2579 |      -4.6% |                   73.5 → 68.2 |                    34.9 → 8.9 |               79–102 → 76–80 |
| Python     |         60 |                    5344 → 2493 |     -53.4% |                     1.4 → 2.4 |                 641.3 → 214.3 |            306–467 → 272–273 |
| Python     |         30 |                    4367 → 1524 |     -65.1% |                     1.0 → 0.8 |                 216.8 → 136.5 |            102–194 → 150–174 |
| Python     |          8 |                    2789 → 2891 |       3.6% |                   92.9 → 90.3 |                  168.2 → 91.3 |              91–148 → 95–103 |

At 60/s, JS command median increases from 1.7 to 2.6 ms and p95 from 3.6 to 5.2 ms; Python command p95 increases from 1.4 to 2.4 ms. The change is therefore not a speedup of every foreground operation. Renderer CPU and scheduled-input backlog improve substantially in those cases. At 30/s, JS backlog p95 rises from 10.1 to 19.4 ms despite lower CPU. Final JS settlement is slower in both rapid cadences. The 8/s control has overlapping CPU ranges (and a 3.6% higher Python mean); no meaningful isolated-edit CPU improvement is claimed.

Frame-gap p95 stays about 16.7–16.8 ms, but maxima remain much larger. At 60/s, the pooled maximum is 200.1 → 166.5 ms for JS and 300.0 → 183.3 ms for Python. These include the initial expensive observations and other uninterrupted work. This round supports reduced wasted work and lower rapid-input backlog, not a strict frame-time guarantee. All input, final text and named syntax-tree hashes agree across ABBA runs.

### Memory and lifetimes

The baseline runs 21600 commands over 12 cycles; the candidate extends this to 32400 commands over 18 cycles. In both processes, observed WASM capacity grows during the first SOFiSTiK stream to 879 MiB and then stays at that capacity through subsequent opens. The first stream queues 1402 disposals before idle in the baseline and 1750 in the candidate; the following idle sample is empty. Later SOFiSTiK streams also drain before the sampled close. Published-root observations reach 7236 before and 10854 after; following final forced collection, no observed published root remains and the disposal queue is empty in either run.

Final sampled RSS is 1269 MiB before and 1290 MiB after, with JS heap used approximately 104 and 122 MiB respectively. Peak sampled RSS across these differently sized runs is 1950 and 1763 MiB; these are descriptive observations, not a controlled claim of reduced memory. RSS includes memory retained for reuse, packages and runtime overhead. WASM capacity is neither live allocator bytes nor proof that all those bytes are physically resident. The result does not show accumulating closed published trees in this workload, but does not prove every package and allocation is leak-free.

The instrumented runs still observe individual public tree deletions up to 160 ms before and 198 ms after, largely moved to idle by the pre-existing disposal policy. That limitation is unchanged. Initial expensive JS/Python updates also remain: observed maximum frame gaps reach roughly 233 ms before and 250 ms after in these diagnostics. Coalescing does not prevent the two initial synchronous observations or make every native operation interruptible.

## Correctness

The broad run passed 1984 core specs and 118 Node tests, plus autocomplete (455), bracket-matcher (215), language-javascript (35), language-python (44), line-ending (60), symbol-tree-sitter (55), outline-view (86), indent-guide (28) and language-sofistik (86). A final focused run passed 11 specs, overlapping the broad suite, including one additional cancellation/revision test. Coverage includes immediate isolated edits, rapid edits without premature parser acquisition, cancelled or superseded waits without document capture, final revision/input, deferred indentation, grouped undo and destruction during pending work.

ESLint, focused formatting checks and whitespace validation pass. Dependency pins and lockfiles are unchanged.

## Reproduction and remaining work

The [cadence benchmark](../benchmark/parser-cadence-benchmark-spec.js) accepts `LUMINE_PARSER_CADENCE_CONFIG` with `out`, `files` and `packages`; invoke it through the editor's isolated test runner with an isolated `LUMINE_HOME` and the desired `LUMINE_RESOURCE_PATH`. Files must be large enough and use sufficiently expensive edits to activate the adaptive policy. The committed benchmark itself ran in all four accepted cadence processes. The local orchestration retains the frozen sources and exact fixture generation from the preceding typing-tail work.

The 128-edit threshold for falling back to a fresh parse is unchanged. Long streams can therefore finish with a full parse even when most edits are adjacent. Composing compatible journal changes before applying that policy is a separate candidate for reducing settlement latency, with correctness checks needed for multiline edits, Unicode, undo and injection boundaries. Individual native changed-range comparisons and tree destructors remain uninterruptible. These measurements do not establish a universal absence of leaks or guarantee every frame stays within 16.7 ms.
