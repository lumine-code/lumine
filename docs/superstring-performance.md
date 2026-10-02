# Superstring integration performance

Measured on 2026-10-02 with Node v24.18.0, Windows x64, and Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz. The editor model comparison uses immutable Lumine source 8b2a2f2 and native superstring revisions 3d785eb → 5d40a32. The later marker comparison measures 5d40a32 → f2b73f4. These stages are separate measurements.

## Method

The editor model ran in four independent processes in baseline, optimized, optimized, baseline order. Each process uses the same archived editor source, frozen benchmark, dependency wrapper and fixtures, with one native build per process. SHA-256 checks guard the source and inputs between runs. Each case has two warmups and nine measured samples per process; the tables pool eighteen samples per build. Setup, explicit garbage collection, spatial-index population, assertions, result consumption and destruction are outside timing. The raw report preserves every per-run median and sample rather than pooling the four process medians.

Each edit has fresh TextBuffer history and, for editor cases, a real TextEditor model with selections and display-layer notifications. Paste uses an in-memory clipboard and disables automatic indentation. Undo and redo restore the large insertion prepared outside timing. Autocomplete uses the editor's TextBuffer API with a twenty-result limit and a six-thousand-row search region for the unique-word fixture. All text sizes count UTF-16 code units: eight million units represent sixteen million bytes of UTF-16 payload, before auxiliary structures.

Earlier editor-before/after-1/2 reports are superseded because the primary editor source changed during those runs. Their timing differences do not support native speedup claims and are excluded from the results below.

## Editor model results

The following operations use an eight-million-unit payload. Paste and replacement go through TextEditor.pasteText; history, selection updates and synchronous display-layer work are included, while DOM rendering and idle indexing are excluded. The raw report also contains one-million-unit cases and standalone TextBuffer measurements.

| Operation and payload | Before (ms) | After (ms) | Speedup |
| --------------------- | ----------: | ---------: | ------: |
| Paste, flat           |      99.207 |     88.514 |   1.12x |
| Replace, flat         |     167.953 |    147.704 |   1.14x |
| Undo, flat            |      48.480 |     44.988 |   1.08x |
| Redo, flat            |      71.927 |     64.882 |   1.11x |
| Paste, multiline      |     478.893 |    468.497 |   1.02x |
| Replace, multiline    |     575.580 |    544.056 |   1.06x |
| Undo, multiline       |      55.450 |     50.622 |   1.10x |
| Redo, multiline       |     425.872 |    412.435 |   1.03x |

| Autocomplete workload | Before (ms) | After (ms) | Speedup |
| --------------------- | ----------: | ---------: | ------: |
| duplicate-words       |       2.745 |      2.937 |   0.93x |
| unique-words-max20    |      14.859 |     10.405 |   1.43x |
| oversized-word        |      65.414 |     20.431 |   3.20x |

These results retain the costs of the editor's JavaScript transactions, normalization and notifications. A native allocation improvement therefore need not produce the same relative improvement in every editor operation. The duplicate-word autocomplete fixture was 7.0% slower in this comparison, so the autocomplete improvement is workload-dependent. The flat and multiline fixtures are synthetic; they do not include language parsing, paste providers, native clipboard transfer or completion UI rendering.

## Marker query profile

The native profile separates marker-ID collection from sorting and deduplication. For the dense whole-document query over ten thousand markers, the instrumented baseline collected 187,353 IDs before reducing them to 10,000 unique IDs. Collection took a median 1.762 ms and sorting/deduplication 3.636 ms. These are native instrumentation estimates, not quantities to subtract from the JavaScript timings.

The optimization collects the union of endpoint IDs when a query begins at the origin and demonstrably covers every endpoint. It preserves sorted results and the historical behavior of duplicate IDs; ordinary viewport queries and finite column bounds on a saturated maximum row use the existing traversal. JavaScript Set conversion still occurs through the public API. Set construction controls are recorded separately and do not run a native query.

The JavaScript comparison repeats both binaries in reversed process order and pools eighteen samples per build. Each sample represents one hundred operations; fixture construction and assertions stay outside timing, and edit cycles share the index. Query-only cases and splice/query/read-ranges cycles are separate. Sparse viewport queries return twenty-one IDs; the dense fixtures stress overlapping markers and are not a typical screenful of independent selections.

| Marker workload                     | Before (ms/op) | After (ms/op) | Speedup |
| ----------------------------------- | -------------: | ------------: | ------: |
| sparse/screen80/10000/query         |          0.004 |         0.004 |   1.01x |
| sparse/all/10000/query              |          1.429 |         1.177 |   1.21x |
| dense/screen80/10000/query          |          0.679 |         0.667 |   1.02x |
| dense/all/10000/query               |          5.053 |         1.252 |   4.03x |
| dense/all/10000/splice-query-ranges |          5.664 |         1.840 |   3.08x |

## Renderer measurement

A separate Electron 44.5.1 measurement uses fixed editor source 8b2a2f2 with installed superstring 5d40a32. It pastes 1,048,576 UTF-16 units into a document of the same size, then exercises undo and redo. Seven samples follow two warmups. Model command time and explicit component.updateSync time are reported separately; the latter includes DOM and layout work and excludes frame paint. This is a single-build measurement with no recorded binary hash, so it is not a before/after comparison and is not pooled with the model comparison.

| Operation | Model command (ms) | Component update (ms) |
| --------- | -----------------: | --------------------: |
| paste     |             37.400 |                 3.300 |
| undo      |              4.400 |                 3.500 |
| redo      |             34.300 |                 3.400 |

## Correctness and evidence

Local integration checks passed: 409 core specs, 27 autocomplete specs, 8 file/document fixture specs and 1 renderer benchmark spec, all with zero failures. The core and autocomplete logs were captured before concurrent editor maintenance; the fixture and renderer checks use the fixed source snapshot. The autocomplete log contains pre-existing grammar/Jasmine warnings, with a final zero-failure summary. The marker-optimized library passed 142 JavaScript specs and 60 native test cases with 115,670 assertions. Every model sample checks resulting text and change-event count; editor samples also check selection restoration. The marker differential check passed 144,503 queries and 118,117 range comparisons over forty deterministic seeds with four hundred operations per seed, including duplicate IDs, limits, removed-ID reuse and saturated coordinates. These are Windows results; they do not establish cross-platform performance.

After installing the final f2b73f4 pin, consumer validation on the fixed source snapshot passed 417 core/file-move specs and 27 autocomplete specs. The final library CI passed on Windows, macOS and Linux; these runs validate correctness rather than cross-platform timing.

The [raw integration report](../benchmark/results/superstring-integration-2026-10-02.json) contains pooled statistics, per-run medians and samples, source and native hashes, native phase records, renderer statistics and test evidence references. Local standalone evidence remains under .dev/superstring-perf; absolute workstation paths are normalized in the published report.

## Reproduce

Save Release native builds as distinct files and use one build per process against one immutable editor checkout. Alternate process order for repeated comparisons; --source selects the archived editor runtime, and --binding overrides superstring before importing editor modules.

```sh
node --expose-gc benchmark/editor-superstring-benchmark.js --source /path/to/fixed-editor --binding /path/to/before.node --output before.json
node --expose-gc benchmark/editor-superstring-benchmark.js --source /path/to/fixed-editor --binding /path/to/after.node --output after.json
npm run test:only -- benchmark/editor-superstring-renderer-spec.js
```

Use --filter to select model cases and --units to change payload sizes; --samples and --warmups control repetition. The renderer benchmark requires the editor's Electron test environment. Neither measurement proves input-to-paint latency or physical monitor presentation.
