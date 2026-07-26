# symbol.provider

A source of symbols — classes, functions, definitions — for one file, for the project, or for a go-to-definition lookup.

|             |                                                               |
| ----------- | ------------------------------------------------------------- |
| Version     | `1.0.0`                                                       |
| Provided by | `provideSymbol()` returning one provider, or an array of them |
| Consumed by | `consumeSymbol(provider)` returning a `Disposable`            |
| Owner       | `symbols-view` (bundled)                                      |

The full contract, with prose on every field, is `lib/main.d.ts` in this package. It is the authoritative version; this page is the summary plus the parts that only show up at runtime.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "symbol.provider": {
      "versions": { "1.0.0": "provideSymbol" }
    }
  }
}
```

Return a provider or an array of them, **unconditionally**. Do not inspect the environment and return nothing: every provider decision belongs in `canProvideSymbols`, which is asked per request, because anything you would inspect at activation can change mid-session.

## Contract

Four members are required. A provider missing any of them is rejected with an `InvalidProviderError` naming the missing fields.

| Member                              | Type                              | Description                                                                                           |
| ----------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `name`                              | string                            | Human-readable. Shown to the user and used to express a preference between providers in the settings. |
| `packageName`                       | string                            | Your package's name, so a user can express a preference for all of its providers at once.             |
| `canProvideSymbols(meta)`           | `boolean \| number \| Promise<…>` | Whether — and how well — you can serve this request. Must not start the work.                         |
| `getSymbols(meta, listController?)` | `Symbol[] \| null \| Promise<…>`  | The symbols. `[]` for "none found", `null` for "cancelled or cannot answer".                          |

Optional:

| Member                         | Description                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isExclusive`                  | `true` marks you as a workhorse provider competing with ctags and Tree-sitter. At most one exclusive provider is chosen per task; supplemental providers all contribute alongside it.    |
| `onShouldClearCache(callback)` | Invoke the callback when your symbols go stale for a reason `symbols-view` cannot see. It already clears on config change, provider activation, grammar change, save, and buffer change. |
| `destroy()`                    | Called on window teardown, or when either package is disabled.                                                                                                                           |

The `meta` bundle carries `type` (`"file"`, `"project"`, or `"project-find"`), the `editor`, an optional `query`, an optional `range`, an `AbortSignal` as `signal`, and sometimes `timeoutMs`.

A symbol needs a `name` and a position — either `position` (a `Point`) or `range` (a `Range`). Everything else (`tag`, `context`, `file`, `directory`, `path`) enriches the presentation.

## Minimal example

```js
module.exports = {
  provideSymbol() {
    return {
      name: "My Symbols",
      packageName: "my-package",
      canProvideSymbols(meta) {
        // File symbols only, and only for the grammar we understand.
        if (meta.type !== "file") return false;
        return meta.editor.getGrammar().scopeName === "source.mylang";
      },
      async getSymbols(meta) {
        const found = await parse(meta.editor.getText());
        if (meta.signal.aborted) return null;
        return found.map((entry) => ({
          name: entry.name,
          tag: entry.kind,
          position: new Point(entry.line, 0),
        }));
      },
    };
  },
};
```

## Behavior

`canProvideSymbols` returns a score, not just a yes. `true` means `1`, `false` means `0`, and **anything above `1` is clamped to `1`** — there is no winning a number war, and the user breaks ties in the settings. Return a lower score when you are a workable fallback rather than the right answer: a provider that reads from disk should score lower for a modified buffer, and one that cannot do go-to-definition should still score low rather than zero for `project-find`.

The three request types want different things. `file` wants every symbol in the buffer. `project` wants an appropriate slice, filtered by `query` or not — `symbols-view` will filter again on the frontend either way, and `getSymbols` is called again on each keystroke. `project-find` is a go-to-definition: return the single answer if you know it.

`meta.signal` aborts when the user closes the UI, types another character, or when you exceed `timeoutMs`. **Check it after every await** and return `null` rather than continuing.

`timeoutMs` is enforced by `symbols-view`, not by you — it is passed so you can choose between searching further and returning what you have. It is present only when the symbol list is not on screen yet; once it is, you may take as long as you like.

`listController` is passed **only to the exclusive provider**, and lets it set `errorMessage`, `emptyMessage`, `loadingMessage`, or `loadingBadge` on the list. Use it to explain an empty result — "query must be at least 3 characters" — rather than leaving the user with a blank panel.

## Teardown

`consumeSymbol` returns a `Disposable` that unregisters the provider and drops its cached symbols. Implement `destroy()` as well if the provider owns anything else.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
