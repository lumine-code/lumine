# Typing tails, syntax scheduling and repeated large-file lifecycles

Measurements on 2026-10-20 use isolated Electron windows on the local Windows workstation. [Raw timing samples, source hashes and validation](../benchmark/results/typing-tail-performance-2026-10-20.json) preserve the measured variants. The supplied SOFiSTiK file contents and original path are excluded.

## What caused the pause

A long run reproduced a roughly 230 ms input gap immediately after a major GC of about 5 ms. A second run with CPU sampling and Chrome task tracing identified 135.1 ms and 127.0 ms FinalizationRegistry cleanup tasks. The sampled stack was the upstream web-tree-sitter tree finalizer → ts_tree_delete → subtree/free work in WASM. This is evidence for the same class of pause as the earlier untraced 300 ms outlier; it does not retroactively identify that exact old event. Ordinary edit commands remained about 4–7 ms while these cleanup tasks ran between commands.

Splitting only the finalizer batch was insufficient: instrumented public Tree.delete calls still took 114–130 ms individually for a large retired tree. The accepted change therefore controls when collected trees are destroyed as well as yielding between jobs.

## Changes

Published trees have a managed owner retained by every returned node and cursor. Collection enqueues the raw tree for deletion through the public Tree API; the raw tree stays alive until that deletion unregisters its upstream finalizer. This preserves immutable older snapshots. Cleanup prefers 100 ms without TextBuffer edits, uses a 2 ms soft target between jobs, and makes progress above 2048 pending jobs even while edits continue. Consumed slots are compacted. The threshold counts jobs, not bytes, and a single native destructor remains uninterruptible. Cleanup can still delay the first interaction arriving after a quiet period or under pressure; this is not a hard real-time guarantee.

A separate large-file bottleneck appeared in the JavaScript and Python scenarios. Standalone parsing without packages reproduced the high cost: approximately 46 ms parse plus 18 ms changed-range comparison for the JS fixture, and 75 plus 14 ms for Python, where that mutation produces temporarily invalid syntax. The final policy observes foreground syntax updates in buffers of at least 512 Ki UTF-16 units. After two consecutive updates above 12 ms it uses the existing resumable asynchronous path. Fast grammars and small buffers retain synchronous updates. The first two slow updates still pay their foreground cost. Syntax consumers use whenGrammarSettled; pending presentation reuses shifted cached scopes. Parser progress callbacks do not make changed-range comparison or query execution interruptible.

Deferred newline hints now register a transaction-level correction: a rapid burst can invalidate every individual hint, but the latest complete syntax still supplies one row plan. Tests verify indentation, grouped undo and cancelling correction after immediate undo. The line-ending tile also compares values before replacing its DOM text or emitting did-change, eliminating repeated work for unchanged LF/CRLF status. A regression checks 1000 identical updates produce only one change and preserve the text node.

## Repeated SOFiSTiK lifecycles: disposal change

Each process opens the 8,400,039-byte, 195,789-row document six times, alternating middle, near-end and EOF positions. Each cycle issues 300 commands at 16.667 ms intervals, first letters with word boundaries, then Enter, and undoes the series before closing. Thirty packages are active. Processes run before/after/after/before. This round measures managed disposal and the tile change before the later adaptive parser policy.

| Run | Variant | Command median ms | Command p95 ms | Maximum frame gap after first cycle ms | Peak sampled RSS MiB | Last sampled RSS MiB |
|---|---|---:|---:|---:|---:|---:|
| 1 | before | 5.10 | 6.90 | 116.70 | 1055.20 | 1051.24 |
| 2 | after | 5.40 | 7.20 | 16.80 | 1057.00 | 1057.00 |
| 3 | after | 5.30 | 7.10 | 16.80 | 1125.55 | 1125.55 |
| 4 | before | 4.70 | 6.70 | 183.30 | 1043.92 | 1043.92 |

RSS includes reserved WASM memory and process overhead; it is not the live text-model heap or a leak measurement by itself. Samples occur after each typing period. The initial cold interaction remains in raw samples and can exceed a frame.

Ordinary command medians in this short round were slightly higher with managed disposal (5.3–5.4 ms versus 4.7–5.1 ms). The mixed-fleet SOFiSTiK control below is 6.2 versus 6.0 ms, while the continuous final-only control is 4.9 ms. These runs establish the tail improvement, not an improvement to every hot command or a precise constant overhead. An isolated owner-access probe found a delegated prototype offered little benefit over the transparent proxy, so the implementation retains the simpler proxy ownership contract.

## Mixed files with 37 packages: final implementation

Six cycles alternate the supplied SOFiSTiK file, a generated JavaScript file with 30000 exported functions and Unicode strings, and a generated CRLF Python file with 24000 assignments and Unicode strings. Each cycle issues 120 commands at 16.667 ms intervals and closes the modified in-memory buffer without undo or saving. Added packages are indent-guide, tabs, symbol, symbol-tree-sitter, outline-view, linter and linter-todo. Activation does not exercise every optional command or guarantee that an outline panel is visible. The two before and two after processes are ordered ABBA. Statistics below pool the same number of samples per variant and grammar.

| Grammar | Variant | Command median ms | Command p95 ms | Frame-gap p95 ms | Deferred cases |
|---|---|---:|---:|---:|---:|
| source.sofistik | before | 6.00 | 8.60 | 16.80 | 0/4 |
| source.sofistik | after | 6.20 | 8.00 | 16.80 | 0/4 |
| source.js | before | 69.20 | 89.70 | 83.40 | 0/4 |
| source.js | after | 1.60 | 3.70 | 16.80 | 4/4 |
| source.python | before | 99.50 | 123.70 | 116.70 | 0/4 |
| source.python | after | 0.70 | 1.00 | 16.80 | 4/4 |

The JS/Python improvement is foreground responsiveness, not a corresponding speedup in total parsing throughput. Two initial slow calls, native range comparison, queries and initial module preparation can still create long frames. New revisions cancel obsolete work and the benchmark waits for grammar settlement before closing each case.

## Continuous input control

The final implementation receives two 3600-command, approximately one-minute streams at 60 commands per second with the original 30 packages. This is a final-only endurance control, not another before/after ratio.

| Cycle | Median command ms | p95 command ms | Maximum frame gap ms | Maximum backlog ms | Sampled RSS MiB |
|---|---:|---:|---:|---:|---:|
| 0 | 4.90 | 5.70 | 33.30 | 34.63 | 1461.14 |
| 1 | 4.90 | 5.60 | 16.80 | 8.75 | 1645.93 |

## Correctness and limits

The broad regression ran 1983 core specs and 118 Node tests, plus the package suites below, with no failures. Eleven focused syntax/history/renderer specs cover the final deferred-indentation correction and browser timer binding; these overlap the broad suite and are not added to its count. Forced-GC subprocess tests also ran under Electron. They retain old nodes and cursors after parser close, exercise queries, release owners and verify every expected tree is disposed.

ESLint and the focused formatting checks pass. Dependency pins and lockfiles are unchanged; no dependency audit or cross-platform CI run was performed for this local source change. The committed lifecycle benchmark also completed a direct smoke run against the supplied file.

| Suite | Tests | Failures |
|---|---:|---:|
| node | 118 | 0 |
| core | 1983 | 0 |
| autocomplete | 455 | 0 |
| bracket-matcher | 215 | 0 |
| language-javascript | 35 | 0 |
| language-python | 44 | 0 |
| line-ending | 60 | 0 |
| symbol-tree-sitter | 55 | 0 |
| outline-view | 86 | 0 |
| indent-guide | 28 | 0 |
| language-sofistik | 86 | 0 |

All accepted timing runs are serialized without correctness suites or CPU profiling in parallel. Chrome traces and profiles are diagnostic evidence only. Command duration includes synchronous editor/package work; frame timestamps measure renderer scheduling, not physical display presentation. Timer-driven API commands exercise the editor insertion path rather than OS keyboard dispatch. Grammar readiness, initial scrolling, undo, output serialization and close are outside command durations. Frame recording extends through settlement and a short tail, but a callback arriving after the recording stops is not counted. The original file is never saved and its hash is verified.

The committed [lifecycle benchmark](../benchmark/typing-lifecycle-benchmark-spec.js) accepts LUMINE_TYPING_LIFECYCLE_CONFIG with out, files, packages, cycles, count, interval and undo, using an isolated LUMINE_HOME. Frozen source trees, full diagnostic traces and orchestration remain in .dev/typing-tail-20261020. These results apply to this workstation and these workloads; they are not a new native-versus-JS comparison or cross-platform evidence.
