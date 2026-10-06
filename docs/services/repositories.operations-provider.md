# repositories.operations-provider

Supplies the _write_ half of version control: commit, stage, branch, clone, and raw Git transport, on top of the read-only repository model.

|             |                                                                |
| ----------- | -------------------------------------------------------------- |
| Version     | `1.0.0`                                                        |
| Provided by | `provideRepositoriesOperationsProvider()` returning a provider |
| Consumed by | core, in `src/repository-registry.js`                          |
| Owner       | the editor itself                                              |

The registry routes repository writes through operation providers. A provider can implement as much or as little as it likes, and consumers ask before acting via `canPerformOperation`.

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
  createRepositoryOperations?(context: {
    repository: Repository;
    workingDirectory: string;
    gitDirectory: string | null;
  }): OperationImplementation;
  initializeRepository?(directoryPath: string, options?: object): Promise<void>;
  cloneRepository?(url: string, directoryPath: string, options?: object): Promise<void>;
  executeGit?(
    args: string[],
    workingDirectory: string,
    options?: object,
  ): Promise<{ stdout: string; stderr: string }>;
};

type OperationImplementation = {
  getCapabilities?(): string[];
  getOperationRefreshHint?(name: string, args: unknown[]): "none" | "status" | "refs" | "both";
  destroy?(): void;
  // ...plus one async method per supported operation (stageFiles, commit, …).
};
```

**At least one of the four operation members must be a function**, or registration throws a `TypeError`. They split by scope:

| Member                                | Scope                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `createRepositoryOperations(context)` | Per-repository operations — stage, commit, branch, push, worktree. Called lazily, once per repository and provider. |
| `initializeRepository(path)`          | Workspace-level: create a repository at a path.                                                                     |
| `cloneRepository(url, path)`          | Workspace-level: clone into a path.                                                                                 |
| `executeGit(args)`                    | Raw transport, for operations no structured method covers.                                                          |

## Minimal example

```js
module.exports = {
  provideRepositoriesOperationsProvider() {
    return {
      createRepositoryOperations({ workingDirectory: root }) {
        return {
          stageFiles: (paths) => this.run(root, ["add", "--", ...paths]),
          commit: (message) => this.run(root, ["commit", "-m", message]),
          getCapabilities: () => ["stageFiles", "commit"],
        };
      },
      executeGit: (args, root, options) => this.run(root, args, options),
    };
  },
};
```

## Behavior

Providers are stored **newest first** by default, so a later registration takes precedence. A provider registered with `{ fallback: true }` goes to the end instead — that option is internal to core and not reachable through the service.

`createRepositoryOperations` is called lazily, the first time a repository needs an operation, and the result is cached per repository per provider. Registering a provider fires a change notification so consumers can re-read capabilities.

Writes to one repository run sequentially, while writes to different repositories can run in parallel. Provider selection happens when an operation starts, so a queued operation uses the provider available at that time. The registry emits `did-queue-operation`, `did-start-operation` and `did-finish-operation`; pending state is removed before the finish notification, while repository retention lasts through that notification and final cleanup.

Observer exceptions reject the affected operation without leaving pending state or blocking later writes. A finish observer or cleanup can fail after a write has already completed; callers must distinguish that outcome before retrying. A primary failure remains unchanged when cleanup succeeds. Additional completion failures are combined in an `AggregateError`, with the primary failure first and as its `cause`.

`initialize` and `clone` share a queue for each normalized destination path, so they cannot write to that destination simultaneously. Different destinations can run in parallel. Their pending state and lifecycle events retain the original destination spelling and a `null` repository; operation IDs share the same sequence as per-repository writes. Provider selection happens at execution time, and observer failures have the same cleanup and error-preservation behavior as per-repository operations.

After a successful per-repository operation the registry refreshes the repository's read snapshots. The implementation right-sizes that refresh by declaring `getOperationRefreshHint(name, args)`: `"none"` skips it (object-database or unrelated-config writes), `"status"` refreshes the status snapshot, `"refs"` the refs snapshot, `"both"` both. The status refresh is awaited — a `"status"`/`"both"` operation resolves with a fresh status snapshot — while the refs refresh always runs detached, so code that needs post-operation refs must subscribe to `onDidChangeRefsSnapshot` rather than read synchronously after the await. A missing, unknown, or throwing hint refreshes both.

The worktree operations (`worktreeAdd`, `worktreeRemove`, `worktreeMove`, `worktreeLock`, `worktreeUnlock`, `worktreePrune`) are the clearest case for `"refs"`: they act on a checkout other than the one the repository represents, so its index and working tree cannot change, while the worktree list the refs snapshot carries always can.

Capability discovery is the intended way to drive a UI: `canPerformOperation(repository, name)` walks the providers and reports whether anyone implements it, and `getOperationCapabilities(repository)` returns the union of the standard operations that resolve plus whatever each implementation's own `getCapabilities()` adds. Grey out what nothing supports rather than failing at the call.

## Teardown

Core returns a `Disposable` that removes the provider **and** disposes every per-repository implementation it created, then notifies consumers so they can re-read capabilities. A provider does not need to track its own implementations.

An implementation used by an active operation remains alive until its write and required status refresh settle, including when the provider or registry is removed. Deferred disposal runs once after the last active operation. An implementation returned by a factory whose registration disappeared during creation is disposed immediately and never selected for work.

If an implementation's destructor throws, teardown still attempts the remaining cleanup and change notifications before reporting the error. A single failure is rethrown unchanged; multiple failures become an `AggregateError` with the first failure as its `cause`.

Destroying the registry prevents queued creation operations from starting. When an active provider completes successfully after shutdown, creation rejects with an error saying that the registry has been destroyed and skips subsequent discovery and registration. The same error is returned when discovery finishes after shutdown. Provider and discovery rejections preserve their original failure. Completed Git writes remain on disk.

Adding a provider to a destroyed registry throws rather than failing quietly.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
