# Package storage

Core gives each package a package-owned context through `initialize(context)` and `activate(context)`. The handles are ready before either synchronous bootstrap runs and remain shared across that package's module generation.

| Store                    | Ownership                                                                      | Examples                                                        |
| ------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `context.globalState`    | The package and user profile, shared across windows and projects.              | Command history and recently visited settings.                  |
| `context.workspaceState` | The package and current project roots, shared by windows opening that project. | Recent files, search patterns and per-file display preferences. |

An empty project uses its window's persistent identity. Restoring that window restores its project store; opening a different empty window starts with a separate store. Auxiliary editor windows share their owner's package instance and stores.

## API

| Method                       | Contract                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `get(key, defaultValue)`     | Read a detached JSON value synchronously from the loaded cache.                                                   |
| `keys()`                     | Return the stored keys in the package namespace.                                                                  |
| `update(key, value)`         | Store detached JSON data, or delete the key for `undefined`; resolve after commit.                                |
| `mutate(key, updater)`       | Atomically transform the latest committed value with a synchronous updater.                                       |
| `observe(key, callback)`     | Deliver the current value immediately, then deliver committed values and project rebindings; return a disposable. |
| `onDidChange(key, callback)` | Deliver `{oldValue, newValue}` when the value changes; return a disposable.                                       |

Keys are opaque strings within the owning package. Values must be JSON data; they cannot contain cycles, functions, class instances or undefined members. Pass `undefined` to `update()` for deletion. Reading or mutating an object returned by `get()` cannot change the stored value. Storage failures reject writes; observer failures are reported without reversing a successful commit.

```js
module.exports = {
  activate(context) {
    this.context = context;
    context.subscriptions.add(
      context.globalState.observe("recentCommands", (commands) => {
        this.recentCommands = commands ?? [];
      }),
    );
  },

  recordCommand(name) {
    return this.context.globalState.mutate("recentCommands", (commands = []) =>
      [name, ...commands.filter((command) => command !== name)].slice(0, 10),
    );
  },
};
```

## Concurrency and project changes

Use `mutate()` for read-modify-write operations such as an MRU list. Its updater receives the authoritative value inside the write transaction, so independent windows cannot silently lose each other's additions. Keep the updater synchronous and free of side effects. A separate `get()` followed by `update()` intentionally replaces a value and does not provide this concurrency guarantee.

Core publishes committed changes to other windows, which refresh their caches and notify observers. Package code does not open the SQLite database, construct storage paths or publish cross-window messages itself.

Both observation callbacks receive readonly `{scopeChanged}` metadata as their second argument. It is `false` for the initial `observe()` delivery and ordinary commits, and `true` when the workspace handle follows different project roots. `observe()` delivers a scope transition even when the stored values are equal; `onDidChange()` continues to report only value changes. A package that keeps optimistic edits while writes are pending must still apply a scope transition immediately, and must reconcile committed values when its current scope's pending writes finish.

Project changes rebind the project store and notify its observers while retaining the package instance. Outgoing pane teardown finishes before rebinding. A write captures its target project when submitted, so a queued operation cannot drift into a subsequently opened project. For asynchronous work that has not submitted a write yet, capture the intended project and respect the operation's cancellation signal before writing through the current project handle.

## Session recovery

Stores are independent of window snapshots and are never restored from an old snapshot. User-facing settings remain in `lumine.config`; sensitive strings remain in `lumine.secrets`. Unsaved document contents, shared document identities and view layouts use the session recovery contract in [Session state](session-state.md), not these preference stores.
