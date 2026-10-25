# Working with repositories

The editor owns repository discovery, identity, lifetime, snapshots and serialized operations through [`lumine.repositories`](https://lumine-code.github.io/api/#class-repositoryregistry). Git commands and output parsing run in the Git host worker. Packages own their presentation, drafts, selections and other user-interface state.

The public [RepositoryRegistry](https://lumine-code.github.io/api/#class-repositoryregistry) and [GitRepository](https://lumine-code.github.io/api/#class-gitrepository) references document the core API. Provider interfaces are described by [repositories.operations-provider](services/repositories.operations-provider.md).

## Choose the command context

A repository command follows the selected repository, including a pinned selection. A file command follows the non-mini editor that originated the dispatch event, falling back to the active editor. Capture the context before awaiting or opening a dialog.

```js
const context = lumine.repositories.getCommandContext(event, { scope: "file" });
const repository =
  context.repository || (context.path && (await lumine.repositories.resolveForPath(context.path)));
if (!repository) return;
```

Use `scope: "repository"` for commit, branch and remote actions. Do not fall back to the first unrelated repository when a file belongs to none.

## Observe a changing file

`getForPath(path)` is a cache-only lookup. `resolveForPath(path)` can discover and register a repository. Discovery does not imply that a status or refs snapshot has loaded.

```js
const subscription = lumine.repositories.observeForPath(
  () => editor.getPath(),
  (repository, { ready, error }) => {
    if (error) return showError(error);
    if (!ready) return showLoading();
    bindRepository(repository);
  },
  {
    onDidChangePath: (callback) => editor.onDidChangePath(callback),
    snapshots: "status",
  },
);
```

The observer owns discovery delivery, repository retention, routing changes and initial readiness. It reports unresolved paths with `ready: false` and a completed lookup with `ready: true`, including a `null` repository. Dispose it with the owning view. A consumer that renders later snapshot changes subscribes to the repository itself; the path observer does not duplicate rendering events. Large trees and tab bars can retain their own shared rendering scheduler.

## Read line diffs

`repository.getLineDiffsAsync(path, text, {base: "head", signal})` compares the current buffer with the last commit; `base: "index"` compares it with the staged version. Both comparisons run in the Git host worker and return line hunks in the buffer's coordinates. The default is `"head"`. A file absent from the selected baseline, including a new file on an unborn branch, is compared with empty text. HEAD comparisons resolve the original path of a staged rename.

Status entries expose `headBlobOid` and `indexBlobOid`, with `null` when the corresponding baseline has no file. Use the index identity when caching unstaged line diffs: staging new contents can change `indexBlobOid` while the status remains `MM` and the editor buffer stays unchanged. Subscribe to `onDidChangeStatusSnapshot`, include the relevant baseline identities in the cache key, and validate them before applying an asynchronous result. Dispose the subscription and cancel outstanding requests with the owning view.

The shared status snapshot verifies ordinary worktree modifications against the index using Git's clean filters and line-ending rules. A file whose normalized content and mode still match the index has no unstaged change, even when Git's cached checkout size reports one. Staged changes remain independent. Background verification and patch reads do not refresh or lock the index; failed verification or a concurrent file or index change preserves the original dirty status.

## Execute a complete workflow

Use named methods on `repository.getOperations()` for writes. Multi-step actions use one workflow, so another interface cannot insert a write between staging and committing.

```js
const expectedHead = { ...repository.getStatusSnapshot().head };
await repository.getOperations().runWorkflow(
  "stage-and-commit",
  async (operations) => {
    await operations.stageFiles(paths);
    await operations.commit(message);
  },
  { expectedHead, guards: ["commit"], signal },
);
```

The callback receives direct operations bound to the same repository and turn. Do not call the outer queued facade from inside it. Expected HEAD is checked before the workflow begins; the workflow can intentionally move HEAD. The shared core policy guards commit and push actions and owns force-push confirmation. `fetchCurrent`, `pullCurrent` and `pushCurrent` resolve current upstream and push targets from fresh refs inside the write turn.

Raw commands use `operations.executeGit(args, options)` and remain descriptor-bound and serialized. Use `{readOnly: true}` only for commands that cannot modify repository or working-tree state. Package code does not create its own Git subprocess or configure a second credential store.

## Interpret completion

Successful writes await the requested initialized snapshots. Ref and configuration changes also refresh registered worktrees sharing the metadata directory. Unobserved snapshots remain lazy. Completion-observer errors are reported separately and do not reject an already successful write.

A failed workflow that completed earlier steps reports `outcome: "partial"` and `completedSteps`. Cancellation or transport loss after a mutation was dispatched can report `outcome: "unknown"` and `retriable: false`. Refresh and inspect repository state before offering another write; never replay a complete workflow automatically. Read requests can be repeated after worker restart. The worker holds its write domain until cancelled Git processes and their descendants settle.

## Render patches and host links

Consume the [`git-panel.diff`](https://github.com/lumine-code/git-panel/blob/master/docs/git-panel.diff.md) service provided by `git-panel` for native unified and side-by-side rendering. Feed local structured diff records to `buildPatch({files}, options)` and forge patches to `buildPatch({rawPatch}, options)`. Consumers dispose their own patch snapshots and release provider-owned view state when the service disappears. Rendering requires no Git Panel context or navigation service.

Import `parseGitRemote` from `lumine`; `parseGitRemote(url)` returns a transport, host, port, namespace, repository and credential-free web URL. Build host-specific links and API requests in the forge integration. Git discovery and execution do not assume GitHub.
