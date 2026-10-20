# Select-list search

Built-in fuzzy matching uses one Chromium worker per SelectList by default, for both flat and sectioned lists. There is no size threshold or user backend setting. The worker starts with the first nonempty query, is reused for subsequent queries, and is terminated when the source or search configuration changes or the list is destroyed. Empty sources need no worker. Prepared text and normalization are reused across query refinements.

A package whose list is always small can explicitly disable the worker:

```js
const list = lumine.workspace.buildSelectList({
  items: ["LF", "CRLF"],
  search: { worker: false },
});
```

Leave the default enabled for lists that can grow with a project, document, installed packages or user data. The file finders, bibliography entries and similar collections need no explicit opt-in. `search.prepareOnIdle: true` can prepare candidates before the first query when `getFilterText` is pure; this moves preparation earlier rather than eliminating its cost.

## Completion and presentation

`await list.setQuery(text)` waits for the current request's results to render. `await list.update({ items })` and the corresponding source setters wait for any filtering they initiate. `await host.show({ query })` waits for source publication and opening-query filtering. Directly changing the mini editor starts filtering but does not return a completion promise; observing one render frame does not imply that matching has finished.

All matches are published together, in the same stable order as synchronous matching. Pagination limits rendered rows, not the result set. Superseded queries and replaced sources cannot publish stale results. During filtering, the previous rows remain on screen and selection, confirmation and actions are disabled. After 250 ms of continuous filtering, a spinner replaces the Actions icon. Subsequent input does not reset that delay or flash an already visible spinner. Source loading retains its separate loading message.

Recent-item changes reorder only the resting list. While a query is active, a history update from another window preserves its results, selected item and pending worker request.

## Callback ownership

`getFilterText`, score modifiers and custom sort callbacks remain in the owning renderer; arbitrary closures are not serialized into a worker. Candidate extraction and score modification use yielding batches. Worker matching, built-in ordering and first-page highlighting run off the UI thread. A custom sort runs after fuzzy ranking and retains the model's callback context and stable tie order; an expensive custom comparator can still block the renderer.

Custom `search.filter` or `search.matcher` callbacks and `source.mode: "query"` providers own their filtering and scheduling. The built-in worker does not wrap or replace their implementations. A list with `worker: false` may explicitly request cooperative main-thread matching using `yieldToInput: true`; this yields for large built-in searches but is not needed with the default worker.
