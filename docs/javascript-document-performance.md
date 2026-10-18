# JavaScript versus native document performance

Local Windows comparison from 2026-10-19. This is the first integrated JavaScript candidate, measured before the later fleet/API optimization pass; the reference is the native editor at `b05b9769ed1402ca04135a9b6258949a9185e626`. The [raw report](../benchmark/results/javascript-document-integration-2026-10-19.json) contains source/driver/dependency hashes, every process and every measured sample. The candidate was uncommitted at measurement time; its source fingerprint identifies it.

## Method

Both implementations ran serially on Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz, win32 x64, Electron 44.9.0 with embedded Node 24.22.0; the separate model processes used Node v24.18.0. Four fresh renderer processes and four fresh model processes per implementation used three warmups and nine samples for each case. Order alternated native/JS then JS/native. Tables use the conventional median of four process medians; all units below are milliseconds unless stated otherwise.

Inputs, text results, restored selections/markers, syntax signatures and screen-line counts were checked. Both sides used identical benchmark scripts, the same installed dependencies and WASM grammars, isolated homes and frozen source copies. The runtime check confirmed Superstring loaded only on the native side. No other test or benchmark started by this task ran concurrently with this final series.

## Findings

The migration removes full-string parser snapshots from ordinary edits. At 128 million UTF-16 units, editing plus snapshot capture takes 0.214 ms versus 86.885 ms for the reference. Retaining 21 eight-million-unit versions adds about 0.101 MiB of JS heap versus 305.203 MiB; these are incremental retained-memory measurements, not total editor memory. The advantage comes from shared immutable roots, not proof that JavaScript executes text operations faster than C++. A native implementation with shared snapshots could remove the same copying cost.

Ordinary edits with 10000 markers are comparable, while undo/redo in those cases is about three times faster. A million-unit single line is about 5% slower. The 1000-cursor edit is 93.65 ms versus 84.60 ms; one-million-unit paste is 101.75 ms versus 66.55 ms. JavaScript syntax settlement and IPython editing remain broadly comparable.

Creation of a 128-million-unit buffer is 202.77 ms versus 178.52 ms. Dense regex search is 66.90 ms versus 56.06 ms at eight million units. Fuzzy duplicate-word search is 10.45 ms versus 2.71 ms and the unique-word case is 16.68 ms versus 10.50 ms; skipping an oversized word is faster in JS. These remain optimization targets. The results support the coherent JS storage architecture and its snapshot gains, but do not support claiming a universal performance win.

## Commands through DOM/layout completion

These timings include the actual editor command, grammar settlement and an explicit component update. They exclude fixture setup, verification, OS clipboard IPC and physical frame presentation. A million units means a million UTF-16 code units, not a million bytes.

| Scenario             | Operation | Native |     JS | JS/native | JS process medians            |
| -------------------- | --------- | -----: | -----: | --------: | ----------------------------- |
| plain-1m-markers     | edit      |   1.15 |   1.10 |     0.96× | 1.10, 1.00, 1.20, 1.10        |
| plain-1m-markers     | undo      |  20.50 |   6.80 |     0.33× | 6.80, 6.80, 6.90, 6.80        |
| plain-1m-markers     | redo      |  20.00 |   6.80 |     0.34× | 6.80, 6.90, 6.80, 6.80        |
| plain-8m-markers     | edit      |   1.40 |   1.15 |     0.82× | 1.30, 1.20, 1.10, 1.10        |
| plain-8m-markers     | undo      |  22.90 |   7.85 |     0.34× | 8.00, 7.90, 7.80, 6.90        |
| plain-8m-markers     | redo      |  21.95 |   7.50 |     0.34× | 7.80, 7.60, 7.40, 6.70        |
| plain-32m-markers    | edit      |   1.20 |   1.10 |     0.92× | 1.30, 1.10, 1.10, 1.10        |
| plain-32m-markers    | undo      |  21.85 |   7.25 |     0.33× | 7.50, 7.00, 7.60, 6.80        |
| plain-32m-markers    | redo      |  21.20 |   7.10 |     0.33× | 7.30, 6.90, 7.40, 6.90        |
| soft-wrap-long-lines | edit      |   2.70 |   2.60 |     0.96× | 2.70, 2.50, 4.10, 2.50        |
| soft-wrap-long-lines | undo      |   4.50 |   3.35 |     0.74× | 3.60, 3.10, 3.90, 3.00        |
| soft-wrap-long-lines | redo      |   4.75 |   3.20 |     0.67× | 3.30, 3.10, 5.00, 3.00        |
| single-line-1m       | edit      |  51.25 |  53.95 |     1.05× | 55.20, 52.70, 57.30, 50.50    |
| single-line-1m       | undo      |  51.75 |  53.50 |     1.03× | 54.50, 52.50, 68.00, 50.70    |
| single-line-1m       | redo      |  51.45 |  53.85 |     1.05× | 55.10, 52.60, 72.10, 50.30    |
| multicursor-1000     | edit      |  84.60 |  93.65 |     1.11× | 118.80, 90.90, 96.40, 84.30   |
| multicursor-1000     | undo      |  73.45 |  79.55 |     1.08× | 99.80, 76.60, 82.30, 76.80    |
| multicursor-1000     | redo      |  74.95 |  82.10 |     1.10× | 107.30, 79.50, 84.70, 77.10   |
| paste-1m             | edit      |  66.55 | 101.75 |     1.53× | 100.50, 98.10, 107.70, 103.00 |
| paste-1m             | undo      |   5.25 |   4.65 |     0.89× | 4.70, 4.50, 4.60, 4.70        |
| paste-1m             | redo      |  64.85 |  97.95 |     1.51× | 96.30, 95.60, 102.70, 99.60   |
| javascript-1m        | edit      |  72.30 |  70.15 |     0.97× | 58.90, 70.80, 90.00, 69.50    |
| javascript-1m        | undo      |  67.25 |  66.25 |     0.99× | 58.00, 67.10, 92.80, 65.40    |
| javascript-1m        | redo      |  61.00 |  67.50 |     1.11× | 52.40, 66.40, 99.30, 68.60    |
| ipython-injections   | edit      |   5.10 |   4.45 |     0.87× | 4.60, 4.20, 4.40, 4.50        |
| ipython-injections   | undo      |   5.50 |   4.20 |     0.76× | 4.00, 4.40, 4.40, 3.90        |
| ipython-injections   | redo      |   5.30 |   4.60 |     0.87× | 4.70, 4.50, 4.40, 5.10        |

## Same-facade model workloads

Both sides use the real TextBuffer facade, including its history and marker policy. Creation is timed explicitly. Edit/snapshot rows measure one replacement and capture of parser input; a native string and a JS immutable root both preserve the source revision. The fragmented case is a batch of 100 insertion/undo pairs after 5000 scattered edits. Fuzzy/regex timings include completion of the asynchronous result. The retention case includes forced GC and is not a typing-latency measure.

| Scenario                             | Native |     JS | JS/native | JS process medians             |
| ------------------------------------ | -----: | -----: | --------: | ------------------------------ |
| document/create/1000000              |   1.45 |   1.58 |     1.09× | 1.58, 1.58, 1.57, 1.62         |
| document/edit/1000000                |  0.178 |  0.235 |     1.32× | 0.239, 0.232, 0.246, 0.228     |
| document/edit-snapshot/1000000       |  0.838 |  0.189 |     0.23× | 0.193, 0.186, 0.214, 0.183     |
| document/create/8000000              |  10.87 |  11.98 |     1.10× | 11.98, 12.32, 11.87, 11.98     |
| document/edit/8000000                |  0.158 |  0.203 |     1.29× | 0.198, 0.201, 0.230, 0.205     |
| document/edit-snapshot/8000000       |   5.56 |  0.204 |     0.04× | 0.203, 0.205, 0.191, 0.204     |
| document/create/32000000             |  43.34 |  49.49 |     1.14× | 50.40, 48.57, 48.27, 51.71     |
| document/edit/32000000               |  0.168 |  0.243 |     1.45× | 0.239, 0.246, 0.236, 0.307     |
| document/edit-snapshot/32000000      |  20.98 |  0.209 |     0.01× | 0.209, 0.208, 0.210, 0.229     |
| document/create/128000000            | 178.52 | 202.77 |     1.14× | 205.62, 199.93, 249.14, 195.10 |
| document/edit/128000000              |  0.164 |  0.210 |     1.28× | 0.212, 0.202, 0.235, 0.207     |
| document/edit-snapshot/128000000     |  86.89 |  0.214 |     0.00× | 0.202, 0.212, 0.217, 0.216     |
| document/fragmented-5000-edits       |   6.69 |   6.74 |     1.01× | 6.27, 6.45, 7.03, 7.20         |
| search/regex/1000000                 |   9.98 |  11.00 |     1.10× | 11.08, 11.43, 10.92, 10.78     |
| search/regex/8000000                 |  56.06 |  66.90 |     1.19× | 65.23, 73.64, 64.18, 68.56     |
| document/retain-21-snapshots/8000000 | 111.74 |   6.81 |     0.06× | 6.41, 7.76, 6.44, 7.18         |
| autocomplete/duplicate-words         |   2.71 |  10.45 |     3.86× | 6.50, 11.58, 9.67, 11.22       |
| autocomplete/unique-words-max20      |  10.50 |  16.68 |     1.59× | 13.50, 19.31, 14.07, 19.29     |
| autocomplete/oversized-word          |  21.81 |   7.53 |     0.35× | 7.40, 7.64, 7.41, 7.79         |

## Snapshot retention

Additional memory after retaining 21 source versions of an eight-million-unit document, relative to the first retained version, with GC at both boundaries. This includes the real TextBuffer and history on both sides. Heap, external and RSS are separate allocator observations, not an exact count of all live bytes.

| Implementation | Heap delta (MiB) | External delta (MiB) | RSS delta (MiB) |
| -------------- | ---------------: | -------------------: | --------------: |
| native         |          305.203 |               -0.000 |         305.234 |
| javascript     |            0.101 |               -0.000 |           0.322 |

## Scope and limits

These are machine-specific measurements, not a universal language ranking. Four process medians expose run-to-run variability but do not establish stable tail latency; nine-sample p95 values in the raw data are descriptive. A queued timer delay measures that timer only, not worst-case event-loop blocking or keyboard-to-paint latency. Regex matching yields between result batches, but a single expensive RegExp execution and materializing its input still happen on the calling thread. Fuzzy search yields cooperatively; neither search nor syntax has been moved to a worker.

File encoding, cancellation, reload races and save snapshots were tested for correctness. This series does not measure disk I/O, startup of the entire application, sustained interactive scrolling, arbitrary pathological regexes or every package in the ecosystem. Only Windows was exercised for this WIP; no new cross-platform CI was run because the work remains uncommitted.

Exploratory reports under `.dev/js-document-integration/` include an earlier candidate before line caching. Those runs informed the optimization and are not pooled with this final report. The old bare-kernel benchmark is likewise not included in these comparisons.

## Correctness checks

The migration passed 6872 editor specs with zero failures and one Windows-inapplicable POSIX process-group test pending, 351 main-process specs, 45 parser runtime tests, 33 document-core tests and 29 packaging checks. After the final line/search changes, 312 targeted buffer/I/O specs passed; a preceding scanner integration run passed 868 editor/buffer specs. Bracket Matcher passed 210 specs after fixing an existing delayed-injection-publication bug, Column Selection passed 75, and Autocomplete passed 438. Lint, formatting and API-doc checks passed; the production dependency audit reported zero vulnerabilities. The full editor run preceded the final scanner/cache optimizations, which were revalidated with the focused suites rather than presented as a second full run.
