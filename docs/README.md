# Developer guides

Detailed guides for extending the editor, with runtime contracts in the [API reference](https://lumine-code.github.io/api/) and package-owned service contracts beside their implementations. Start with [Developing extensions](https://lumine-code.github.io/docs.html#extending-lumine/developing-extensions) for a short introduction.

## Packages and workspace

- [Developing a package](developing-a-package.md): manifests, lifecycle, lazy work, views and live development.
- [Application and context menu groups](application-and-context-menu-groups.md): named groups, command order, separators and surface-specific layouts.
- [Services](services.md): provider and consumer registration, ownership and versioning.
- [Pane items](pane-items.md): identity, moving, copying, presentation windows and resource lifetime.
- [Handling URIs](handling-uris.md): external handlers, workspace openers and preview reuse.
- [File watching](file-watching.md): readiness, recovery, document moves and buffer change origins.
- [Session state](session-state.md): project transitions, package state and retention.
- [Working with repositories](repositories.md): repository context, snapshots and serialized operations.
- [Writing specs](writing-specs.md): editor-window tests, asynchronous waits and running suites.
- [Publishing a package](publishing-a-package.md): Git releases, package identity and catalogs.

## Themes and grammars

- [Developing a theme](developing-a-theme.md): theme families, style extension and shared DOM conventions.
- [Theme variables](theme-variables.md): CSS token roles, values, ownership and change notifications.
- [Creating a grammar](creating-a-grammar.md): descriptors, scopes and language selection.
- [Tree-sitter grammars](tree-sitter-grammars.md): queries, captures, injections, parser boundaries and compatibility.

## Integration contracts and diagnostics

- [Core service contracts](services/): the contracts owned by the editor.
- [Writing a language-server adapter](https://github.com/lumine-code/ide/blob/master/docs/language-server-adapter.md): the adapter-authoring guide owned by `ide`, alongside its [service contract](https://github.com/lumine-code/ide/blob/master/docs/ide.md).
- [Jupyter integrations](https://github.com/lumine-code/jupyter-repl/blob/master/docs/3_integration.md): the service and lifecycle guide owned by `jupyter-repl`.
- [Testing language-server packages](language-server-testing.md): the shared server integration matrix.
- [Editor performance diagnostics](editor-performance.md): benchmark procedures and recorded display, injection, marker and captured-frame comparisons.
- [JavaScript document core](javascript-document-core.md): internal model boundaries, snapshots, validation and current benchmarks.
- [Document edit contract](document-edit-contract.md): committed changes, transactions and parser integration.
