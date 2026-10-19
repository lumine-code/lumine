# Completion pipeline performance

Local Windows measurements on 2026-10-19 compare completion before and after moving external-provider ranking and label highlights into the shared JavaScript completion model. Both variants already use the JavaScript text buffer. This is not a new JS-buffer versus Superstring comparison. The [raw report](../benchmark/results/completion-pipeline-2026-10-19.json) retains all samples, process medians, native call counts, source hashes and benchmark hashes.

## Results

Times below are milliseconds, reported as the median of two process medians. The popup measurement runs the real autocomplete package, command, provider merge, view and layout. Providers are synthetic in-process providers, not live language servers.

| Popup scenario                                                 | Before | After |
| -------------------------------------------------------------- | -----: | ----: |
| Buffer words, 6000 rows                                        |  22.35 | 22.05 |
| 1000 external suggestions, fresh objects with repeated labels  |   5.90 |  5.35 |
| 10000 external suggestions, fresh objects with repeated labels |  30.55 | 25.65 |
| 1000 external suggestions, changing labels                     |  23.50 | 22.20 |
| 10000 external suggestions, changing labels                    |  42.00 | 38.85 |

The default word popup is effectively unchanged in this run. It already bypassed native fuzzy ranking; attributing its earlier latency to a second native matching pass would be incorrect. External-provider popup medians improve, but the 10000-changing case has overlapping process medians: 46.60/37.40 before and 36.10/41.60 after. These measurements do not establish a reliable percentage gain for every request.

| Isolated matching scenario         | Before |  After |
| ---------------------------------- | -----: | -----: |
| Cold rank, 100 candidates          |  0.257 |  0.334 |
| Cold rank, 1000 candidates         |  2.089 |  2.343 |
| Cold rank, 10000 candidates        | 21.208 | 20.222 |
| Repeated rank, same 10000 objects  | 20.038 |  4.374 |
| Repeated rank, 10000 fresh objects | 22.430 | 21.764 |
| Extended query, 10000 candidates   |  8.662 |  0.670 |
| Cold highlights, 20 labels         |  0.231 |  0.092 |
| Re-rendered highlights, 20 labels  |  0.228 |  0.006 |

Reuse and compatible query extension produce the strongest improvements. Small cold lists are slightly slower, and the bounded query cache cannot retain every label in a 10000-item list. The change also deliberately replaces path-oriented native scoring with the buffer-word scoring policy, so these results compare complete implementations rather than isolating the cost of crossing the JS/native boundary. Autocomplete ranking and highlighting make zero native matcher calls in every measured after sample; other application surfaces still use the generic native matcher.

For 6000 repeated-word rows, the compact buffer API reduces serialized result size from 732779 to 706 bytes. Query latency is 4.84 ms versus 5.49 ms for the previous legacy API, with overlapping process variation. For 6000 unique-word rows, compact output is larger (3141 versus 2061 bytes) because it adds summary metadata, and timing is effectively unchanged (7.05 versus 7.03 ms). Serialized size is an output-shape metric, not a measurement of retained heap or allocation volume.

## Method and limitations

Each layer runs four fresh processes in before/after/after/before order. The UI uses three warmups and nine samples per scenario per process; the isolated Node model uses five warmups and fifteen samples. Node forces GC after rank setup outside the timed region. Cold cases use a new matching owner; repeated and fresh-object cases explicitly retain it. Changing-label UI cases prevent cross-request text-cache reuse. Inputs, eligible results and highlight characters are checked outside timing. Exact runtime versions and source identities are included in the raw report.

The UI waits for model item changes and a MutationObserver confirming the current first suggestion in the DOM, then performs layout. It does not poll with timers. The separate twoFrames metric waits for two animation-frame callbacks and does not prove physical presentation. Earlier popup measurements in the [fleet report](javascript-document-fleet-performance-2026-10-19.md) used timer polling and should not be used to attribute small latency differences to native calls. Pilot polling runs are excluded here.

The source hashes match between the model and UI layers. The measured after sources include core commit `56068cb6` and autocomplete commit `127021c`; the before snapshot is identified by its frozen source hashes because its HEAD was not recorded. These measurements precede the separate collapse-blank-lines fix. No CI wait was involved.

Correctness validation includes 2069 passing specs across autocomplete, autocomplete-lumine, ide, snippets and spell-check. After the final cursor-snapshot and normalized-match-flag refinements, 46 core tests and 43 focused completion/provider specs passed, followed by these UI measurements. The full consumer sweep was not repeated after those final refinements.

## Direction

Keep match ownership in the completion model and consume its lazy highlights in the view. Keep compact buffer summaries and explicit cancellation. The evidence does not justify blaming default-word latency on fuzzy-native or claiming a universal JS speed advantage. A persistent word index or a document-synchronized worker is the next architecture to investigate if profiling shows buffer scanning dominating real requests; cold ranking and popup layout remain separate targets.
