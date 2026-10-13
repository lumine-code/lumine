# Handling URIs

Lumine can receive `lumine://` links from a browser, script, or another application. A package can use one to open its own screen or prepare an action for the user to confirm.

## How it works

Installed builds can register the `lumine://` scheme automatically on Windows and macOS. On Linux or another desktop integration, forward the URI to `lumine --uri-handler`. The editor routes the URI's host to the package with that exact `name`.

Treat every URI as untrusted external input. Validate its path and arguments, and never install or delete content, run a command, or write data on the user's behalf without an explicit confirmation.

## Declaring a handler in your package

Add a `uriHandler` entry to `package.json` naming the method to call:

```json
{
  "name": "my-package",
  "uriHandler": {
    "method": "handleURI"
  }
}
```

Then implement that method on your package's main module:

```js
module.exports = {
  handleURI(parsed, rawURI) {
    if (parsed.pathname !== "/open-thing") return;
    const id = String(parsed.query.id || "");
    if (!id) return;
    // Show what will happen and ask the user to confirm it.
  },
};
```

`lumine://my-package/open-thing?id=42` calls the handler on the package's already-bootstrapped module with an object shaped like Node's legacy `url.parse(uri, true)` result, followed by the raw URI string. Keep expensive URI work behind a package-owned lazy function if the handler is not used during normal startup.

The `settings-view` package is a working example: `lumine://settings-view/show-package?package=tree-view` reaches its handler, which opens the internal workspace URI `lumine://config/packages/tree-view`.

## From the command line

The `lumine` command accepts `--uri-handler` so desktop integration can forward one `lumine://` link to a running window.

## Workspace openers and preview reuse

`lumine.workspace.addOpener()` handles internal workspace URIs and file paths. Its optional second argument lets a viewer replace the document in an existing pending item:

```js
const registration = lumine.workspace.addOpener(
  (uri) => (supportsURI(uri) ? new Viewer(uri) : undefined),
  {
    canReusePendingItem: (item, uri) => item instanceof Viewer && supportsURI(uri),
    reusePendingItem: (item, uri, options, { signal }) => item.openDocument(uri, { signal }),
  },
);
```

The workspace checks reuse at that opener's usual position in the registration order, after looking for an already open URI. It offers only an unmodified pending item in the same destination pane, for an opening with `pending: true` that does not request a split or `activateItem: false`. Permanent tabs and incompatible items follow ordinary opening behavior.

`canReusePendingItem(item, uri, options)` is synchronous and has no side effects. `reusePendingItem(item, uri, options, { signal })` returns a Promise; resolving `false` declines reuse without changing the item, while any other resolved value accepts it. Prepare the new document before committing, preserve the previous document on failure, and check `signal.aborted` before changing the item. A newer opening, keeping the pending tab, closing it or moving it cancels an unfinished reuse. Throwing an `AbortError` also cancels the opening when the viewer's own navigation or reload supersedes it; other errors reject the opening. The normal successful-open events and hooks still run for a reused item.

A viewer whose URI can change exposes `onDidChangeURI(callback)`, returning a disposable subscription. Emit after committing the new document, together with the existing path, title and file-state notifications that changed. The workspace reads `getURI()` and publishes `onDidChangePaneItemURI(callback)` with `{ item, pane, oldURI, newURI }`. Consumers use this event when their context follows the resource inside an item, rather than only reacting to a different active item. Reuse preserves item and view identity and emits neither an item-add nor an item-destroy event.

Openers create or reuse resource items; explicit copying uses the item's optional `copy({ signal })` method. Copying silently skips when it is absent or the optional `canCopy()` returns false. See [Pane items](pane-items.md) for shared pane operations and ownership rules.
