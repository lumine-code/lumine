# Incremental buffer-word index performance

The bounded word index materially improves repeated requests and typing in the 6000-row search window. It has a cold-build cost and retains additional memory; it is not faster for every workload. The implementation is enabled for whole-row compact candidate queries up to two Mi UTF-16 units. See [the ownership and invalidation contract](completion-pipeline.md#incremental-word-index) and [all raw measurements](../benchmark/results/word-index-2026-10-19.json).

## Actual completion popup

These times include the real autocomplete command, provider, merge, model, current popup DOM and layout. Typing additionally includes insertion of the final query character. Each cold sample clears the buffer before loading the fixture, so identical text cannot accidentally retain the previous index. Warm and typing samples first request suggestions outside timing.

| Scenario           | Scan (ms) | Index (ms) |
| ------------------ | --------: | ---------: |
| repeated-6000/cold |    12.600 |     11.450 |
| repeated-6000/warm |     7.450 |      2.700 |
| repeated-6000/type |     9.100 |      4.150 |
| unique-6000/cold   |    20.200 |     25.200 |
| unique-6000/warm   |    25.800 |     20.950 |
| unique-6000/type   |    25.200 |     22.250 |
| window-100000/cold |    11.450 |     12.500 |
| window-100000/warm |     7.250 |      3.100 |
| window-100000/type |     8.750 |      5.400 |

For 6000 repeated-word rows, warm popup latency improves from 7.45 to 2.70 ms and typing-to-popup from 9.10 to 4.15 ms. With unique names the gains are smaller, and cold popup latency increases from 20.20 to 25.20 ms. This is a deliberate tradeoff for reuse during subsequent typing, not a universal speedup.

The 100-row UI case is inconclusive: scan/index warm medians are 4.20/9.05 ms, but the two indexed process medians are 15.50 and 2.60 ms. Samples in both variants fall into roughly 3 ms and 16–19 ms groups, suggesting a substantial scheduling/rendering contribution. The raw report preserves this case rather than discarding it or claiming a small-file win. The cold 6000-row UI scan medians also vary (10.0 and 15.2 ms), so its aggregate is not evidence that building the index is cheaper than scanning.

## Model queries and edit cost

The Node fixtures use Unicode-containing source-like lines; their vocabulary differs from the popup fixtures. These numbers must not be subtracted from the popup times. Matching and returned compact metadata are checked against the streaming scanner, including positions, occurrence counts, locality, scores and highlight indices.

| Scenario                    | Scan (ms) | Index (ms) |
| --------------------------- | --------: | ---------: |
| repeated-6000/cold          |    19.091 |     20.027 |
| repeated-6000/warm          |    17.192 |      0.269 |
| repeated-6000/type+query    |    17.159 |      0.814 |
| repeated-6000/newline+query |    17.239 |      0.780 |
| repeated-6000/paste+query   |    17.192 |      0.877 |
| repeated-6000/bulk+query    |    47.001 |     49.392 |
| unique-6000/cold            |    28.001 |     29.565 |
| unique-6000/warm            |    26.726 |     11.433 |
| unique-6000/type+query      |    26.730 |     13.609 |
| unique-6000/newline+query   |    26.939 |     14.554 |
| unique-6000/paste+query     |    26.704 |     13.890 |
| unique-6000/bulk+query      |    55.470 |     61.399 |

An unchanged repeated-word query falls from 17.19 to 0.269 ms; typing plus query falls from 17.16 to 0.814 ms. The synchronous edit itself is 0.113/0.121 ms for scan/index; tokenization of the affected block is deferred to the query. Newline insertion is 0.106/0.136 ms for the edit itself. The index translates cached rows below the edit without rescanning them.

A bulk change on every row invalidates the whole search window, so it loses reuse and is slower: 47.00/49.39 ms for repeated words and 55.47/61.40 ms for unique names. The batch implementation walks changes and blocks once; it does not run full cache invalidation separately for each of the 6000 edits. These costs include preparation of the bulk edit offsets and document history bookkeeping.

The 100000-row fixture queries only the provider-sized 6000-row window: warm query time is 17.03/0.211 ms and typing plus query is 17.03/0.702 ms. Eight warm buffers queried concurrently take 136.15/1.223 ms. A long single-line fixture exceeds the index eligibility limit and uses the scanner in both variants; its warm times are 32.60/33.83 ms, with no algorithmic indexing gain expected. Alternate subsequence and no-match queries are also included in the raw report.

## Retained memory

After a query and forced GC, the index retains approximately 11 KB for 100 repeated-word rows, 672 KB (0.64 MiB) for 6000 repeated-word rows, and 2.04 MB (1.95 MiB) for 6000 unique-name rows. The 100000-row file retains about 644 KB for its queried window, demonstrating that the entire document is not indexed. Scanner deltas range from small positives to a negative 17 KB due to heap collection noise; they are not negative memory consumption.

Each buffer retains at most 64 blocks of up to 128 rows, 2097152 units of indexed line content and 100000 occurrences. Those limits bound cache content, not heap bytes. Indexes are created on demand, keep one tokenizer configuration, and become collectible with their buffer. Multiple open buffers can each retain an index; the eight-buffer case is not a global memory cap.

## Reproduction and interpretation

Measured on 2026-10-19, Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz, Windows x64. Each layer uses fresh processes in scan/index/index/scan order, two processes per variant. Query and popup cases use three warmups and nine samples per process. Tables report the median of the two process medians. Exact Node/Electron versions, sample arrays, p95 model values, source fingerprints, autocomplete fingerprint and driver hashes are in the raw report. All benchmark layers ran serially; correctness suites ran after performance capture.

The scan variant uses the same final source with indexing disabled through the internal TextStore constructor option. Its frozen UI source differs only in that option's default. Both variants use the JS document model and identical scorer; this is not another comparison against Superstring. The first benchmark uses node --expose-gc benchmark/word-index-benchmark.js --mode scan|index --output report.json; add --memory for the separate retained-heap process. Popup scenarios are in benchmark/buffer-word-completion-spec.js and use isolated package homes with the measured autocomplete sources.

Memory runs warm both code paths before measurement, strongly retain eight buffers, and collect before and after their first query. Three trials report bytes per buffer. This measures retained JS heap, not peak allocation, RSS or a hard memory ceiling. Pilot measurements that mixed memory collection with earlier timing fixtures were excluded because they also collected unrelated objects.

The result supports demand-built block indexing for interactive word completion. A global vocabulary, eager indexing at file open and a synchronized worker are not needed to obtain these gains. Cold unique-word requests and complete rewrites remain slower; optimize those separately if real usage shows they dominate.

## Correctness validation

The final sources passed 55 document-core tests (including differential indexed/scanning checks), 205 TextBuffer specs, and 2072 consumer specs: autocomplete 455, autocomplete-lumine 29, ide 1222, snippets 215 and spell-check 151. Total: 2332 passing tests. Coverage includes Unicode, custom word characters, exact scores and metadata, dense occurrences, row boundaries, multiline and batch edits, discarded edits, resets, overlapping queries, cancellation, stale-cache publication, bounded retention and 120 deterministic randomized edits. ESLint and formatting checks pass. The [validation record](../benchmark/results/word-index-validation-2026-10-19.json) includes the consumer source fingerprint before and after the sweep.

An accidentally unfiltered exploratory runner also reached aura-theme and found four theme failures. A control with indexing disabled reproduced the same four failures; this change does not fix those theme tests. The interrupted exploratory run is not claimed as a passing full-fleet sweep.
