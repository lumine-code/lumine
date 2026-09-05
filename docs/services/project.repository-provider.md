# project.repository-provider

Supplies a `Repository` for a filesystem path, so a version-control system other than Git can drive the editor's VCS features.

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
  repositoryForPath(path: string): Promise<Repository | null>;
  getRepositoryForPath?(path: string): Repository | null;
};
```

| Member                       | Description                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repositoryForPath(path)`    | Required. Resolves to the nearest `Repository` that claims a path, or `null`. Filesystem work must be asynchronous.                                          |
| `getRepositoryForPath(path)` | Optional cache-only lookup used while project roots are reconciled. It must return immediately and must never read the filesystem; returning `null` is fine. |

The returned repository should implement `onDidDestroy` — core uses it to drop its cache entry when the repository goes away.

## Minimal example

```js
module.exports = {
  provideProjectRepositoryProvider() {
    return {
      async repositoryForPath(path) {
        const root = await findMyVcsRoot(path);
        return root ? new MyRepository(root) : null;
      },
      getRepositoryForPath(path) {
        return findCachedRepository(path);
      },
    };
  },
};
```

## Behavior

Providers are consulted in **reverse registration order**, so a package that registers later is asked before core's built-in Git provider — which is what lets a package take over a directory Git would also have claimed.

The async path asks **every** provider at once and takes the first non-`null` result, so a slow provider delays the answer even when another has already answered. Core never performs synchronous repository discovery in the renderer.

Results are cached per normalized lexical path. When every provider returns `null` the cache entry is dropped, so a provider registered later still gets a chance at that path.

Registering a provider clears the cache and triggers a rescan, so repositories resolved before your package activated are re-resolved.

## Teardown

Core returns a `Disposable` that removes the provider and clears the cached promises. Repositories you already handed out are not destroyed for you — fire their `onDidDestroy` so core drops them.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
