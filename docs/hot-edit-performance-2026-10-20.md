# Hot edit path performance

Windows measurements on 2026-10-20 against core `a3dffe3064397f5f30a3c973503bb7dba2987989`, with the same 28 active package sources on both sides. [Raw samples, source fingerprints and validation](../benchmark/results/hot-edit-performance-2026-10-20.json) identify each measured implementation.

This records the optimization stage before the subsequent SOFiSTiK sustained-typing investigation and line-ending metadata changes. Its frozen inputs, rather than the latest working tree, define the measured candidate.

The [subsequent real-document investigation](sofistik-sustained-typing-2026-10-20.md) records sustained keyboard cadence, renderer frames, the SOFiSTiK tree-shape correction and constant-time line-ending metadata.

## Findings

Enter at 1000 cursors falls from 489.15 to 267.55 ms, and multiline insertion from 465.90 to 245.75 ms. These cases disable automatic indentation to isolate editing, history, geometry and package notifications. A separate repeated-Python-Enter case exercises automatic indentation and whitespace cleanup.

The final ranking reduces a warmed request over 6000 unique-name rows from 31.20 to 20.30 ms, and typing plus popup from 32.90 to 25.30 ms. Repeated queries against one retained index take 20.55 versus 17.25 ms after longer warmup. Repeated-word and small-file controls remain in the tables; the change is not a universal latency win.

Ordinary typing controls were slower in the combined round: 100 characters in the large document took 172.05 versus 196.25 ms, and a single character at 1000 cursors took 127.55 versus 157.55 ms. Earlier runs with the same 28 packages measured the latter at 142.50 versus 139.95 ms. These inconsistent controls do not establish an ordinary-typing improvement or isolate a regression's cause; the multiline gains should not be generalized to every hot path.

## Changes

Small row-count changes use the engine array splice operation instead of moving every following slot in a JavaScript loop. Same-size replacements keep direct indexed assignments. Large edits avoid argument-count limits and large discarded removal arrays. Aliased insertion is snapshotted before mutation, fixing the old helper's unbounded-growth failure.

The boolean fold cache is a Map containing queried rows, rather than a document-sized array of mostly empty slots. Invalidation visits cached entries; multiline transactions translate unchanged entries once through the canonical change list. It retains both true and false answers. The cache is sparse, not a fixed-size memory cap.

Word ranking traverses keys directly and keeps only word/score pairs in its bounded heap. It fetches occurrence, distance and position metadata only for final winners. A test with 2000 eligible words in reverse ranking order reads metadata 20 times for 20 results, instead of materializing metadata for every candidate. Scores, tie order, Unicode matching, cancellation and cursor metadata retain their existing contracts.

## Rendering measurement correction

Jasmine forces TextEditorElement updates to be synchronous by default. Earlier active-package renderer measurements inherited that setting and could render on each model notification as well as during the explicit update. Both variants here assert normal scheduled updates and flush after command/grammar completion. This corrects the benchmark harness; production rendering behavior is unchanged. Do not compare these absolute renderer times directly with earlier synchronous-harness reports. The earlier Node-only model measurements and bare-component runs explicitly configured for asynchronous updates are unaffected.

## Method

Row-edit and repeated-key measurements use two fresh processes per variant in before/after/after/before order, three warmups and seven samples per process. Final completion uses the same order with three warmups and nine samples. The retained-index control creates its buffer once, uses 60 warmups and 25 measured requests, and keeps the index throughout. Times are milliseconds, aggregated as the median of process medians. Process medians and every sample are retained; these small process counts do not establish stable tail latency.

Repeated-key timings include grammar settlement and an explicit component update after every key. Per-key figures divide a sequence median by its key count and are not separate per-key latency distributions. Automatic autocomplete activation is disabled in typing fixtures; explicit popup requests are timed separately using suggestion-model and DOM events, not timer polling. Setup, verification, clipboard IPC and physical presentation are excluded. The harness uses Courier at size 16.

The large repeated-key fixture has 32000 rows and approximately one million UTF-16 units. The Python sequence uses real automatic indentation. Fixtures verify final text, undo, cursor/selection restoration, marker ranges and syntax signatures where applicable. Source/dependency/package hashes are checked. No correctness tests run concurrently with accepted timings. This is a local Windows workstation, not cross-platform performance evidence.

The final ranking refinement changes only text-store-search.js after the row-edit round; ranking is not executed in those row-edit cases because automatic completion is disabled. The retained row-edit source hashes match exactly. The final three-file candidate receives another combined Enter/popup/JavaScript integration run and all correctness suites. Intermediate completion controls, including slower measurements that motivated the ranking work, are retained separately and are not pooled into final tables.

## Repeated keys

| Sequence | Before ms | After ms | Before ms/key | After ms/key | Before process medians | After process medians |
|---|---:|---:|---:|---:|---|---|
| type-small-100 | 144.80 | 150.70 | 1.448 | 1.507 | 162.30, 127.30 | 156.90, 144.50 |
| type-large-100 | 172.05 | 196.25 | 1.720 | 1.962 | 161.70, 182.40 | 197.60, 194.90 |
| newline-large-30 | 51.60 | 54.70 | 1.720 | 1.823 | 50.00, 53.20 | 55.10, 54.30 |
| python-indented-enter-30 | 43.10 | 51.10 | 1.437 | 1.703 | 41.90, 44.30 | 48.80, 53.40 |

## Editor commands

| Scenario | Operation | Before ms | After ms | Before process medians | After process medians |
|---|---|---:|---:|---|---|
| plain-1m-markers | edit | 2.05 | 2.10 | 2.10, 2.00 | 2.10, 2.10 |
| plain-1m-markers | undo | 6.60 | 6.45 | 6.40, 6.80 | 6.60, 6.30 |
| plain-1m-markers | redo | 6.60 | 6.30 | 6.30, 6.90 | 6.50, 6.10 |
| multicursor-1000 | edit | 127.55 | 157.55 | 122.50, 132.60 | 147.70, 167.40 |
| multicursor-1000 | undo | 90.55 | 100.75 | 87.60, 93.50 | 101.30, 100.20 |
| multicursor-1000 | redo | 95.05 | 103.70 | 98.80, 91.30 | 107.20, 100.20 |
| multicursor-newline-1000 | edit | 489.15 | 267.55 | 483.20, 495.10 | 279.90, 255.20 |
| multicursor-newline-1000 | undo | 170.40 | 100.20 | 168.50, 172.30 | 106.40, 94.00 |
| multicursor-newline-1000 | redo | 176.95 | 104.95 | 174.60, 179.30 | 111.90, 98.00 |
| multicursor-paste-1000 | edit | 465.90 | 245.75 | 461.10, 470.70 | 261.00, 230.50 |
| multicursor-paste-1000 | undo | 172.50 | 101.85 | 170.00, 175.00 | 106.70, 97.00 |
| multicursor-paste-1000 | redo | 179.55 | 112.35 | 178.70, 180.40 | 117.00, 107.70 |
| javascript-1m | edit | 74.60 | 70.80 | 76.50, 72.70 | 76.30, 65.30 |
| javascript-1m | undo | 69.40 | 69.10 | 69.20, 69.60 | 81.40, 56.80 |
| javascript-1m | redo | 61.20 | 61.70 | 62.40, 60.00 | 69.20, 54.20 |
| python-crlf-1m | edit | 267.05 | 232.95 | 274.60, 259.50 | 224.40, 241.50 |
| python-crlf-1m | undo | 265.70 | 240.30 | 285.90, 245.50 | 233.60, 247.00 |
| python-crlf-1m | redo | 270.60 | 238.35 | 287.10, 254.10 | 225.40, 251.30 |

## Final completion pipeline

| Scenario | Operation | Before ms | After ms | Before process medians | After process medians |
|---|---|---:|---:|---|---|
| repeated-100/cold | sequence | 12.35 | 7.90 | 11.60, 13.10 | 11.30, 4.50 |
| repeated-100/warm | sequence | 2.20 | 2.55 | 2.30, 2.10 | 3.00, 2.10 |
| repeated-100/type | sequence | 4.35 | 4.40 | 5.00, 3.70 | 5.20, 3.60 |
| repeated-6000/cold | sequence | 14.20 | 13.80 | 13.20, 15.20 | 15.00, 12.60 |
| repeated-6000/warm | sequence | 2.50 | 2.50 | 2.70, 2.30 | 2.70, 2.30 |
| repeated-6000/type | sequence | 4.60 | 4.30 | 4.80, 4.40 | 4.30, 4.30 |
| unique-6000/cold | sequence | 32.85 | 32.95 | 34.80, 30.90 | 37.80, 28.10 |
| unique-6000/warm | sequence | 31.20 | 20.30 | 31.10, 31.30 | 20.20, 20.40 |
| unique-6000/type | sequence | 32.90 | 25.30 | 33.40, 32.40 | 22.60, 28.00 |
| window-100000/cold | sequence | 27.50 | 26.35 | 27.30, 27.70 | 25.90, 26.80 |
| window-100000/warm | sequence | 2.80 | 2.80 | 2.90, 2.70 | 2.90, 2.70 |
| window-100000/type | sequence | 6.25 | 6.05 | 6.70, 5.80 | 5.80, 6.30 |

## Repeated requests on one retained unique-word index

| Scenario | Operation | Before ms | After ms | Before process medians | After process medians |
|---|---|---:|---:|---|---|
| unique-6000/warm | sequence | 20.55 | 17.25 | 21.00, 20.10 | 18.80, 15.70 |

## Active packages

autocomplete, bracket-matcher, code-format, highlight-selected, language-css, language-gfm, language-html, language-ipython, language-javascript, language-json, language-python, language-regex, language-text, marker, minimap, scrollmap, search-panel, snippets, sort-lines, whitespace, cursor-history, column-selection, breadcrumbs, spell-check, status-bar, grammar-selector, line-ending, jupyter-cells.

These scenarios exercise selected package integrations. Activation alone does not exercise every feature of each package. Core tests cover wrapping, folds, shared display layers, markers, history, injections and indentation; package suites provide additional behavioral coverage.

## Validation

| Suite | Specs | Failures |
|---|---:|---:|
| node | 112 | 0 |
| core | 1981 | 0 |
| autocomplete | 455 | 0 |
| bracket-matcher | 215 | 0 |
| code-format | 110 | 0 |
| highlight-selected | 37 | 0 |
| language-css | 17 | 0 |
| language-gfm | 13 | 0 |
| language-html | 16 | 0 |
| language-ipython | 125 | 0 |
| language-javascript | 35 | 0 |
| language-json | 17 | 0 |
| language-python | 44 | 0 |
| language-regex | 6 | 0 |
| language-text | 12 | 0 |
| marker | 105 | 0 |
| minimap | 71 | 0 |
| scrollmap | 56 | 0 |
| search-panel | 145 | 0 |
| snippets | 215 | 0 |
| sort-lines | 34 | 0 |
| whitespace | 56 | 0 |
| cursor-history | 54 | 0 |
| column-selection | 75 | 0 |
| breadcrumbs | 81 | 0 |
| spell-check | 151 | 0 |
| status-bar | 50 | 0 |
| grammar-selector | 42 | 0 |
| line-ending | 58 | 0 |
| jupyter-cells | 142 | 0 |

Total: 4530 specs, zero failures.

Reproduction and frozen inputs remain under `.dev/hot-paths-20261020/`: `combined.cjs` measures the editing paths, `release.cjs` measures the final completion implementation and performs final integration checks, and `validate.cjs` tests `release/after`. Use fresh output directories. Earlier profiles and interrupted or intermediate runs remain diagnostics.
