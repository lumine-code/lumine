# repositories.operations-provider

Supplies the _write_ half of version control: commit, stage, branch, clone, and raw Git transport, on top of the read-only repository model.

|             |                                                                |
| ----------- | -------------------------------------------------------------- |
| Version     | `1.0.0`                                                        |
| Provided by | `provideRepositoriesOperationsProvider()` returning a provider |
| Consumed by | core, in `src/repository-operation-manager.js`                 |
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

If that registration notification fails, core withdraws the attempted registration and cleans up implementations that no remaining registration owns. Registrations of the same provider object share cached implementations until the last registration is removed. Active implementations follow the deferred disposal policy below. Rollback also attempts a change notification so consumers can restore the previous capability set. The original registration failure is rethrown unchanged when rollback succeeds; additional cleanup or notification failures become an `AggregateError`, with the original failure first and as its `cause`.

Raw `executeGit` always returns a Promise, including when the provider returns a synchronous value. Synchronous provider exceptions become rejections with the same error. Core calls the method with the provider as `this` and forwards `args`, `workingDirectory` and `options` unchanged; fulfillment values and rejection reasons keep their identity.

Writes and complete workflows run sequentially for one repository metadata domain. Linked worktrees share that domain; unrelated repositories can run in parallel. Provider selection happens when an operation starts, so a queued operation uses the provider available at that time. The registry emits `did-queue-operation`, `did-start-operation` and `did-finish-operation`; pending state is removed before the finish notification, while repository retention lasts through that notification and final cleanup.

Queue/start observer exceptions reject work before execution without leaving pending state or blocking later writes. Once a write succeeds, finish-observer and deferred-cleanup exceptions are reported separately and never turn its result into a rejected write. A primary execution failure remains unchanged when cleanup succeeds; additional cleanup failures are combined in an `AggregateError` with the primary failure as its cause.

`initialize` and `clone` share a queue for each normalized destination path, so they cannot write to that destination simultaneously. Different destinations can run in parallel. Their pending state and lifecycle events retain the original destination spelling and a `null` repository; operation IDs share the same sequence as per-repository writes. Provider selection happens at execution time, and observer failures follow the same outcome policy as per-repository operations.

After a successful per-repository operation the registry refreshes the repository's read snapshots. The implementation right-sizes that refresh by declaring `getOperationRefreshHint(name, args)`: `"none"` skips it (object-database or unrelated-config writes), `"status"` refreshes the status snapshot, `"refs"` the refs snapshot, `"both"` both. Every requested initialized snapshot is awaited before the operation resolves. Uninitialized snapshots stay lazy. A refs or both hint also refreshes initialized snapshots of registered worktrees sharing the same common metadata directory. A missing, unknown, or throwing hint refreshes both.

The worktree operations (`worktreeAdd`, `worktreeRemove`, `worktreeMove`, `worktreeLock`, `worktreeUnlock`, `worktreePrune`) are the clearest case for `"refs"`: they act on a checkout other than the one the repository represents, so its index and working tree cannot change, while the worktree list the refs snapshot carries always can.

Capability discovery is the intended way to drive a UI: `canPerformOperation(repository, name)` walks the providers and reports whether anyone implements it, and `getOperationCapabilities(repository)` returns the union of the standard operations that resolve plus whatever each implementation's own `getCapabilities()` adds. Grey out what nothing supports rather than failing at the call.

Repository-backed raw commands use `repository.getOperations().executeGit(args, options)`. They are descriptor-bound and share the named-write queue. Mark actual reads with `{readOnly: true}` to avoid mutation refresh and credential prompting. The registry-level `executeGit(args, cwd, options)` routes known repositories to that same queue and serializes unbound commands by destination.

A complete multi-step action uses `repository.getOperations().runWorkflow(name, async operations => { ... }, options)`. The callback receives direct named methods and `executeGit`; they reuse its turn rather than enqueue behind themselves. Options include `signal`, `expectedHead: {name, oid}`, initial `guards`, and `refresh`. Expected HEAD is checked once before the callback, so the workflow can intentionally create a commit and then push it. A later failure after completed steps carries `outcome: "partial"` and `completedSteps`; it must not replay the whole workflow automatically.

Transport loss or cancellation after dispatch of a mutation carries `outcome: "unknown"` and `retriable: false`. Reads can be repeated after worker restart. The worker separately serializes mutation lifetimes until their Git process trees settle, including when the renderer has already cancelled its request. Clean worker retirement drains active operations before a replacement worker accepts writes.

Commit and push protection and force-push confirmation are shared core policy under `git.protectedBranches`, `git.protectCommits`, `git.protectPushes`, and `git.confirmForcePush`. `fetchCurrent`, `pullCurrent`, and `pushCurrent` resolve the current branch, upstream and push target from a fresh refs snapshot inside the write turn. The default pull strategy belongs to `git.pullRebase`.

## Teardown

Core returns a `Disposable` that removes the provider **and** disposes every per-repository implementation it created, then notifies consumers so they can re-read capabilities. A provider does not need to track its own implementations.

An implementation used by an active operation remains alive until its write and required status refresh settle, including its required snapshot refreshes when the provider or registry is removed. Deferred disposal runs once after the last active operation. An implementation returned by a factory whose registration disappeared during creation is disposed immediately and never selected for work.

If an implementation's destructor throws, teardown still attempts the remaining cleanup and change notifications before reporting the error. A single failure is rethrown unchanged; multiple failures become an `AggregateError` with the first failure as its `cause`.

Destroying the registry prevents queued creation operations from starting. When an active provider completes successfully after shutdown, creation rejects with an error saying that the registry has been destroyed and skips subsequent discovery and registration. The same error is returned when discovery finishes after shutdown. Provider and discovery rejections preserve their original failure. Completed Git writes remain on disk.

Adding a provider to a destroyed registry throws rather than failing quietly.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
