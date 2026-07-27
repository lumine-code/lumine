# project.repository-provider

Supplies a `Repository` for a project directory, so a version-control system other than Git can drive the editor's VCS features.

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| Version     | `1.0.0`                                                   |
| Provided by | `provideProjectRepositoryProvider()` returning a provider |
| Consumed by | core, in `src/project.js`                                 |
| Owner       | the editor itself                                         |

**Nothing provides this today.** Core registers its own Git provider first; this service is how Mercurial, Subversion, or a remote VCS would supply the same thing. Everything that reads repository state — the gutter, the tree view's status colouring, the status-bar tiles — goes through whatever comes back.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "project.repository-provider": {
      "versions": { "1.0.0": "provideProjectRepositoryProvider" }
    }
  }
}
```

## Contract

```ts
type RepositoryProvider = {
  repositoryForDirectory(directory: Directory): Promise<Repository | null>;
  repositoryForDirectorySync?(directory: Directory): Repository | null;
};
```

| Member                                  | Description                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `repositoryForDirectory(directory)`     | Required. Resolves to a `Repository` for a directory you claim, or `null`.              |
| `repositoryForDirectorySync(directory)` | Optional. The synchronous form, used where core cannot await. Returning `null` is fine. |

The returned repository should implement `onDidDestroy` — core uses it to drop its cache entry when the repository goes away.

## Minimal example

```js
module.exports = {
  provideProjectRepositoryProvider() {
    return {
      async repositoryForDirectory(directory) {
        const root = await findMyVcsRoot(directory.getPath());
        return root ? new MyRepository(root) : null;
      },
      repositoryForDirectorySync(directory) {
        const root = findMyVcsRootSync(directory.getPath());
        return root ? new MyRepository(root) : null;
      },
    };
  },
};
```

## Behavior

Providers are consulted in **reverse registration order**, so a package that registers later is asked before core's built-in Git provider — which is what lets a package take over a directory Git would also have claimed.

The async path asks **every** provider at once and takes the first non-`null` result, so a slow provider delays the answer for that directory even when another has already answered. The sync path stops at the first non-`null`.

Results are cached per real path. When every provider returns `null` the cache entry is dropped, so a provider registered later still gets a chance at that directory.

Registering a provider clears the cache and triggers a rescan, so repositories resolved before your package activated are re-resolved.

## Teardown

Core returns a `Disposable` that removes the provider and clears the cached promises. Repositories you already handed out are not destroyed for you — fire their `onDidDestroy` so core drops them.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
