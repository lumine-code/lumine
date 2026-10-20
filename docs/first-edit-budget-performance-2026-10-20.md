# Syntax budgets from the first large-buffer edit

This follow-up to [comparison ownership](parser-comparison-performance-2026-10-20.md) replaces the two-full-update observation period with a bounded foreground attempt from the first edit of a large buffer. The baseline is the preceding committed JS model; this is not a native-versus-JS comparison.

## Implementation

Buffers of at least 512 Ki UTF-16 units use a shared 8 ms foreground parse allowance. Initial loading retains its 5 ms allowance and asynchronous parser slices retain their 4 ms allowance. Ready fast work still publishes synchronously. A foreground attempt that cannot finish retains its parser lease, immutable input, edit list and native job for scheduled continuation. The lease returns to the pool only after completion or cancellation. Cancellation while queued explicitly resets the pending job before releasing the parser.

If native parsing completes after a slice deadline, the raw unpublished result waits for another slice before comparison/publication. It is not parsed again. Cancellation, replacement and close delete both the private old tree and a staged result. Bounded in-transaction indentation queries now respect the allowance before the mode has been classified as slow; on exhaustion they discard that private attempt and use deferred indentation correction. Explicit forced synchronous parsing remains available. Subsequent large-buffer updates use the existing asynchronous/coalescing policy after exhaustion, or after one foreground update exceeding 12 ms because of non-interruptible work. Small buffers retain the existing synchronous policy.

The budget is cooperative. It cannot preempt a native comparison, query, destructor or lexer action already executing, nor package initialization, module loading, layout or GC. An 8 ms parsing allowance is not an 8 ms limit for the entire editor command or a guarantee of 16.7 ms frames. `editTimeoutMicros` provides an internal override; an explicitly supplied constructor `syncTimeoutMicros` remains a fallback override for both allowances.

[Raw samples, source hashes and validation](../benchmark/results/first-edit-budget-performance-2026-10-20.json) preserve the measured variants.

## Method

Baseline commit `5803e98acd8df3c0061339b0820117103925f51d` is compared with candidate `242d022dacefab536dc937bb676adf86e2f7c267`. Frozen baseline/candidate sources share installed dependencies and activate the same 37 workspace packages. Each timing round uses separate before/after/after/before processes, with source hashes verified before and after every process. Package sources are unchanged; optional features are not all exercised. Correctness tests finish before the accepted timings; no profiling, forced GC or test suites run alongside those timings.

The first-edit round opens three files: generated JS with 30000 exported functions, generated CRLF Python with 24000 assignments, and the supplied SOFiSTiK file (8,400,039 bytes, 195,789 lines). It tests the middle and a position 100 rows before EOF, with the cursor at column zero. Each position receives either 60 letter/space commands or 60 Enter commands at 60/s in a freshly opened editor. All cases verify that the mode is initially synchronous. The case order is fixed: JS, Python, SOFiSTiK; middle letter, middle Enter, end letter, end Enter. The first JS letter case is therefore also the first completion request in each process. Location and cold-start costs are not independently randomized.

Initial grammar readiness and scrolling finish before a 500 ms wait. Command timing covers synchronous editor/package work. Frame recording begins around the scheduled first input and includes two frames after grammar/indentation settlement. The initial-frame window is the first 250 ms from scheduling, so it can include queued UI work before the first command executes. These are requestAnimationFrame timestamps, not physical presentation. Long-task entries and raw event timestamps are retained. This is timer-driven editor API input, not OS keyboard dispatch.

A separate ordinary-typing round gives each file 240 mixed commands at 60/s and 120 at 8/s, near EOF. It includes spaces and an Enter every sixtieth command. Renderer CPU is process user plus system time through grammar settlement, including UI, packages and other renderer threads. This round uses the existing cadence benchmark, whose frame recording ends at settlement; frame definitions therefore differ from the first-edit round and are compared only within each round. Every final tree matches the latest input/revision; input, final text and named syntax-tree hashes agree across variants. Files are never saved, and private contents/path are excluded.

Two processes per variant provide local observations, not confidence intervals. First-edit tables show both results as ranges. Frozen sources, orchestration and diagnostic profiles remain in `.dev/first-edit-budget-20261020`.

## Results

### First command and initial frames

The first-command columns show the two process results as ranges. Frame columns show the worst gap in the first 250 ms across those two cases; this includes pre-input queueing.

| Grammar  | Position / input | First command ms before → after | Worst initial frame gap ms before → after |
| -------- | ---------------- | ------------------------------: | ----------------------------------------: |
| js       | middle / letter  |         100.1–105.3 → 38.5–44.1 |                              133.3 → 83.2 |
| js       | middle / enter   |           65.7–77.0 → 10.9–12.5 |                               83.2 → 16.8 |
| js       | end / letter     |           69.7–70.5 → 10.1–11.2 |                               83.3 → 16.8 |
| js       | end / enter      |            65.2–67.7 → 9.9–10.9 |                               66.7 → 16.8 |
| python   | middle / letter  |             91.4–98.4 → 9.2–9.3 |                              200.0 → 83.3 |
| python   | middle / enter   |            93.0–115.8 → 9.2–9.3 |                              199.9 → 50.0 |
| python   | end / letter     |            92.4–102.7 → 8.9–9.2 |                              183.4 → 66.7 |
| python   | end / enter      |             92.3–92.4 → 9.1–9.4 |                              183.4 → 66.6 |
| sofistik | middle / letter  |           117.8–119.0 → 9.3–9.5 |                              116.6 → 16.7 |
| sofistik | middle / enter   |              6.7–7.2 → 7.9–10.5 |                               16.8 → 16.8 |
| sofistik | end / letter     |               5.9–7.4 → 5.4–8.6 |                               16.8 → 16.8 |
| sofistik | end / enter      |              6.2–7.8 → 6.8–10.4 |                               16.7 → 16.8 |

### End-of-burst tradeoff

Each row pools middle/end cases from both processes. Settlement follows the last of 60 commands.

| Grammar / input   | Settlement range ms before → after | Cases finishing synchronous before → after |
| ----------------- | ---------------------------------: | -----------------------------------------: |
| js / letter       |          123.6–133.8 → 137.9–156.0 |                                  0/4 → 0/4 |
| js / enter        |          132.7–147.7 → 132.0–177.1 |                                  0/4 → 0/4 |
| python / letter   |          137.2–151.7 → 153.5–278.5 |                                  0/4 → 0/4 |
| python / enter    |          144.7–191.6 → 157.5–189.3 |                                  0/4 → 0/4 |
| sofistik / letter |                0.0–0.1 → 0.0–220.9 |                                  4/4 → 1/4 |
| sofistik / enter  |                  0.0–0.1 → 0.0–0.1 |                                  4/4 → 4/4 |

Some SOFiSTiK letter cases now defer syntax rather than blocking input. In the middle, first input improves from 118–119 ms to about 9 ms, but final syntax follows the last key by 185–221 ms instead of being synchronous. Near EOF, one candidate letter case stays synchronous and one settles about 55 ms after the burst. All four SOFiSTiK Enter cases remain synchronous. This is a responsiveness/freshness tradeoff, not a claim of lower latency for every consumer.

### Ordinary typing with the fleet

CPU columns are arithmetic means of two processes; command and frame statistics pool equally sized samples.

| Grammar  | Commands / rate | Renderer CPU ms before → after | CPU change | Command median ms before → after | Command p95 ms before → after | Max frame gap ms before → after |
| -------- | --------------: | -----------------------------: | ---------: | -------------------------------: | ----------------------------: | ------------------------------: |
| js       |      240 / 60/s |                    3368 → 3344 |      -0.7% |                        0.9 → 0.9 |                     1.6 → 1.6 |                    150.0 → 83.3 |
| js       |       120 / 8/s |                  14548 → 14891 |       2.4% |                        2.5 → 1.0 |                     3.5 → 1.3 |                     83.3 → 33.4 |
| python   |      240 / 60/s |                    2766 → 2797 |       1.1% |                        0.7 → 0.8 |                     2.6 → 3.2 |                    216.6 → 83.4 |
| python   |       120 / 8/s |                  15203 → 15289 |       0.6% |                        0.7 → 0.7 |                     1.1 → 1.0 |                    250.0 → 83.3 |
| sofistik |      240 / 60/s |                    4086 → 2586 |     -36.7% |                        6.6 → 0.7 |                     7.9 → 6.4 |                     16.8 → 16.8 |
| sofistik |       120 / 8/s |                    3672 → 2946 |     -19.8% |                        6.2 → 5.4 |                     9.1 → 8.2 |                   166.7 → 150.0 |

JS/Python renderer CPU is approximately unchanged in this round (within about −1% to +3%). The first-command tails drop sharply, while steady command percentiles are broadly similar or better; Python at 60/s has a p95 increase from 2.6 to 3.2 ms. SOFiSTiK at 60/s spends less CPU after switching to coalesced updates, but settles 62–64 ms after the burst instead of synchronously. Frame maxima improve in these runs, but remain above a frame in several cases; this is not a hard real-time result.

## Diagnostics and remaining costs

A separate CPU/Chrome trace of the 8 ms candidate's first JS command showed synchronous module resolution, Babel analysis/cache I/O and construction of autocomplete's SubsequenceProvider in addition to the bounded WASM work. The provider is lazy and initializes during its first suggestion request. No autocomplete source changed in this task. These profiled timings are diagnostic and excluded from the accepted ABBA comparison.

An instrumented early probe also recorded a Python command that did not start until approximately 41 ms after it was scheduled; its parse step was 5 ms, while the initial frame gap was about 50 ms. That probe used the rejected 5 ms edit allowance and is not a final performance result. It demonstrates why an initial frame gap must not automatically be attributed to the first parser call. The 5 ms edit policy was replaced with 8 ms after it unnecessarily deferred fast SOFiSTiK cases in the pilot.

## Validation and limits

The final regression passes node (129), core (542), autocomplete (455), bracket-matcher (215), language-javascript (35), language-python (44), line-ending (60), symbol-tree-sitter (55), outline-view (86), indent-guide (28), language-sofistik (86), all with zero failures. The 22 focused parser tests and 18 focused renderer/teardown tests overlap those counts. Tests cover first-edit interruption and same-job resumption, first-newline indentation/Undo, parser leasing and queued cancellation, staged-result reuse without a second native parse, disposal on abort/replacement/close, and the existing grammar/injection/history regressions. ESLint, formatting and whitespace checks pass. Dependency pins and lockfiles are unchanged.

The first syntax update no longer deliberately spends two complete foreground parses to decide policy. Remaining pauses can still come from cold completion initialization, queued UI work, native comparison/query/destruction and other uninterruptible work. The existing error-recovery safety fallback and bounded healthy checkpoint remain unchanged. Private indentation attempts are bounded but are not transferred into committed parser jobs; avoiding their repeated work is a separate possible optimization. No cross-platform CI or new long-term heap residency test is claimed for these local measurements.
