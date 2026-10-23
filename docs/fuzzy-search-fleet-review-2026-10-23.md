# Fuzzy search fleet correctness review

This review covers the JavaScript fuzzy-search library, SelectList and all 244 active editor packages in the flat workspace. The source inventory finds 38 direct consumers, including JSX implementations in Settings View and Styleguide. Archived repositories and diagnostic files are excluded. The earlier algorithm and cache fixes are documented in the fuzzy-search library's `docs/review-2026-10-22.md` and `docs/review-round2-2026-10-22.md`.

## Runtime fixes

| Area                                                       | Failure                                                                                                                               | Correction                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SelectList worker updates                                  | A registry observer discarded an aggregate update promise; the list displayed its error but also raised a global unhandled rejection. | Observe internally owned failures immediately while preserving rejection for callers that await the returned promise. The same ownership applies when `setSource()` starts local filtering.      |
| Query sources                                              | Old rows could still be confirmed after the query changed or another source took over at the same query.                              | Associate published items with both the source object and raw query. Disable stale actions until current items arrive; metadata-only publications and recents updates do not authorize old rows. |
| Progressive source publications                            | A publication failed while the loader was still running, before its promise queue was awaited.                                        | Own the rejection immediately and retain it for the loader's normal error reporting and explicit publication callers.                                                                            |
| Observed lists in code-format, latex-tools and typst-tools | Selection restoration after an asynchronous item update could overwrite a newer query or select beyond the filtered results.          | Capture the query, verify it after filtering, and clamp selection against the match count. Avoid an extra unowned asynchronous wrapper for observer refreshes.                                   |
| IDE server lists                                           | Refresh wrappers generated an additional rejected promise when the core list already owned the filtering error.                       | Return the list's promise directly and preserve destroyed-view guards.                                                                                                                           |
| Symbol sources                                             | The source selector still wrote the removed `errorMessage` field, hiding source errors and recovery.                                  | Use the supported status field and clear it on successful recovery.                                                                                                                              |
| Project list windows                                       | Cache notifications refreshed only the main window's list.                                                                            | Update every existing window model, preserving each window's query.                                                                                                                              |
| Build targets                                              | Two unnamed commands acquired the same default name and item ID, preventing the target picker from opening.                           | Retain existing IDs for unique names; distinguish equal labels by normalized target definition, with an occurrence index for identical duplicates. Selection survives reordering.                |
| Settings View                                              | An assertion threw before a failed package update could reject its promise; the update button also had no rejection observer.         | Reject operational failures normally, preserve the existing error notification, and observe failures from button events.                                                                         |

The query-source path retains its loading message. Local worker filtering retains the previous rows and its existing delayed spinner. The changes do not truncate match results, introduce a new backend, or change the default per-list worker policy.

## Regression quality

The new tests reproduce failures before the fixes, including actual browser `unhandledrejection` events rather than only inspecting rejected promises. They cover replacement sources, newer queries, progressive publication, independent windows, duplicate targets, recovery and explicit callers that await failure.

The fleet run also exposed fixture defects. Bib-finder tests now wait until reads actually start before cancelling or rejecting them. Hyperclick and Symbol use a complete real clock instead of mixing native `setTimeout` with mocked cancellation. The tree-view repository fake now implements the status snapshot contract used by its real view. ESLint's containment test still runs the real worker and engine but chooses a controlled ESLint installation rather than invoking global npm discovery. Notifications creates its deliberately rejected clipboard promise when the write is called, preventing a premature unhandled rejection. No timeout was increased to make these corrections pass.

## Validation and limits

The initial Windows fleet sweep ran all 244 package suites: 19422 declared specs, 19368 executed and 54 pending. Seven suites had assertion failures, including timeouts under concurrent test load; five more had runtime-error log records despite successful Jasmine summaries. Failed suites were rerun separately, genuine runtime and fixture failures were corrected, and expected negative-test exceptions were classified by exact fixture. The initial failures remain in the audit evidence.

The final core regression run passes 405 specs, covering SelectList, synchronous and worker matching, sources, recents, input dialogs, actions and modal flows. The library passes 163 specs. The focused source-replacement regression failed before its ownership fix and passes in the combined core run.

The final direct-consumer sweep passes all 36 originally enumerated suites: 6812 declared specs, 6807 executed and five pending. Together with the corrected Settings View run (568), the supplemental Styleguide run (48), and the subsequent Project List regression (97, replacing 96), all 38 direct consumers have passing evidence: 7424 executed specs and five pending. The latest completed attempt for each of the 244 packages totals 19383 executed specs and 54 pending, with zero assertion failures. This combined matrix spans recorded core revisions; it is not a claim that all 244 were rerun at one final commit. Its 27 runtime-error records belong exclusively to the exact deliberate Autosave and Notifications fixtures.

Project List's first Windows CI run exposed a fixture race in the row-listener cleanup check. A source refresh superseded an outstanding query; the cancelled query promise resolved while replacement filtering still displayed the old rows. The controlled reproduction confirmed that clicks could not invoke actions during filtering and listeners were removed when the row actually retired. The test now waits for observable retirement before checking detached-row listeners; a deterministic overlapping-refresh regression preserves this distinction without changing core cancellation semantics or increasing timeouts.

Local runs leave `CI` unset and use isolated homes with source package checkouts. The package matrix records package and core revisions, hashes before and after each run, errors, pending reasons and follow-up attempts. Historical hashes omitted JSX; the corrected inventory and current full hashes include it, without retroactively claiming coverage of historical JSX bytes. Concurrent unrelated changes remain separately identifiable.

The 54 pending specs are retained explicitly: language-server integration groups and isolated Python or notebook checks. Passing local runs do not establish that those tests ran or establish cross-platform CI. Autosave and Notifications deliberately exercise exception reporting; their exact negative fixtures remain visible in the raw logs rather than being erased by a generic error allowlist.

Local reproducible evidence is in `.dev/fuzzy-fleet-review-20261023`: `review.cjs`, `results-*.json`, individual logs, `audit-matrix.json` and `audit-draft.md`. Run `regenerate-audit.cjs` there to rebuild the matrix from completed attempts. The matrix does not double-count repeated suites as additional coverage.

## Published package validation

The following CI runs completed successfully and were checked with `gh run watch --exit-status`. Rows marked descendant validate a later commit containing the reviewed change; they do not reinterpret an earlier cancelled or failed run as successful. Project List's earlier Windows failure is preserved in run `39963163369`; its corrected regression is validated below.

| Repository     | Validated revision                 | CI                                                                                    |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| code-format    | `b8f8b00`                          | [39963135482](https://github.com/lumine-code/code-format/actions/runs/39963135482)    |
| latex-tools    | `8d17ea1`                          | [39963141813](https://github.com/lumine-code/latex-tools/actions/runs/39963141813)    |
| typst-tools    | `10c8216`                          | [39963149877](https://github.com/lumine-code/typst-tools/actions/runs/39963149877)    |
| symbol         | `e7caa17`                          | [39963156725](https://github.com/lumine-code/symbol/actions/runs/39963156725)         |
| project-list   | `12e4714`                          | [39965021086](https://github.com/lumine-code/project-list/actions/runs/39965021086)   |
| build          | `a60b9a4`                          | [39963169315](https://github.com/lumine-code/build/actions/runs/39963169315)          |
| bib-finder     | `8a3c68c`                          | [39963175003](https://github.com/lumine-code/bib-finder/actions/runs/39963175003)     |
| hyperclick     | `010928e`                          | [39963182049](https://github.com/lumine-code/hyperclick/actions/runs/39963182049)     |
| settings-view  | `cd6e72d`                          | [39963188339](https://github.com/lumine-code/settings-view/actions/runs/39963188339)  |
| notifications  | `d198d5e`                          | [39963195644](https://github.com/lumine-code/notifications/actions/runs/39963195644)  |
| ide-eslint     | `febf744`                          | [39963202730](https://github.com/lumine-code/ide-eslint/actions/runs/39963202730)     |
| tree-view      | `0ece1e8`                          | [39963211056](https://github.com/lumine-code/tree-view/actions/runs/39963211056)      |
| ide            | `f7119ea`, descendant of `e019d29` | [39963456279](https://github.com/lumine-code/ide/actions/runs/39963456279)            |
| fuzzy-files    | `00c5520`, descendant of `522bfee` | [39900251843](https://github.com/lumine-code/fuzzy-files/actions/runs/39900251843)    |
| fuzzy-explorer | `a4091fa`, descendant of `7b0121d` | [39898988695](https://github.com/lumine-code/fuzzy-explorer/actions/runs/39898988695) |
| fuzzy-search   | `af482c7`, descendant of `817594f` | [39897463610](https://github.com/lumine-code/fuzzy-search/actions/runs/39897463610)   |
