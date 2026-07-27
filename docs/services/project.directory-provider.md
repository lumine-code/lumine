# project.directory-provider

Supplies a custom `Directory` for a project path, so a project folder can be backed by something other than the local filesystem.

|             |                                                          |
| ----------- | -------------------------------------------------------- |
| Version     | `1.0.0`                                                  |
| Provided by | `provideProjectDirectoryProvider()` returning a provider |
| Consumed by | core, in `src/project.js`                                |
| Owner       | the editor itself                                        |

**Nothing provides this today.** It is the entry point for a remote or virtual filesystem: claim a URI scheme, hand back a `Directory`-shaped object, and the tree view, the fuzzy finders, and everything else that walks project folders work against it unchanged.

Core also special-cases this name in `src/package.js`, so a package providing it is wired before the rest of its services.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "project.directory-provider": {
      "versions": { "1.0.0": "provideProjectDirectoryProvider" }
    }
  }
}
```

## Contract

```ts
type DirectoryProvider = {
  directoryForURISync(uri: string): Directory | null;
  directoryForURI?(uri: string): Promise<Directory | null>;
};
```

| Member                     | Description                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `directoryForURISync(uri)` | The `Directory` for a URI you claim, or `null` to decline. **Synchronous, and the only one core calls today.** |
| `directoryForURI(uri)`     | The async form. Accepted for symmetry but not currently consulted.                                             |

The returned object must satisfy the `Directory` interface core relies on — at minimum `getPath()`, `getRealPathSync()`, `contains(path)`, `getEntries(callback)`, and `getSubdirectory(name)`.

## Minimal example

```js
module.exports = {
  provideProjectDirectoryProvider() {
    return {
      directoryForURISync(uri) {
        if (!uri.startsWith("myfs://")) return null;
        return new MyRemoteDirectory(uri);
      },
    };
  },
};
```

## Behavior

Providers are consulted in **reverse registration order** — the newest first — and the first non-`null` answer wins. Declining by returning `null` is the normal path for every URI you do not own, so make the check cheap.

`directoryForURISync` is called while resolving project paths, which happens during window startup and on every folder added. It must not block on I/O; construct a lazy `Directory` and let its own methods do the work.

Core caches nothing here. The same URI may be resolved repeatedly, so returning a fresh object each time is acceptable but wasteful — key your own cache if construction is expensive.

## Teardown

Core returns a `Disposable` that removes the provider from the list. Directories you have already handed out are not reclaimed, so a provider that deactivates should make its `Directory` objects fail gracefully rather than assume they are gone.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
