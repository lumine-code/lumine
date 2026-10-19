# Final JavaScript document model versus historical native

Measurement note (2026-10-20): the renderer fixtures below inherited Jasmine's synchronous editor updates. The [hot-edit comparison](hot-edit-performance-2026-10-20.md) uses normal scheduled updates and explains the correction. These historical before/after pairs used identical settings, but their absolute renderer times should not be compared directly to the corrected runner. Node-only model measurements are unaffected.

Measured locally on Windows after all text-model and auto-indent corrections. Candidate: `0f05b1302ba6e36de68403f6986d37b2427e6197`; historical native: `50fa656a4df67f1c989b76a7e21fc14b93129e3b`. Source and package fingerprints, every sample and process median are retained in the [raw report](../benchmark/results/javascript-document-final-comparison-2026-10-19.json).

## Findings

With shared compatible packages, the final JS core takes 11.00 ms versus 33.75 ms for a 32M edit with 10000 markers, and 15.60 ms versus 52.85 ms for undo. Typing at 1000 cursors takes 139.85 ms versus 168.75 ms. A 1M paste is broadly comparable at 187.40 ms versus 196.85 ms; the first native process was substantially slower in several cases, so all process medians are shown rather than treating its ratio as representative.

Snapshot capture and line streaming remain the largest architectural gains. Native retains advantages in buffer creation, dense regex and the legacy fuzzy API. The new compact indexed completion path is measured separately through the current provider, rather than compared to an incompatible native API.

Python in the broad shared-package matrix is bimodal on JS (313.7, 316.5, 226.8, 230.1 ms). The isolated control gives 244.45 ms native and 242.80 ms JS. Current-package JS processes give 234.3 and 243.3 ms. These results do not establish a consistent Python regression; the workload order/process-state sensitivity remains visible in the raw samples.

The current 20-package cohort is stable for several demanding operations: Enter at 1000 cursors takes 508.7/514.6 ms, multiline paste takes 481.1/489.5 ms, and multiline JavaScript formatting takes 57.7/52.6 ms. These absolute times still leave substantial room to improve very large cursor sets. Current-package paste and JSON timings are not uniformly lower than the shared-package cohort.

The broad current-package sequence retains package UI state between commands, including the search panel created by replace-all. It measures co-use in that sequence rather than independently reset command UIs. Heap observations in those runs are not GC-delimited memory benchmarks and must not be read as retained-memory or leak measurements.

## Method

Four processes per backend; shared historical compatible package sources. Separate two-process current JS fleet measurements. Three warmups, nine samples; serial execution.

The shared cohort uses 18 identical historical package snapshots on both cores. Current scrollmap requires getRowGeometryVersion and current completion uses findWordCandidates, APIs absent from the native reference. Using the latest packages only on JS in the direct comparison would confound the result. A separate current cohort measures the final JS core with 20 current packages, including formatter/search bulk edits, multiline operations and auto-indent. These are absolute current-version measurements, not direct native speedup claims.

Times are milliseconds, aggregated as the median of process medians. Renderer measurements include the command, grammar settlement and explicit DOM/layout update; they exclude setup, verification, OS clipboard IPC and physical presentation. M denotes millions of UTF-16 units. Timed runs were serial and regression tests started only afterwards. The workstation was not a dedicated benchmark host.

The incompatible current-package pilot and an initial run overlapping an orphaned historical test consuming CPU were excluded. That process was stopped before the accepted series. Neither excluded run contributes samples.

## Shared-package renderer comparison

| Scenario                    | Operation | Native ms |  JS ms | JS/native | Native process medians         | JS process medians             |
| --------------------------- | --------- | --------: | -----: | --------: | ------------------------------ | ------------------------------ |
| plain-1m-markers            | edit      |      4.40 |   3.15 |     0.72× | 4.60, 4.30, 4.40, 4.40         | 3.10, 3.20, 3.10, 3.40         |
| plain-1m-markers            | undo      |     22.35 |   7.55 |     0.34× | 30.50, 22.00, 22.10, 22.60     | 7.40, 7.50, 7.60, 7.80         |
| plain-1m-markers            | redo      |     22.25 |   7.65 |     0.34× | 24.10, 22.50, 22.00, 22.00     | 7.40, 7.70, 7.60, 7.70         |
| plain-8m-markers            | edit      |     11.35 |   5.10 |     0.45× | 14.70, 11.30, 11.40, 11.30     | 5.10, 5.30, 5.10, 5.10         |
| plain-8m-markers            | undo      |     29.95 |   9.55 |     0.32× | 34.80, 29.60, 30.30, 29.40     | 9.10, 9.80, 9.50, 9.60         |
| plain-8m-markers            | redo      |     29.90 |   9.55 |     0.32× | 50.50, 30.40, 29.40, 29.00     | 9.10, 10.00, 9.50, 9.60        |
| plain-32m-markers           | edit      |     33.75 |  11.00 |     0.33× | 45.20, 33.50, 34.00, 33.40     | 11.00, 10.90, 11.00, 11.20     |
| plain-32m-markers           | undo      |     52.85 |  15.60 |     0.30× | 74.50, 53.90, 51.80, 51.10     | 15.10, 15.70, 15.50, 16.20     |
| plain-32m-markers           | redo      |     53.20 |  15.50 |     0.29× | 73.40, 52.40, 53.40, 53.00     | 15.50, 15.50, 15.40, 15.50     |
| soft-wrap-long-lines        | edit      |     14.70 |   9.55 |     0.65× | 24.20, 14.30, 15.10, 14.30     | 9.50, 9.40, 9.60, 12.00        |
| soft-wrap-long-lines        | undo      |     12.85 |   7.25 |     0.56× | 22.80, 12.90, 12.80, 12.80     | 7.00, 7.20, 7.30, 8.40         |
| soft-wrap-long-lines        | redo      |     13.15 |   7.55 |     0.57× | 22.90, 13.30, 13.00, 13.00     | 7.20, 7.40, 7.70, 7.70         |
| single-line-1m              | edit      |     66.95 |  62.65 |     0.94× | 130.60, 63.40, 67.70, 66.20    | 62.20, 62.10, 63.60, 63.10     |
| single-line-1m              | undo      |     58.80 |  58.70 |     1.00× | 94.60, 56.40, 59.60, 58.00     | 58.40, 57.50, 59.00, 59.00     |
| single-line-1m              | redo      |     62.30 |  59.90 |     0.96× | 106.20, 59.40, 61.00, 63.60    | 59.90, 57.00, 60.30, 59.90     |
| multicursor-1000            | edit      |    168.75 | 139.85 |     0.83× | 235.70, 155.30, 166.70, 170.80 | 139.50, 136.20, 140.20, 145.50 |
| multicursor-1000            | undo      |    152.55 |  97.30 |     0.64× | 232.70, 144.80, 152.70, 152.40 | 97.20, 97.40, 96.80, 100.70    |
| multicursor-1000            | redo      |    160.60 |  99.05 |     0.62× | 242.00, 150.40, 161.40, 159.80 | 96.50, 98.90, 99.20, 101.60    |
| paste-1m                    | edit      |    196.85 | 187.40 |     0.95× | 293.60, 189.10, 197.40, 196.30 | 189.50, 188.10, 186.70, 185.00 |
| paste-1m                    | undo      |     67.40 |  64.25 |     0.95× | 110.50, 62.50, 67.60, 67.20    | 67.20, 64.30, 63.70, 64.20     |
| paste-1m                    | redo      |    193.75 | 183.20 |     0.95× | 318.40, 183.80, 197.80, 189.70 | 185.50, 182.60, 183.80, 182.10 |
| javascript-1m               | edit      |     75.90 |  67.85 |     0.89× | 95.90, 64.70, 72.70, 79.10     | 81.90, 68.90, 56.70, 66.80     |
| javascript-1m               | undo      |     67.05 |  60.35 |     0.90× | 101.10, 60.20, 70.10, 64.00    | 75.40, 61.10, 56.60, 59.60     |
| javascript-1m               | redo      |     63.25 |  57.10 |     0.90× | 90.00, 56.30, 66.60, 59.90     | 67.30, 56.80, 54.10, 57.40     |
| ipython-injections          | edit      |     13.00 |  10.75 |     0.83× | 13.80, 12.30, 13.20, 12.80     | 13.70, 11.10, 10.40, 10.10     |
| ipython-injections          | undo      |     12.05 |   9.80 |     0.81× | 17.30, 10.60, 11.60, 12.50     | 11.50, 9.80, 9.80, 8.70        |
| ipython-injections          | redo      |     12.45 |  10.45 |     0.84× | 18.90, 11.20, 13.00, 11.90     | 11.90, 11.10, 9.80, 8.80       |
| sort-lines-10000            | edit      |     26.40 |  23.80 |     0.90× | 42.50, 26.70, 25.80, 26.10     | 37.50, 23.90, 23.70, 23.60     |
| sort-lines-10000            | undo      |     24.45 |  21.85 |     0.89× | 33.60, 24.80, 24.10, 24.00     | 31.30, 21.90, 21.60, 21.80     |
| sort-lines-10000            | redo      |     24.15 |  21.90 |     0.91× | 37.60, 24.70, 23.60, 23.30     | 28.00, 22.00, 21.80, 21.50     |
| autocomplete-popup          | edit      |     13.65 |  15.70 |     1.15× | 14.90, 13.80, 12.50, 13.50     | 16.20, 15.30, 15.90, 15.50     |
| autocomplete-popup          | undo      |      8.40 |   6.80 |     0.81× | 10.20, 8.60, 7.70, 8.20        | 7.00, 6.60, 6.80, 6.80         |
| autocomplete-popup          | redo      |      5.50 |   4.15 |     0.75× | 6.80, 5.20, 5.20, 5.80         | 4.00, 4.10, 4.20, 4.50         |
| whitespace-trim-5000        | edit      |     57.35 |  56.45 |     0.98× | 80.40, 57.60, 56.50, 57.10     | 81.20, 54.90, 58.00, 53.40     |
| whitespace-trim-5000        | undo      |     71.10 |  70.20 |     0.99× | 90.60, 73.00, 65.30, 69.20     | 101.70, 68.60, 69.60, 70.80    |
| whitespace-trim-5000        | redo      |     67.95 |  57.05 |     0.84× | 104.90, 69.40, 66.50, 65.20    | 82.50, 56.60, 57.50, 55.70     |
| whitespace-tabs-5000        | edit      |     66.00 |  63.55 |     0.96× | 95.00, 65.10, 64.40, 66.90     | 89.90, 64.40, 62.70, 62.10     |
| whitespace-tabs-5000        | undo      |     70.45 |  76.10 |     1.08× | 97.20, 71.40, 66.00, 69.50     | 102.20, 75.70, 76.50, 72.30    |
| whitespace-tabs-5000        | redo      |     71.55 |  62.30 |     0.87× | 105.40, 71.90, 69.70, 71.20    | 84.60, 64.40, 60.20, 58.90     |
| python-crlf-1m              | edit      |    237.70 | 271.90 |     1.14× | 244.80, 239.60, 235.80, 227.40 | 313.70, 316.50, 226.80, 230.10 |
| python-crlf-1m              | undo      |    239.65 | 262.95 |     1.10× | 247.00, 236.00, 238.80, 240.50 | 297.30, 335.70, 228.60, 227.20 |
| python-crlf-1m              | redo      |    238.85 | 245.30 |     1.03× | 249.00, 239.40, 238.30, 230.60 | 261.30, 292.50, 226.60, 229.30 |
| html-injections-1m          | edit      |     62.85 |  59.15 |     0.94× | 63.50, 62.50, 63.20, 59.20     | 57.90, 75.80, 55.10, 60.40     |
| html-injections-1m          | undo      |     58.35 |  55.70 |     0.95× | 58.50, 58.20, 64.10, 56.90     | 55.30, 56.30, 52.50, 56.10     |
| html-injections-1m          | redo      |     56.85 |  53.90 |     0.95× | 57.70, 57.40, 56.30, 54.40     | 52.30, 59.70, 47.90, 55.50     |
| html-1000-injections        | edit      |     50.15 |  45.25 |     0.90× | 48.90, 51.40, 48.40, 52.50     | 43.10, 55.40, 43.90, 46.60     |
| html-1000-injections        | undo      |     42.75 |  36.40 |     0.85× | 42.30, 43.30, 40.00, 43.20     | 34.80, 45.80, 35.90, 36.90     |
| html-1000-injections        | redo      |     45.10 |  39.10 |     0.87× | 44.40, 46.80, 43.10, 45.80     | 39.60, 50.50, 37.90, 38.60     |
| json-minified-20000-records | edit      |    315.00 | 298.35 |     0.95× | 314.60, 315.20, 314.80, 319.80 | 280.70, 424.20, 311.20, 285.50 |
| json-minified-20000-records | undo      |    286.15 | 283.80 |     0.99× | 288.70, 286.10, 282.40, 286.20 | 261.10, 395.90, 302.10, 265.50 |
| json-minified-20000-records | redo      |    287.65 | 294.35 |     1.02× | 286.40, 288.90, 285.10, 296.90 | 260.60, 404.90, 307.60, 281.10 |

## Buffer model comparison

The model cases use the real TextBuffer facade. Native snapshot capture materializes text; JS retains an immutable root. This measures the deployed architecture, not an intrinsic language-speed advantage. Legacy fuzzy APIs in this cohort do not exercise the new compact indexed completion API.

| Scenario                                           | Native ms |  JS ms | JS/native |
| -------------------------------------------------- | --------: | -----: | --------: |
| document/create/1000000                            |      1.44 |   1.60 |     1.11× |
| document/edit/1000000                              |     0.175 |  0.259 |     1.48× |
| document/edit-snapshot/1000000                     |     0.823 |  0.178 |     0.22× |
| document/create/8000000                            |     10.78 |  11.91 |     1.10× |
| document/edit/8000000                              |     0.158 |  0.179 |     1.13× |
| document/edit-snapshot/8000000                     |      5.54 |  0.183 |     0.03× |
| document/create/32000000                           |     42.07 |  48.84 |     1.16× |
| document/edit/32000000                             |     0.172 |  0.199 |     1.15× |
| document/edit-snapshot/32000000                    |     21.76 |  0.191 |   0.0088× |
| document/create/128000000                          |    173.91 | 200.37 |     1.15× |
| document/edit/128000000                            |     0.174 |  0.194 |     1.11× |
| document/edit-snapshot/128000000                   |     85.43 |  0.198 |   0.0023× |
| document/fragmented-5000-edits                     |      6.91 |   6.66 |     0.96× |
| document/read-lines/8000000                        |    284.22 |  38.64 |     0.14× |
| document/batch-1000/8000000                        |    630.53 | 508.12 |     0.81× |
| search/regex/1000000                               |      6.99 |  11.29 |     1.61× |
| search/regex/8000000                               |     56.69 |  71.08 |     1.25× |
| document/retain-21-snapshots/8000000               |    115.59 |   4.80 |     0.04× |
| editor-model/insert/multiline/1000000 UTF-16 units |     68.86 |  75.08 |     1.09× |
| autocomplete/single-line-words                     |      2.61 |   7.54 |     2.89× |
| autocomplete/duplicate-words                       |      2.44 |   4.89 |     2.00× |
| autocomplete/unique-words-max20                    |     10.19 |  16.40 |     1.61× |
| autocomplete/oversized-word                        |     21.78 |   8.41 |     0.39× |

Retaining 21 versions of an 8M document adds 305.202 MiB of native-baseline JS heap versus 0.110 MiB in the JS model. This is incremental retained snapshot/history memory after GC, not total editor memory. RSS deltas are retained separately in the raw report.

## Python isolated control

The broad matrix produced two groups of JS Python timings. This isolated workload control retains every broad result and tests the same fixture without preceding large-document workloads.

Five warmups and fifteen samples per fresh process, native/JS/JS/native order. These results remain separate from the broad matrix; no broad samples are discarded.

| Backend    | Edit process medians (ms) |
| ---------- | ------------------------- |
| native     | 245.30, 243.60            |
| javascript | 240.60, 245.00            |

## Current JS with current packages

These numbers include all current core and selected package changes. They must not be divided by historical-package native times to attribute a text-model speedup. The general popup fixture uses timer polling; use the event-based completion report for fine-grained popup latency.

| Scenario                             | Operation |  JS ms | Process medians |
| ------------------------------------ | --------- | -----: | --------------- |
| renderer/plain-1m-markers            | edit      |   3.25 | 3.20, 3.30      |
| renderer/plain-1m-markers            | undo      |   7.60 | 7.50, 7.70      |
| renderer/plain-1m-markers            | redo      |   7.50 | 7.50, 7.50      |
| renderer/plain-8m-markers            | edit      |   5.45 | 5.40, 5.50      |
| renderer/plain-8m-markers            | undo      |  10.45 | 10.40, 10.50    |
| renderer/plain-8m-markers            | redo      |  10.10 | 9.80, 10.40     |
| renderer/plain-32m-markers           | edit      |  11.20 | 11.20, 11.20    |
| renderer/plain-32m-markers           | undo      |  16.35 | 16.20, 16.50    |
| renderer/plain-32m-markers           | redo      |  16.00 | 15.60, 16.40    |
| renderer/soft-wrap-long-lines        | edit      |  10.25 | 10.30, 10.20    |
| renderer/soft-wrap-long-lines        | undo      |   7.35 | 7.20, 7.50      |
| renderer/soft-wrap-long-lines        | redo      |   7.80 | 7.60, 8.00      |
| renderer/single-line-1m              | edit      |  66.75 | 65.80, 67.70    |
| renderer/single-line-1m              | undo      |  63.05 | 61.70, 64.40    |
| renderer/single-line-1m              | redo      |  62.55 | 62.70, 62.40    |
| renderer/multicursor-1000            | edit      | 143.50 | 143.60, 143.40  |
| renderer/multicursor-1000            | undo      | 101.30 | 96.40, 106.20   |
| renderer/multicursor-1000            | redo      | 104.20 | 102.00, 106.40  |
| renderer/multicursor-newline-1000    | edit      | 511.65 | 508.70, 514.60  |
| renderer/multicursor-newline-1000    | undo      | 182.10 | 180.70, 183.50  |
| renderer/multicursor-newline-1000    | redo      | 184.10 | 180.10, 188.10  |
| renderer/multicursor-paste-1000      | edit      | 485.30 | 481.10, 489.50  |
| renderer/multicursor-paste-1000      | undo      | 181.55 | 180.50, 182.60  |
| renderer/multicursor-paste-1000      | redo      | 183.35 | 182.30, 184.40  |
| renderer/multiline-format-js-1000    | edit      |  55.15 | 57.70, 52.60    |
| renderer/multiline-format-js-1000    | undo      |  71.40 | 72.20, 70.60    |
| renderer/multiline-format-js-1000    | redo      |  52.25 | 52.10, 52.40    |
| renderer/multiline-delete-js-1000    | edit      |  41.75 | 41.20, 42.30    |
| renderer/multiline-delete-js-1000    | undo      |  48.50 | 47.10, 49.90    |
| renderer/multiline-delete-js-1000    | redo      |  42.75 | 41.80, 43.70    |
| renderer/multiline-format-html-500   | edit      | 326.55 | 322.40, 330.70  |
| renderer/multiline-format-html-500   | undo      | 369.45 | 360.30, 378.60  |
| renderer/multiline-format-html-500   | redo      | 324.50 | 319.00, 330.00  |
| renderer/paste-1m                    | edit      | 203.85 | 197.70, 210.00  |
| renderer/paste-1m                    | undo      |  66.40 | 64.80, 68.00    |
| renderer/paste-1m                    | redo      | 199.25 | 194.90, 203.60  |
| renderer/javascript-1m               | edit      |  64.15 | 53.90, 74.40    |
| renderer/javascript-1m               | undo      |  61.20 | 54.50, 67.90    |
| renderer/javascript-1m               | redo      |  57.90 | 51.00, 64.80    |
| renderer/ipython-injections          | edit      |   9.85 | 9.10, 10.60     |
| renderer/ipython-injections          | undo      |   8.60 | 7.90, 9.30      |
| renderer/ipython-injections          | redo      |   9.10 | 8.40, 9.80      |
| renderer/buffer-replace-5000         | edit      | 136.00 | 126.80, 145.20  |
| renderer/buffer-replace-5000         | undo      | 168.20 | 158.70, 177.70  |
| renderer/buffer-replace-5000         | redo      | 143.30 | 138.00, 148.60  |
| renderer/search-replace-5000         | edit      | 209.65 | 200.50, 218.80  |
| renderer/search-replace-5000         | undo      | 168.70 | 160.40, 177.00  |
| renderer/search-replace-5000         | redo      | 145.25 | 137.70, 152.80  |
| renderer/search-replace-single-2000  | edit      | 101.75 | 95.00, 108.50   |
| renderer/search-replace-single-2000  | undo      |  61.10 | 57.20, 65.00    |
| renderer/search-replace-single-2000  | redo      |  52.10 | 49.50, 54.70    |
| renderer/format-edits-2000-js        | edit      | 127.95 | 129.50, 126.40  |
| renderer/format-edits-2000-js        | undo      | 125.60 | 125.70, 125.50  |
| renderer/format-edits-2000-js        | redo      | 116.55 | 113.20, 119.90  |
| renderer/format-plan-2000-js         | edit      |  51.00 | 52.60, 49.40    |
| renderer/format-plan-2000-js         | undo      |  48.65 | 46.40, 50.90    |
| renderer/format-plan-2000-js         | redo      |  50.35 | 47.40, 53.30    |
| renderer/format-edits-html-500       | edit      | 352.90 | 347.50, 358.30  |
| renderer/format-edits-html-500       | undo      | 343.70 | 335.50, 351.90  |
| renderer/format-edits-html-500       | redo      | 342.90 | 331.60, 354.20  |
| renderer/format-edits-python-500     | edit      |  40.45 | 38.30, 42.60    |
| renderer/format-edits-python-500     | undo      |  43.15 | 42.20, 44.10    |
| renderer/format-edits-python-500     | redo      |  40.20 | 39.10, 41.30    |
| renderer/sort-lines-10000            | edit      |  29.55 | 33.00, 26.10    |
| renderer/sort-lines-10000            | undo      |  23.20 | 22.50, 23.90    |
| renderer/sort-lines-10000            | redo      |  24.05 | 23.80, 24.30    |
| renderer/autocomplete-popup          | edit      |  12.75 | 12.70, 12.80    |
| renderer/autocomplete-popup          | undo      |   7.55 | 7.20, 7.90      |
| renderer/autocomplete-popup          | redo      |   4.60 | 4.90, 4.30      |
| renderer/whitespace-trim-5000        | edit      |  60.65 | 61.80, 59.50    |
| renderer/whitespace-trim-5000        | undo      |  75.50 | 74.70, 76.30    |
| renderer/whitespace-trim-5000        | redo      |  61.75 | 61.10, 62.40    |
| renderer/whitespace-tabs-5000        | edit      |  66.95 | 64.40, 69.50    |
| renderer/whitespace-tabs-5000        | undo      |  81.90 | 80.20, 83.60    |
| renderer/whitespace-tabs-5000        | redo      |  65.85 | 63.90, 67.80    |
| renderer/python-crlf-1m              | edit      | 238.80 | 234.30, 243.30  |
| renderer/python-crlf-1m              | undo      | 240.85 | 234.80, 246.90  |
| renderer/python-crlf-1m              | redo      | 240.25 | 234.00, 246.50  |
| renderer/html-injections-1m          | edit      |  68.15 | 66.90, 69.40    |
| renderer/html-injections-1m          | undo      |  63.25 | 65.00, 61.50    |
| renderer/html-injections-1m          | redo      |  61.35 | 59.40, 63.30    |
| renderer/html-1000-injections        | edit      |  49.85 | 48.90, 50.80    |
| renderer/html-1000-injections        | undo      |  41.70 | 39.70, 43.70    |
| renderer/html-1000-injections        | redo      |  43.80 | 43.10, 44.50    |
| renderer/json-minified-20000-records | edit      | 326.30 | 334.20, 318.40  |
| renderer/json-minified-20000-records | undo      | 291.65 | 294.80, 288.50  |
| renderer/json-minified-20000-records | redo      | 291.10 | 295.30, 286.90  |
| indent/javascript-2100-rows          | edit      | 106.40 | 95.30, 117.50   |
| indent/javascript-2100-rows          | undo      |  51.80 | 48.40, 55.20    |
| indent/javascript-2100-rows          | redo      |  45.95 | 43.00, 48.90    |
| indent/python-1800-rows              | edit      | 198.95 | 183.10, 214.80  |
| indent/python-1800-rows              | undo      |  36.70 | 33.60, 39.80    |
| indent/python-1800-rows              | redo      |  35.30 | 31.80, 38.80    |
| indent/html-100-injections           | edit      |  75.85 | 74.50, 77.20    |
| indent/html-100-injections           | undo      |  48.15 | 47.10, 49.20    |
| indent/html-100-injections           | redo      |  51.55 | 50.00, 53.10    |
| indent/python-enter-300              | edit      | 117.45 | 117.00, 117.90  |
| indent/python-enter-300              | undo      |  44.15 | 44.50, 43.80    |
| indent/python-enter-300              | redo      |  39.90 | 39.10, 40.70    |

## Current indexed completion with active packages

Final JS, current packages active. Same event-based cold/warm/typing fixture, three warmups and nine samples, two fresh serial processes.

This fixture waits for suggestion-model and DOM events, rather than timer polling. All 20 current packages are activated before fixture setup. These are current JS absolute times, not a native comparison.

| Fixture            | Median ms | Process medians |
| ------------------ | --------: | --------------- |
| repeated-100/cold  |     16.95 | 15.80, 18.10    |
| repeated-100/warm  |      3.10 | 3.10, 3.10      |
| repeated-100/type  |      6.55 | 6.50, 6.60      |
| repeated-6000/cold |     20.40 | 19.20, 21.60    |
| repeated-6000/warm |      3.75 | 3.90, 3.60      |
| repeated-6000/type |      7.80 | 8.00, 7.60      |
| unique-6000/cold   |     33.05 | 33.60, 32.50    |
| unique-6000/warm   |     28.05 | 28.70, 27.40    |
| unique-6000/type   |     27.65 | 28.10, 27.20    |
| window-100000/cold |     21.25 | 23.80, 18.70    |
| window-100000/warm |      3.70 | 3.30, 4.10      |
| window-100000/type |      8.90 | 8.70, 9.10      |

## Validation and limits

Timed fixtures verify resulting text and undo/redo; renderer fixtures additionally verify restored selections/markers, syntax signatures and screen-line counts. Source/package fingerprints remain unchanged through the accepted series. Four processes per backend provide a local comparison, not reliable tail-latency or cross-platform claims. Surrounding core changes are included; this is not a single-variable C++ versus JavaScript experiment.

| Suite               | Specs | Failures | Exit code |
| ------------------- | ----: | -------: | --------: |
| node                |    64 |        0 |         0 |
| core                |  1976 |        0 |         0 |
| autocomplete        |   455 |        0 |         0 |
| bracket-matcher     |   215 |        0 |         0 |
| code-format         |   110 |        0 |         0 |
| highlight-selected  |    37 |        0 |         0 |
| language-css        |    17 |        0 |         0 |
| language-gfm        |    13 |        0 |         0 |
| language-html       |    16 |        0 |         0 |
| language-ipython    |   125 |        0 |         0 |
| language-javascript |    35 |        0 |         0 |
| language-json       |    17 |        0 |         0 |
| language-python     |    44 |        0 |         0 |
| language-regex      |     6 |        0 |         0 |
| language-text       |    12 |        0 |         0 |
| marker              |   105 |        0 |         0 |
| minimap             |    71 |        0 |         0 |
| scrollmap           |    56 |        0 |         0 |
| search-panel        |   145 |        0 |         0 |
| snippets            |   215 |        0 |         0 |
| sort-lines          |    34 |        0 |         0 |
| whitespace          |    56 |        0 |         0 |
| tree-sitter-runtime |    46 |        0 |         0 |

The native reference, final JS snapshot, shared historical packages, current package copies and orchestration scripts are retained under `.dev/js-native-final-20261019/`. The performance runner is `run.cjs`; `validate.cjs` runs regression checks only after performance completes. Production source files were not changed for this measurement.
