# Sustained typing in a large SOFiSTiK document

Windows measurements on 2026-10-20 use a user-supplied document of 8,400,039 bytes and 195,789 rows. The maximum line length is 138 UTF-16 units. Its contents and original path are not distributed. [Raw samples, source hashes and validation](../benchmark/results/sofistik-sustained-typing-2026-10-20.json) identify the measured inputs.

The [follow-up lifecycle investigation](typing-tail-performance-2026-10-20.md) reproduces post-GC pauses, identifies synchronous WASM tree destruction and records disposal scheduling plus adaptive parsing for slow large grammars. The outlier below remains part of this earlier measurement.

## Findings

The dominant delay was Tree-sitter changed-range comparison over an input block with approximately 196,000 immediate children. Existing hidden groups already accelerated incremental parsing, but changed-range traversal flattened them. Exposing the outer 64-element `program_body_group` lets it skip unchanged subtrees. A diagnostic standalone parse measured about 30 ms for comparison before and 1–2 ms after; this is profiling evidence, separate from the accepted editor timings below.

The line-ending status package also performed two document-wide regular-expression searches after inserting a newline. The persistent piece tree now counts CRLF pairs, including pairs crossing piece boundaries. `TextBuffer.getLineEndings()` reads the resulting LF/CRLF presence in constant time, and the status package consumes it. This adds a counter per tree node and a four-byte index entry per CRLF in each source chunk, rather than retaining another complete text string.

## Command latency

Values are milliseconds. Each value is the median of two process statistics. P95 is therefore the median of per-process p95s, not a pooled percentile or a confidence bound.

| Position and key              | Before median | After median | Before p95 | After p95 |
| ----------------------------- | ------------: | -----------: | ---------: | --------: |
| Middle: letter                |         34.35 |         5.90 |      39.65 |      7.55 |
| Middle: Enter                 |         35.45 |         5.20 |      39.50 |      6.25 |
| Near end, inside body: letter |         34.05 |         5.75 |      38.55 |      7.35 |
| Near end, inside body: Enter  |         33.55 |         5.45 |      37.50 |      6.85 |
| EOF after block: letter       |          4.25 |         4.40 |       5.55 |      5.25 |
| EOF after block: Enter        |          4.10 |         4.15 |       5.00 |      5.25 |

## Queue and frames

| Position and key              | Before maximum backlog | After maximum backlog | Before frame-gap p95 | After frame-gap p95 |
| ----------------------------- | ---------------------: | --------------------: | -------------------: | ------------------: |
| Middle: letter                |                 802.66 |                 30.37 |                33.40 |               16.70 |
| Middle: Enter                 |                1449.46 |                 13.82 |                50.00 |               16.70 |
| Near end, inside body: letter |                 741.86 |                 32.37 |                33.40 |               16.70 |
| Near end, inside body: Enter  |                1289.56 |                 13.30 |                41.65 |               16.70 |
| EOF after block: letter       |                  22.43 |                 22.87 |                16.75 |               16.75 |
| EOF after block: Enter        |                  14.64 |                 14.39 |                16.70 |               16.75 |

Cold first-letter commands and occasional frame gaps still exceed a 16.7 ms budget. The change removes the sustained backlog in the measured body-edit scenarios; it does not guarantee that every frame or first interaction meets budget. EOF after the block was already fast in the baseline and does not show a steady command-latency gain.

## Method

The before core is the frozen JS implementation in the [preceding hot-path report](hot-edit-performance-2026-10-20.md), before adding line-ending metadata. The after core adds that metadata. Both sides activate the same 30 packages, except for the intended line-ending implementation and SOFiSTiK grammar changes. The parser source advances from c436f96d8da72ec19bc480fc89e4c65e0b4dc314 to 480f8abb7e3817e5cadf0dca93c6666050ae72f0. This is a JS-before versus JS-after comparison, not a new Superstring comparison.

The middle/EOF round and near-end round each run before/after/after/before in separate Electron processes. Every case starts with a newly opened buffer, waits for grammar readiness, scrolls to its target and waits 500 ms. It schedules 90 commands at 33.333 ms intervals with normal asynchronous rendering and default automatic indentation/completion. It does not force a synchronous render after each key. Command time measures insertText or insertNewline and synchronous listeners; event backlog measures lateness against the intended dispatch time. Animation-frame timestamps track renderer scheduling, not hardware presentation. The comparative harness begins frame recording when its first animation callback arrives, so its first-command latency is reported separately in raw samples. No profiling or correctness suites run during accepted timing.

After each sequence, sampled scope signatures and final text hashes agree between variants. Undo restores the original text hash, and the on-disk hash is checked unchanged. Setup, scope verification and undo are outside timed sequences. The original file is never saved. Thirty active packages cover the tested hooks; activation does not exercise every command or every optional feature of the fleet.

## Faster input control

The committed [benchmark](../benchmark/sustained-typing-benchmark-spec.js) also tests the final implementation at 16.667 ms intervals, 90 commands per case, in one additional process. It establishes the initial animation-frame baseline before sending keys. This is a final-only control, not another speedup comparison.

This faster six-case run also exposed isolated pauses outside the edit commands after repeatedly reopening and undoing the large document: the EOF letter case reached 114 ms of input backlog, and EOF Enter reached 315 ms with a 300 ms animation-frame gap. Their maximum command times were only 5.8 and 8.9 ms. These outliers remain unresolved and are retained in the results. A separate fresh-process diagnostic with 300 letters followed by 300 Enters at the same cadence did not reproduce that long Enter pause: Enter p95 was 5.0 ms and its maximum frame gap 16.8 ms. That diagnostic used CPU profiling and is not pooled into accepted speed measurements; it does not establish the cause of the earlier pauses.

A second profiled run repeated all six 90-command scenarios in order. Its EOF Enter maximum backlog was 2.1 ms and maximum frame gap 16.8 ms; it also did not reproduce the isolated pause. Profiling can change collection and scheduling, so these diagnostic runs do not invalidate the unprofiled outlier.

| Position and key              | Median command | p95 command | Maximum backlog | Frame-gap p95 |
| ----------------------------- | -------------: | ----------: | --------------: | ------------: |
| Middle: letter                |           5.70 |        7.00 |           25.83 |         16.70 |
| Middle: Enter                 |           5.90 |        7.40 |           11.67 |         16.80 |
| Near end, inside body: letter |           5.40 |        6.70 |           12.19 |         16.70 |
| Near end, inside body: Enter  |           5.50 |        6.50 |           11.85 |         16.80 |
| EOF after block: letter       |           4.00 |        5.10 |          113.53 |         16.80 |
| EOF after block: Enter        |           4.50 |        5.80 |          315.02 |         16.70 |

## Correctness and reproduction

Final validation: 1,981 core specs, 113 Node tests, 59 line-ending specs, 86 SOFiSTiK editor specs, 156 native parser tests, 83 WASM parser tests and 42 parser corpus cases; zero failures. The earlier 28-package validation and its exact candidate remain documented in the preceding report.

`program_body_group` is a public syntax-tree shape change. It is a storage grouping, not a CADINP scope. Consumers should traverse statement descendants instead of assuming an immediate input_block parent. Corpus expectations, parent-sensitive tests and generated parser metadata were updated. Incremental edits across grouping boundaries are compared with fresh parses after flattening only the grouping nodes; syntax nodes and positions must agree.

To reproduce on a privately supplied file, run the committed benchmark with the editor test runner and an isolated LUMINE_HOME. LUMINE_TYPING_BENCH_CONFIG is JSON containing file, output, packages, count and interval; positions can restrict the scenarios. Provision the listed packages in that home. Timing drivers and frozen baseline inputs for this run remain in .dev/hot-paths-20261020. The final benchmark avoids embedding a user filename or publishing document text.
