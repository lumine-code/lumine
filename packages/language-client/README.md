# language-client

Language Server Protocol client infrastructure.

Starts language servers lazily when matching editors open and exposes UI-independent sessions to other packages through the `lumine.languageServer` service.

## Features

- **Sessions**: starts one language server per project root, or one per workspace, lazily when a matching editor opens.
- **Transports**: spawns servers over stdio, IPC, or socket connections with JSON-RPC framing.
- **Synchronization**: keeps open documents in sync with incremental or full-text updates.
- **Diagnostics**: forwards server diagnostics to the linter package when installed.
- **Completions**: serves language-server completions to autocomplete.
- **Symbols**: serves document and project symbols to symbols-view.
- **Status bar**: shows the active server state with a session menu for restart, log, and problems.
- **Logging**: keeps a per-server log buffer with optional protocol tracing.

## Commands

Commands available in `atom-workspace`:

- `language-client:restart`: restart the language server for the active editor,
- `language-client:toggle-problems`: toggle the diagnostics panel,
- `language-client:hover`: show language information at the cursor,
- `language-client:format`: format the active document,
- `language-client:rename`: rename the symbol under the cursor,
- `language-client:code-actions`: list code actions for the selection,
- `language-client:show-log`: open the active server's log in a new editor.

## Usage

Language servers are registered by adapter packages that consume the `lumine.languageServer` service:

```js
consumeLanguageServer(languageServer) {
  return languageServer.registerAdapter({
    id: "example",
    displayName: "Example Language Server",
    grammarScopes: ["source.example"],
    async resolveServer({ rootPath }) {
      return { command: "/absolute/path/to/example-ls", args: ["--stdio"], cwd: rootPath };
    },
  });
}
```

Commands are spawned directly with `shell: false`; arguments belong in `args`. The default session scope is one server per project root; set `sessionScope: "workspace"` only for servers that correctly support multi-root workspaces. Editors without a file path are not attached to language servers. The complete public shapes are documented in `lib/main.d.ts`.

## Customization

Tweak the status-bar item from your stylesheet:

```less
.language-client-status {
  font-weight: bold;
  &.status-failed {
    color: var(--text-color-error);
  }
}
```

## Services

- **lumine.languageServer** (`1.0.0`): provided to adapter packages to register language servers and reach sessions.
- **autocomplete.provider** (`1.0.0`): provided to autocomplete to serve language-server completions.
- **symbol.provider** (`1.0.0`): provided to symbols-view to serve document and project symbols.
- **hover** (`1.0.0`): provided to hover UIs to serve documentation at a buffer position.
- **signature** (`1.0.0`): provided to signature-help UIs to serve call signatures while typing.
- **outline-view** (`1.0.0`): provided to outline UIs to serve the hierarchical document outline.
- **linter-indie** (`^1.0.0`): consumed to push server diagnostics into the linter UI, one delegate per server.
- **busy-signal** (`^1.0.0`): consumed to surface server work-done progress in the status bar.
- **status-bar** (`^1.0.0`): consumed to show the active server state and session menu.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
