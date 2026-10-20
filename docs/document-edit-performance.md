# Production document edit measurements

Historical measurements. Native comparison tooling and prototype patches were retired on 2026-10-21; commands and source paths below describe the recorded checkout, not the current one. See [current model validation and benchmarks](javascript-document-core.md#validation-and-performance).

The production implementation follows the [document edit contract](document-edit-contract.md). The October 18 comparison uses editor `42a44283eacde1ddad540699547169bb831e5391` and Superstring `809c57b536eca226a6cb9433bc75e07a39462574`, against editor `fddfdf74fd942f2a8117f8b7237311981261d50c` and Superstring `14f39ee40d749f37d2b554f026e974fa43d07f98`. The earlier [ownership experiment](shared-edit-performance.md) remains a separate historical result.

## Method

All runs use Windows x64 on an Intel Core i9-10900K, Node 24.18.0 and Electron 44.9.0. Both native addons are local Release builds; the production addon is the binary installed through the editor's pinned dependency. Frozen editor sources and explicit addon overrides prevent accidentally comparing two copies of the same implementation. Source, driver and binary hashes accompany the [raw samples](../benchmark/results/document-edit-production-2026-10-18.json).

Each workload runs serially in eight fresh processes, four per variant, in baseline/production/production/baseline/production/baseline/baseline/production order. Model and interaction workloads use nine samples after three warmups per process; renderer workloads use fifteen after three, giving sixty renderer samples per variant. Setup and explicit garbage collection are outside model timings. Memory scenarios have four fresh processes per variant. Median-ratio intervals resample the four process clusters 3000 times; the small number of independent processes limits their precision.

The model driver is `benchmark/editor-superstring-benchmark.js`, with `--samples 9 --warmups 3 --units 128,1000000,8000000 --gc-after-setup --filter '^(buffer|editor-model)/'`, and explicit `--source`, `--binding` and `--output` arguments. The interaction and memory scenarios match the earlier ownership experiment. Renderer results pair the command with its subsequent synchronous component update; they include DOM/layout work but exclude physical frame presentation, clipboard IPC and syntax parsing.

## Results

Times are milliseconds. The renderer pastes 1 Mi UTF-16 units of multiline text into an existing document.

| Workload                                             | Baseline median / p95 | Production median / p95 |
| ---------------------------------------------------- | --------------------: | ----------------------: |
| Renderer paste + component update                    |           38.9 / 53.6 |             35.7 / 44.8 |
| Renderer undo + component update                     |            6.5 / 12.6 |              5.2 / 11.3 |
| Renderer redo + component update                     |           36.6 / 46.3 |             33.7 / 42.8 |
| Editor model, flat 8M insertion                      |       69.448 / 89.156 |         50.213 / 71.811 |
| Editor model, multiline 8M redo                      |     439.497 / 621.913 |       546.259 / 596.295 |
| Editor model, individual key in loaded 1M document   |         0.129 / 0.206 |           0.144 / 0.205 |
| Editor model, individual key after whole replacement |         0.125 / 0.256 |           0.140 / 0.258 |

Renderer median ratios have intervals of 0.879–0.961 for paste, 0.708–0.902 for undo and 0.875–0.950 for redo. Flat 8M insertion has an interval of 0.623–0.831. These workloads support a repeatable improvement. Ordinary loaded-editor typing has a small measurable increase: approximately 15 microseconds per key, with essentially unchanged p95. Buffer-only typing also becomes slightly slower. Prepared-handle ownership and the stronger contract are not free for tiny edits.

Multiline 8M redo has a worse pooled median, retained explicitly in the table. Its process-cluster interval is 0.947–1.379, and process timings vary substantially in both variants; the result does not establish a repeatable improvement or slowdown. The implementation does not solve large multiline display-layer costs. No claim that every operation is faster follows from these measurements.

For twelve independently edited buffers, median retained RSS growth falls from 61.7 MiB to 32.7 MiB. For forty edits in one retained history, growth remains approximately 23.8 MiB versus 24.2 MiB. RSS is allocator/process evidence, not a native live-allocation counter; sharing reduces some retained payloads without guaranteeing a reduction in every history workload.

## Held Enter investigation

A separate private diagnostic reproduced severe input queuing with one hundred cursor-history positions and repeated Enter at the beginning of an IPython document. The same unmodified cursor-history package reproduced the problem on both baseline and production core: the maximum queue delay was approximately twenty-one seconds in each run. Appending at the end did not move those positions and remained responsive. Private source text and paths are excluded from the repository and the synthetic benchmark results above.

The cause was cursor-history persisting the entire collection from every moved-marker callback. A package correction collects final positions once per applied document batch, while keeping explicit marker moves immediate. This also avoids persisting mixtures of old and new positions. The corrected run delivered 120 key events without a growing backlog, with a 10 ms median and matching live/persisted history positions. Startup/JIT long tasks remain in the raw private diagnostic, so this is not a claim that every frame meets a monitor deadline. The fault originated in cursor-history's workspace-persistence change, rather than the prepared native edit implementation.

## Validation

The native implementation passed 159 Node specs and 62 native test cases, with ownership, lifecycle, worker teardown, CRLF and unpaired UTF-16 coverage. [Native CI](https://github.com/lumine-code/superstring/actions/runs/39073667134) and [CodeQL](https://github.com/lumine-code/superstring/actions/runs/39073667322) passed on Windows, macOS and Linux. [Editor CI](https://github.com/lumine-code/lumine/actions/runs/39075164207) passed on all three platforms. Focused local checks also cover exact reload offsets, history snapshots and parser input. All benchmark processes passed their text/history/selection checks; renderer runs additionally checked the resulting DOM.
