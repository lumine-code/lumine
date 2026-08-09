# workspace.search-provider

Replaces the built-in project search for directories a package understands better than ripgrep can.

|             |                                                         |
| ----------- | ------------------------------------------------------- |
| Version     | `1.0.0`                                                 |
| Provided by | `provideWorkspaceSearchProvider()` returning a searcher |
| Consumed by | core, in `src/workspace.js`                             |
| Owner       | the editor itself                                       |

**Nothing provides this today.** It is an open extension point: a remote filesystem, a database-backed project, or an index a package maintains can answer `lumine.workspace.scan` for its own directories while ripgrep keeps handling the rest.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "workspace.search-provider": {
      "versions": { "1.0.0": "provideWorkspaceSearchProvider" }
    }
  }
}
```

Core consumes this directly on the service hub rather than through a package, so there is no consumer package to install and nothing to check for.

## Contract

```ts
type DirectorySearcher = {
  canSearchDirectory(directory: Directory): boolean;
  search(
    directories: Directory[],
    regex: RegExp,
    options: SearchOptions,
  ): Promise<void> & {
    cancel(): void;
  };
};
```

| Member                                | Description                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `canSearchDirectory(directory)`       | Whether you claim this directory. Called once per project root, per search.              |
| `search(directories, regex, options)` | Runs the search. Returns a promise that resolves when finished and carries a `cancel()`. |

`options` as core builds it:

| Option                                                | Description                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `inclusions`                                          | Path globs to restrict to; `[]` means everything.                                   |
| `includeHidden`                                       | Always `true`.                                                                      |
| `excludeVcsIgnores`, `exclusions`, `follow`           | From `core.excludeVcsIgnoredPaths`, `core.ignoredNames`, and `core.followSymlinks`. |
| `leadingContextLineCount`, `trailingContextLineCount` | Context lines the caller asked for.                                                 |
| `PCRE2`                                               | Whether the caller wants PCRE2 semantics.                                           |
| `didMatch(result)`                                    | Call with `{ filePath, matches }` for each file that matched.                       |
| `didError(error)`                                     | Call on failure.                                                                    |
| `didSearchPaths(count)`                               | Call with a running count so the UI can show progress.                              |

## Minimal example

```js
module.exports = {
  provideWorkspaceSearchProvider() {
    return {
      canSearchDirectory: (directory) => directory.getPath().startsWith("myfs://"),
      search(directories, regex, options) {
        let cancelled = false;
        const promise = (async () => {
          for (const directory of directories) {
            for await (const file of this.walk(directory)) {
              if (cancelled) return;
              const matches = this.match(file, regex);
              if (matches.length) options.didMatch({ filePath: file.path, matches });
              options.didSearchPaths(1);
            }
          }
        })().catch(options.didError);
        promise.cancel = () => (cancelled = true);
        return promise;
      },
    };
  },
};
```

## Behavior

Providers are consulted in **reverse registration order** — the most recently registered is asked first — and the first one whose `canSearchDirectory` returns `true` claims that directory. Ripgrep is the fallback for everything unclaimed, so a search across a mixed project runs several searchers at once and core unifies their results.

`search` is called **once per directory**, not once per searcher, because each root may carry different `inclusions`. Do not assume a single call covers your whole claim.

Core filters your matches: a result for a file with unsaved changes is dropped and re-searched against the buffer instead, so you do not need to know about modified buffers.

The returned promise **must carry a `cancel()`**. Core calls it when the user cancels a search, and a promise without it leaves work running.

## Teardown

Core keeps a plain array of searchers and does not currently dispose them, so a provider is registered for the life of the window. Nothing is torn down on your behalf.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
