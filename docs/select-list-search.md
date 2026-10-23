# Select-list search

Built-in fuzzy matching uses one Chromium worker per SelectList by default, for both flat and sectioned lists. There is no size threshold or user backend setting. The worker starts with the first nonempty query, is reused for subsequent queries, and is terminated when the source or search configuration changes or the list is destroyed. Empty sources need no worker. Prepared text and normalization are reused across query refinements.

A package whose list is always small can explicitly disable the worker:

```js
const list = lumine.workspace.buildSelectList({
  items: ["LF", "CRLF"],
  search: { worker: false },
});
```

The opt-out prepares candidates on demand and matches synchronously, reusing prepared text across queries. It does not start a worker or schedule background preparation. There are exactly two built-in execution paths: worker and synchronous.

Leave the default enabled for lists that can grow with a project, document, installed packages or user data. The file finders, bibliography entries and similar collections need no explicit opt-in. For worker lists, `search.prepareOnIdle: true` can prepare candidates before the first query when `getFilterText` is pure; this moves preparation earlier rather than eliminating its cost. This option has no effect with `worker: false`.

## Completion and presentation

`await list.setQuery(text)` waits for the current request's results to render. `await list.update({ items })` and the corresponding source setters wait for any filtering they initiate. `await host.show({ query })` waits for source publication and opening-query filtering. Directly changing the mini editor starts filtering but does not return a completion promise; observing one render frame does not imply that matching has finished.

All matches are published together, in the same stable order as synchronous matching. Pagination limits rendered rows, not the result set. Superseded queries and replaced sources cannot publish stale results. During filtering, the previous rows remain on screen and selection, confirmation and actions are disabled. After 250 ms of continuous filtering, a spinner replaces the Actions icon. Subsequent input does not reset that delay or flash an already visible spinner. Source loading retains its separate loading message.

Recent-item changes reorder only the resting list. While a query is active, a history update from another window preserves its results, selected item and pending worker request.

Query and selection observers may synchronously issue another update. The newer request supersedes the earlier request's filtering and initial-selection intent. A successful filtering retry clears the error owned by the previous failed match, including when retrying through `refresh()` or switching to synchronous search; this cleanup preserves a replacement status supplied by the package.

Query-driven sources retain their previous rows while a changed query or replacement source loads, but those rows cannot be navigated or confirmed until the current source publishes item data. Status-only publications do not make old results actionable. Progressive item publications enable the current results immediately, even if the loader continues. Source loading keeps its loading message rather than using the local filtering spinner.

## Immutable source snapshots

A frozen `items` array opts into immutable snapshot semantics: its entries, item IDs and searchable fields must remain unchanged. Publishing that same array again reuses the source records and worker preparation. Publish a new array and new objects for changed entries when the data changes. Ordinary mutable arrays retain replacement semantics, including callers that mutate an array before submitting it again. Public `getItems()` always returns an independent array.

Explicit `refresh()` always invalidates derived records and search text, including when `getFilterText` reads external state that changed while the items remained identical. Snapshot reuse applies to ordinary source publication, not an explicit request to refresh its derived content.

Large snapshot loaders can call `await list.prepareItems(items, {signal})` before returning `{items}`. This requires a frozen array and prepares identity records in bounded renderer batches without publishing them. Item identity callbacks remain in their owning renderer. Cancellation or invalid IDs leave the current list and selection unchanged; a subsequent update consumes the prepared records. This is source preparation, independent of the two search backends. Unchanged records at unchanged source positions are reused across prepared snapshots.

```js
let list;
list = lumine.workspace.buildSelectList({
  getItemId: (item) => item.id,
  source: {
    mode: "snapshot",
    async load({ signal }) {
      const items = await loadImmutableItems(signal);
      await list.prepareItems(items, { signal });
      return { items };
    },
  },
});
```

## Callback ownership

`getFilterText`, score modifiers and custom sort callbacks remain in the owning renderer; arbitrary closures are not serialized into a worker. On the worker path, candidate extraction and score modification use yielding batches. Worker matching, built-in ordering and first-page highlighting run off the UI thread. A custom sort runs after fuzzy ranking and retains the model's callback context and stable tie order; an expensive custom comparator can still block the renderer. With `worker: false`, candidate preparation, matching and these callbacks run synchronously.

Custom `search.filter` or `search.matcher` callbacks and `source.mode: "query"` providers own their filtering and scheduling. The built-in worker does not wrap or replace their implementations.
