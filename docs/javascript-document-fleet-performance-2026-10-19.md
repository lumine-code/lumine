# JavaScript document model with active packages

Local Windows measurements on 2026-10-19 after the snapshot, line-reader, fuzzy-search and bulk-edit optimization pass. The [raw performance report](../benchmark/results/javascript-document-fleet-performance-2026-10-19.json) retains every sample, process median, source hash and package fingerprint. The [fleet validation report](../benchmark/results/javascript-document-fleet-validation-2026-10-19.json) records the full package sweep and subsequent retries.

## Findings

These findings describe the broad matrix before the final two refinements; see [the follow-up comparison](#follow-up-fuzzy-scanning-and-transaction-history) for their measured effect.

Editing and retaining parser input at 128 million units takes 0.202 ms in JS versus 88.76 ms in native. Reading all lines of an eight-million-unit document takes 37.89 ms in JS versus 277.56 ms in native. These are the clearest benefits of persistent snapshots and the streaming buffer API.

With active packages, an edit in the 32-million-unit fixture with 10000 markers takes 12.00 ms in JS versus 33.40 ms in native; a million-unit paste takes 195.95 ms in JS versus 207.05 ms in native. Review the process medians and raw samples when interpreting small differences.

Remaining optimization targets include trimming 5000 rows (85.80 ms in JS versus 58.75 ms in native) and duplicate-word fuzzy completion (9.97 ms in JS versus 2.75 ms in native). The JS model is not universally faster than the native reference. The measured gains support the shared-snapshot architecture while these dense workloads retain a measurable cost.

## Method

Reference: native editor `50fa656a4df67f1c989b76a7e21fc14b93129e3b`. Candidate HEAD at capture: `2f024779f43787524e9afd1b792bc87ce419d48c`; dirty working source: true. The frozen source hash, rather than HEAD alone, identifies the code actually measured. Both run the same benchmark bytes, installed dependencies and workspace package sources. Runtime checks require Superstring only on the native side.

Hardware: Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz, win32 x64. Electron 44.9.0, renderer Node 24.22.0, model Node v24.18.0. 2 fresh processes per backend and measurement layer; three warmups and nine samples per case. Serial alternating native/JS, JS/native order. No tests launched by this task ran concurrently. Results are medians of 2 process medians; all times are milliseconds.

Four processes per backend were originally planned. A later workspace dependency repin stopped the orchestrator during its sixth run. This report includes only the first four runs (two complete pairs), which had already passed every source, dependency and package fingerprint check. Subsequent runs are excluded. The raw report records the interruption and how these verified results were aggregated from the retained snapshots.

The renderer cases use real workspace editors with minimap, scrollmap, markers, highlighting, brackets, snippets and autocomplete active. Commands include sorting, whitespace cleanup and the real completion popup. Grammar cases cover JavaScript, IPython injections, Python with CRLF and Unicode, HTML with JavaScript/CSS, 1000 script injections and minified JSON. Parser binaries and queries are prewarmed outside timing. This measures steady-state editing, not cold startup.

Inputs, resulting text, undo/redo, marker and selection state, full syntax forests and screen-line counts must match. The completion case waits for a known suggestion. Soft wrapping and tab length are asserted after workspace configuration has been applied. A million units means UTF-16 code units, not bytes.

The complete metric includes the command, grammar settlement and explicit DOM/layout update. The twoFrames metric additionally waits for two requestAnimationFrame callbacks; it does not prove physical presentation or completion of every debounced package task. Verification, fixture setup and operating-system clipboard IPC are excluded.

## Renderer operations

| Scenario                    | Operation | Native complete | JS complete | JS/native | Native two frames | JS two frames |
| --------------------------- | --------- | --------------: | ----------: | --------: | ----------------: | ------------: |
| plain-1m-markers            | edit      |            4.35 |        3.50 |     0.80× |             22.00 |         26.75 |
| plain-1m-markers            | undo      |           21.75 |        8.75 |     0.40× |             28.55 |         28.15 |
| plain-1m-markers            | redo      |           21.55 |        8.60 |     0.40× |             31.85 |         24.85 |
| plain-8m-markers            | edit      |           11.40 |        5.30 |     0.46× |             23.10 |         28.10 |
| plain-8m-markers            | undo      |           28.90 |       10.60 |     0.37× |             45.45 |         17.05 |
| plain-8m-markers            | redo      |           28.75 |       10.70 |     0.37× |             52.20 |         18.55 |
| plain-32m-markers           | edit      |           33.40 |       12.00 |     0.36× |             35.35 |         27.45 |
| plain-32m-markers           | undo      |           55.40 |       16.45 |     0.30× |             60.00 |         26.90 |
| plain-32m-markers           | redo      |           51.70 |       16.85 |     0.33× |             56.40 |         25.60 |
| soft-wrap-long-lines        | edit      |           14.60 |       10.45 |     0.72× |             25.35 |         31.00 |
| soft-wrap-long-lines        | undo      |           12.90 |        7.80 |     0.60× |             28.35 |         28.70 |
| soft-wrap-long-lines        | redo      |           12.60 |        7.15 |     0.57× |             26.95 |         27.75 |
| single-line-1m              | edit      |           66.70 |       62.85 |     0.94× |             70.55 |         65.95 |
| single-line-1m              | undo      |           58.65 |       58.40 |     1.00× |            115.35 |         65.15 |
| single-line-1m              | redo      |           62.85 |       61.65 |     0.98× |             67.65 |         65.20 |
| multicursor-1000            | edit      |          168.75 |      166.75 |     0.99× |            177.65 |        179.25 |
| multicursor-1000            | undo      |          154.95 |      125.40 |     0.81× |            162.95 |        140.75 |
| multicursor-1000            | redo      |          157.35 |      121.15 |     0.77× |            173.10 |        140.55 |
| paste-1m                    | edit      |          207.05 |      195.95 |     0.95× |            223.55 |        215.70 |
| paste-1m                    | undo      |           68.60 |       69.45 |     1.01× |             78.10 |         78.05 |
| paste-1m                    | redo      |          198.85 |      191.70 |     0.96× |            220.30 |        210.35 |
| javascript-1m               | edit      |           75.30 |       71.15 |     0.94× |             78.10 |         74.10 |
| javascript-1m               | undo      |           62.45 |       67.20 |     1.08× |             72.65 |         74.00 |
| javascript-1m               | redo      |           62.55 |       65.30 |     1.04× |             73.70 |         68.65 |
| ipython-injections          | edit      |           13.95 |       13.20 |     0.95× |             26.90 |         27.60 |
| ipython-injections          | undo      |           11.90 |       11.40 |     0.96× |             28.35 |         27.00 |
| ipython-injections          | redo      |           13.35 |       11.10 |     0.83× |             27.65 |         27.90 |
| sort-lines-10000            | edit      |           26.00 |       25.05 |     0.96× |             52.35 |         39.10 |
| sort-lines-10000            | undo      |           24.60 |       23.80 |     0.97× |             33.35 |         32.65 |
| sort-lines-10000            | redo      |           24.10 |       21.45 |     0.89× |             32.80 |         32.10 |
| autocomplete-popup          | edit      |           13.70 |       19.10 |     1.39× |             40.95 |         40.85 |
| autocomplete-popup          | undo      |            7.45 |        7.40 |     0.99× |             31.90 |         31.85 |
| autocomplete-popup          | redo      |            4.70 |        4.10 |     0.87× |             31.35 |         31.50 |
| whitespace-trim-5000        | edit      |           58.75 |       85.80 |     1.46× |             67.30 |         90.20 |
| whitespace-trim-5000        | undo      |           74.00 |       85.00 |     1.15× |             82.95 |         89.95 |
| whitespace-trim-5000        | redo      |           73.90 |       63.70 |     0.86× |             81.65 |         67.50 |
| whitespace-tabs-5000        | edit      |           65.80 |       89.70 |     1.36× |             78.45 |         96.65 |
| whitespace-tabs-5000        | undo      |           69.15 |       84.60 |     1.22× |             76.60 |         88.25 |
| whitespace-tabs-5000        | redo      |           69.85 |       70.30 |     1.01× |             76.45 |         74.50 |
| python-crlf-1m              | edit      |          294.75 |      234.25 |     0.79× |            306.60 |        246.00 |
| python-crlf-1m              | undo      |          273.75 |      251.10 |     0.92× |            323.00 |        278.40 |
| python-crlf-1m              | redo      |          279.65 |      237.15 |     0.85× |            305.15 |        266.90 |
| html-injections-1m          | edit      |           76.45 |       64.15 |     0.84× |             79.65 |         67.15 |
| html-injections-1m          | undo      |           68.20 |       56.30 |     0.83× |             70.25 |         57.75 |
| html-injections-1m          | redo      |           65.20 |       55.80 |     0.86× |             67.55 |         58.70 |
| html-1000-injections        | edit      |           50.25 |       39.15 |     0.78× |             51.55 |         40.50 |
| html-1000-injections        | undo      |           40.65 |       31.60 |     0.78× |             44.20 |         33.20 |
| html-1000-injections        | redo      |           42.30 |       34.35 |     0.81× |             46.40 |         35.80 |
| json-minified-20000-records | edit      |          329.50 |      297.35 |     0.90× |            541.60 |        311.35 |
| json-minified-20000-records | undo      |          316.70 |      280.30 |     0.89× |            330.10 |        304.15 |
| json-minified-20000-records | redo      |          304.40 |      283.65 |     0.93× |            513.60 |        315.80 |

## Buffer model workloads

Both backends use the real TextBuffer facade. Edit/snapshot captures preserve a source revision: native materializes a string, JS retains an immutable root. The sequential read case consumes every line; the native baseline uses its existing getLines API while JS streams a snapshot. Retained-snapshot timings include forced GC and are not typing latency.

| Scenario                                           | Native |     JS | JS/native | Native process medians | JS process medians |
| -------------------------------------------------- | -----: | -----: | --------: | ---------------------- | ------------------ |
| document/create/1000000                            |   1.45 |   1.77 |     1.22× | 1.47, 1.44             | 1.64, 1.90         |
| document/edit/1000000                              |  0.168 |  0.276 |     1.64× | 0.165, 0.172           | 0.298, 0.254       |
| document/edit-snapshot/1000000                     |  0.813 |  0.220 |     0.27× | 0.814, 0.811           | 0.250, 0.191       |
| document/create/8000000                            |  10.80 |  12.32 |     1.14× | 10.84, 10.77           | 12.82, 11.81       |
| document/edit/8000000                              |  0.156 |  0.212 |     1.36× | 0.151, 0.161           | 0.222, 0.201       |
| document/edit-snapshot/8000000                     |   5.58 |  0.204 |     0.04× | 5.36, 5.80             | 0.207, 0.202       |
| document/create/32000000                           |  42.81 |  49.43 |     1.15× | 41.92, 43.70           | 51.66, 47.21       |
| document/edit/32000000                             |  0.205 |  0.215 |     1.05× | 0.198, 0.213           | 0.228, 0.203       |
| document/edit-snapshot/32000000                    |  22.03 |  0.202 |   0.0092× | 21.01, 23.06           | 0.208, 0.197       |
| document/create/128000000                          | 187.00 | 196.49 |     1.05× | 173.40, 200.60         | 202.74, 190.24     |
| document/edit/128000000                            |  0.164 |  0.210 |     1.28× | 0.162, 0.166           | 0.203, 0.216       |
| document/edit-snapshot/128000000                   |  88.76 |  0.202 |   0.0023× | 86.33, 91.19           | 0.199, 0.206       |
| document/fragmented-5000-edits                     |   6.67 |   6.55 |     0.98× | 6.69, 6.64             | 6.90, 6.21         |
| document/read-lines/8000000                        | 277.56 |  37.89 |     0.14× | 283.36, 271.76         | 38.54, 37.23       |
| document/batch-1000/8000000                        | 620.84 | 502.33 |     0.81× | 630.49, 611.18         | 519.15, 485.51     |
| search/regex/1000000                               |   8.19 |  10.17 |     1.24× | 6.72, 9.66             | 10.96, 9.39        |
| search/regex/8000000                               |  56.33 |  70.09 |     1.24× | 54.74, 57.91           | 73.74, 66.44       |
| document/retain-21-snapshots/8000000               | 111.89 |   5.72 |     0.05× | 111.59, 112.18         | 6.28, 5.16         |
| editor-model/insert/multiline/1000000 UTF-16 units |  69.02 |  71.27 |     1.03× | 68.29, 69.76           | 77.20, 65.35       |
| autocomplete/duplicate-words                       |   2.75 |   9.97 |     3.63× | 2.56, 2.93             | 11.08, 8.86        |
| autocomplete/unique-words-max20                    |  11.95 |  15.95 |     1.33× | 14.23, 9.68            | 18.94, 12.97       |
| autocomplete/oversized-word                        |  21.25 |   7.68 |     0.36× | 21.25, 21.26           | 7.94, 7.42         |

## Retained snapshots and event-loop delay

Memory is the incremental process delta after GC with 21 eight-million-unit source snapshots retained. It is not total editor memory; RSS depends on allocator reuse. Shared roots remove repeated full-text copies, which is an architectural advantage rather than evidence that JavaScript intrinsically outperforms native code.

| Backend    | Additional JS heap, MiB | Additional RSS, MiB |
| ---------- | ----------------------: | ------------------: |
| native     |                  305.20 |              305.23 |
| javascript |                   0.110 |               0.027 |

Timer delay measures when a zero-delay timer scheduled immediately before the operation can run. It includes event-loop scheduling and is separate from paint.

| Scenario, edit              | Native timer delay | JS timer delay |
| --------------------------- | -----------------: | -------------: |
| plain-1m-markers            |               4.45 |           3.50 |
| plain-8m-markers            |              11.45 |           5.55 |
| plain-32m-markers           |              33.40 |          12.00 |
| soft-wrap-long-lines        |              14.65 |          10.45 |
| single-line-1m              |              67.40 |          62.85 |
| multicursor-1000            |             170.15 |         170.70 |
| paste-1m                    |             212.15 |         200.35 |
| javascript-1m               |              75.45 |          71.20 |
| ipython-injections          |              13.95 |          13.25 |
| sort-lines-10000            |              26.00 |          25.10 |
| autocomplete-popup          |               5.90 |           4.90 |
| whitespace-trim-5000        |              58.80 |          85.80 |
| whitespace-tabs-5000        |              66.30 |          90.15 |
| python-crlf-1m              |             295.70 |         235.20 |
| html-injections-1m          |              77.25 |          64.20 |
| html-1000-injections        |              50.25 |          39.25 |
| json-minified-20000-records |             334.70 |         300.35 |

## Package compatibility

The complete sweep covered 244 package suites, including 78 language packages. After fixing failures and rerunning affected suites, every package has a passing result: 19060 specs with 54 pending. This combines an initial sweep on an earlier frozen core and explicitly recorded retries on later cores; it is not a claim that all 244 suites ran again on the final performance candidate. The raw validation report preserves failed attempts and the core source hash for each retry. Package working trees remained live during this sweep and were not fingerprinted by the suite runner; the timed performance matrix separately fingerprints its selected package sources.

The sweep found a real table-editor dependency on the removed private history object; it now clears undo/redo through public buffer methods, with regression tests for reused mini editors. Windows fixture cleanup now yields while file handles are released. Settings tests dispose their panels/subscriptions and await package loading. Log-filter was rerun with the matching snapshot.lines API, and the test harness now exposes workspace package assets to both main and renderer processes.

After the bulk-edit optimization, the full editor suite passed 6892 specs with one POSIX-only pending test on Windows. The 38 document-core/storage/patch/marker unit tests passed, including randomized geometry and native differential checks. Focused renderer batch tests passed 20 specs. The grammar asset audit passed 108 WASM files.

## Scope and limitations

These are local Windows results on one machine, not cross-platform CI or a guarantee for every package combination. All package suites were tested, while the timed editor uses a selected set of active packages. Package sources are copied to frozen snapshots, shared by both backends, and their fingerprints are verified after each run. The native reference and candidate also contain surrounding editor changes, so this is an end-to-end candidate comparison, not a controlled attribution of every difference to JavaScript versus C++.

See [the first integration report](javascript-document-performance.md) for historical measurements before this optimization pass. Different package activation and renderer setup make those timings unsuitable for direct before/after ratios.

## Reproduction

```powershell
node script/benchmark-document-integration.js --baseline ../.dev/js-fleet-optimization/native-reference/lumine --processes 2 --samples 9 --warmups 3 --package-cases --model-filter "^(autocomplete|document|search)/|^editor-model/insert/multiline/1000000" --packages "sort-lines,whitespace,autocomplete,bracket-matcher,snippets,minimap,scrollmap,marker,highlight-selected,language-html,language-css,language-json,language-gfm,language-regex,language-javascript,language-python,language-ipython,language-text" --output ../.dev/js-fleet-optimization/new-measurement
```

The native archive must be prepared at the reference revision with the same installed dependencies; the runner copies identical benchmark drivers into both trees and freezes selected package working trees. Use a fresh output directory and keep installed dependencies and the frozen snapshots unchanged throughout the run. Ordinary workspace package edits cannot alter an already captured snapshot.

## Follow-up: fuzzy scanning and transaction history

After the broad matrix above, commits `82e38756` and `4105071b` removed two additional costs: transaction grouping now shares an already canonical patch instead of replaying its changes, and fuzzy scanning locates each line boundary once per chunk. A new many-words-on-one-line case exercises the repeated newline scans that the earlier fuzzy fixtures did not expose. These changes are not included in the broad matrix above.

The [three-way model report](../benchmark/results/javascript-document-search-history-models-2026-10-19.json) compares native, the preceding frozen JS source and the optimized JS source. Two fresh processes per variant used three warmups and nine samples; execution order was native/before/after, then after/before/native. All processes used the same current driver, and output checksums, driver hashes, source hashes and the dependency definition were checked. No other tests or benchmarks started by this task ran concurrently.

| Model operation                 | Native | JS before | JS after |
| ------------------------------- | -----: | --------: | -------: |
| document/batch-1000/8000000     | 601.16 |    511.53 |   475.80 |
| autocomplete/single-line-words  |   2.53 |     24.85 |     7.49 |
| autocomplete/duplicate-words    |   2.41 |     10.58 |     6.00 |
| autocomplete/unique-words-max20 |  10.32 |     17.30 |    13.26 |
| autocomplete/oversized-word     |  21.65 |      8.00 |     7.86 |

Fuzzy scanning improved substantially, particularly on one long line, while native remains faster on these ordinary-word fixtures. The oversized-word case remains faster in JS. The sparse 1000-row edit across an eight-million-unit indexed model improves modestly and remains a costly operation in both implementations.

The [follow-up renderer report](../benchmark/results/javascript-document-search-history-integration-2026-10-19.json) reruns real completion and whitespace commands with the same selected active packages, frozen source/package copies and two fresh processes per backend. Each process uses three warmups and nine samples. These are complete command/grammar/DOM-layout times, not physical paint times.

| Command              | Operation | Native | JS after | Native process medians | JS process medians |
| -------------------- | --------- | -----: | -------: | ---------------------- | ------------------ |
| autocomplete-popup   | edit      |  12.35 |    16.30 | 11.70, 13.00           | 16.40, 16.20       |
| autocomplete-popup   | undo      |   8.05 |     6.90 | 8.10, 8.00             | 7.00, 6.80         |
| autocomplete-popup   | redo      |   4.85 |     4.30 | 5.00, 4.70             | 4.20, 4.40         |
| whitespace-trim-5000 | edit      |  76.80 |    64.60 | 56.60, 97.00           | 66.80, 62.40       |
| whitespace-trim-5000 | undo      |  74.50 |    74.95 | 69.60, 79.40           | 73.90, 76.00       |
| whitespace-trim-5000 | redo      |  74.45 |    64.55 | 67.60, 81.30           | 65.00, 64.10       |
| whitespace-tabs-5000 | edit      |  66.50 |    76.75 | 66.00, 67.00           | 78.90, 74.60       |
| whitespace-tabs-5000 | undo      |  72.00 |    86.95 | 74.20, 69.80           | 94.20, 79.70       |
| whitespace-tabs-5000 | redo      |  72.00 |    67.20 | 72.00, 72.00           | 71.00, 63.40       |

The remaining costs are visible: completion-popup latency is still higher in JS, and converting tabs plus its undo is slower than native in this run. Trimming is faster in this run. The broad and follow-up matrices were separate sessions, so use the three-way model comparison for direct before/after conclusions and inspect process medians before interpreting small renderer differences.

Validation after both refinements: 40 document-core/storage/patch/marker tests passed; 970 buffer/editor/display specs passed; autocomplete 445, code-format 107, table-editor 93 and whitespace 56 specs passed (701 package specs total). The new differential tests cover line-boundary characters inside words, long lines, words crossing piece boundaries, identity changes and independence of shared patch roots. The complete 6892-spec editor sweep and full package fleet sweep recorded above predate these final two refinements.

To reproduce the renderer subset, use the full command above with `--filter "whitespace-|autocomplete-popup" --model-filter "^autocomplete/"` and a fresh output directory. For the model comparison, run `node --expose-gc benchmark/editor-superstring-benchmark.js --source <snapshot> --units 1000000,8000000 --samples 9 --warmups 3 --filter "^autocomplete/|^document/batch-1000/" --output <result.json>` separately for each frozen source in the recorded order. The raw reports retain the exact source hashes and individual samples.
