# repositories.operations-provider

Supplies the _write_ half of version control: commit, stage, branch, clone, and raw Git transport, on top of the read-only repository model.

|             |                                                                |
| ----------- | -------------------------------------------------------------- |
| Version     | `1.0.0`                                                        |
| Provided by | `provideRepositoriesOperationsProvider()` returning a provider |
| Consumed by | core, in `src/repository-registry.js`                          |
| Owner       | the editor itself                                              |

**Nothing provides this today.** Core's repository registry reads state on its own; anything that _changes_ a repository comes through here. A provider can implement as much or as little as it likes, and consumers ask before acting via `canPerformOperation`.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "repositories.operations-provider": {
      "versions": { "1.0.0": "provideRepositoriesOperationsProvider" }
    }
  }
}
```

## Contract

```ts
type OperationsProvider = {
  createRepositoryOperations?(repository: Repository): OperationImplementation;
  initializeRepository?(directoryPath: string): Promise<void>;
  cloneRepository?(url: string, directoryPath: string, options?: object): Promise<void>;
  executeGit?(args: string[], options?: object): Promise<{ stdout: string; stderr: string }>;
  getCapabilities?(): string[];
};
```

**At least one of the four operation members must be a function**, or registration throws a `TypeError`. They split by scope:

| Member                                   | Scope                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `createRepositoryOperations(repository)` | Per-repository operations — stage, commit, branch, push. Called lazily, once per repository. |
| `initializeRepository(path)`             | Workspace-level: create a repository at a path.                                              |
| `cloneRepository(url, path)`             | Workspace-level: clone into a path.                                                          |
| `executeGit(args)`                       | Raw transport, for operations no structured method covers.                                   |
| `getCapabilities()`                      | Extra operation names beyond the standard set, so consumers can discover them.               |

## Minimal example

```js
module.exports = {
  provideRepositoriesOperationsProvider() {
    return {
      createRepositoryOperations(repository) {
        const root = repository.getWorkingDirectory();
        return {
          stagePaths: (paths) => this.run(root, ["add", "--", ...paths]),
          commit: (message) => this.run(root, ["commit", "-m", message]),
          getCapabilities: () => ["stagePaths", "commit"],
        };
      },
      executeGit: (args, options) => this.run(options?.cwd, args),
    };
  },
};
```

## Behavior

Providers are stored **newest first** by default, so a later registration takes precedence. A provider registered with `{ fallback: true }` goes to the end instead — that option is internal to core and not reachable through the service.

`createRepositoryOperations` is called lazily, the first time a repository needs an operation, and the result is cached per repository per provider. Registering a provider fires a change notification so consumers can re-read capabilities.

Capability discovery is the intended way to drive a UI: `canPerformOperation(repository, name)` walks the providers and reports whether anyone implements it, and `getOperationCapabilities(repository)` returns the union of the standard operations that resolve plus whatever each implementation's own `getCapabilities()` adds. Grey out what nothing supports rather than failing at the call.

## Teardown

Core returns a `Disposable` that removes the provider **and** disposes every per-repository implementation it created, then notifies consumers so they can re-read capabilities. A provider does not need to track its own implementations.

Adding a provider to a destroyed registry throws rather than failing quietly.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
