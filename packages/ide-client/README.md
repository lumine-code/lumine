# ide-client

Language Server Protocol client infrastructure.

Starts language servers lazily when matching editors open and exposes UI-independent sessions to other packages through the `ide-client` service.

## Features

- **Sessions**: starts one language server per project root, or one per workspace, lazily when a matching editor opens.
- **Several servers per file**: every adapter matching a grammar runs, so a type checker and a linter serve the same buffer together.
- **Overlap removal**: answers that several servers repeat, such as a shared signature line, are shown once.
- **Transports**: spawns servers over stdio, IPC, or socket connections with JSON-RPC framing.
- **Synchronization**: keeps open documents in sync with incremental or full-text updates.
- **Diagnostics**: forwards server diagnostics to the linter package when installed.
- **Completions**: serves language-server completions to autocomplete.
- **Symbols**: serves document and project symbols to symbols-view.
- **Inlay hints**: renders inline type and parameter-name labels for the visible part of the editor.
- **Code lens**: shows actionable command links above symbols; disabled by default.
- **Semantic tokens**: layers server-computed highlighting over the grammar's own; disabled by default.
- **Server list**: lists every running server with its state, and restarts, stops, or opens the log of any of them.
- **Status bar**: counts the running servers in a status-bar item, flags the failed ones, and opens the server list on click.
- **Logging**: keeps a per-server log buffer with optional protocol tracing.

## Commands

Commands available in `atom-workspace`:

- `ide-client:servers`: list the running language servers and act on one of them,
- `ide-client:restart`: restart the language servers for the active editor,
- `ide-client:toggle-problems`: open the linter panel with the server diagnostics,
- `ide-client:format`: format the active document,
- `ide-client:show-log`: open the active server's log in a new editor,
- `ide-client:open-custom-servers-file`: open the custom servers configuration file.

## Usage

Language servers are registered by adapter packages that consume the `ide-client` service:

```js
consumeIdeClient(ideClient) {
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

Commands are spawned directly with `shell: false`; arguments belong in `args`. The default session scope is one server per project root; a server whose capabilities declare multi-root support is handed further folders instead of being started again, so `sessionScope: "workspace"` is needed only for servers with no notion of a root. Editors without a file path are not attached to language servers. The complete public shapes are documented in `lib/main.d.ts`.

## Configuration

Any language server can be wired without an adapter package through `language-servers.json` in the configuration directory (open it with `ide-client:open-custom-servers-file`). Each entry needs a `command` and grammar `scopes`; `args`, `languageId`, `sessionScope`, `transport`, `env`, `initializationOptions`, and `settings` are optional. `settings` feeds both `workspace/configuration` lookups and the configuration push after startup:

```json
{
  "gopls": {
    "command": "gopls",
    "args": ["serve"],
    "scopes": ["source.go"],
    "settings": { "gopls": { "usePlaceholders": true } }
  }
}
```

Saving the file restarts exactly the servers whose entries changed.

## Customization

Tweak the server list and the status-bar item from your stylesheet:

```css
.ide-client-session-state {
  font-weight: bold;
}
.ide-client-server-status .ide-client-server-label {
  color: var(--text-color-info);
}
```

## Services

- **[ide-client](docs/ide-client.md)** (`1.0.0`): provided to adapter packages to register language servers and reach sessions.
- **[autocomplete.provider](https://lumine-code.github.io/docs.html#services/autocomplete.provider)** (`1.0.0`): provided to autocomplete to serve language-server completions.
- **[symbol.provider](https://lumine-code.github.io/docs.html#services/symbol.provider)** (`1.0.0`): provided to symbols-view to serve document and project symbols.
- **[hover.provider](https://lumine-code.github.io/docs.html#services/hover.provider)** (`1.0.0`): provided to hover UIs to serve documentation at a buffer position.
- **[hover.signature-provider](https://lumine-code.github.io/docs.html#services/hover.signature-provider)** (`1.0.0`): provided to signature-help UIs to serve call signatures while typing.
- **[outline.provider](https://lumine-code.github.io/docs.html#services/outline.provider)** (`1.0.0`): provided to outline UIs to serve the hierarchical document outline.
- **[code-format.range](https://lumine-code.github.io/docs.html#services/code-format.range)** (`1.0.0`): provided to formatting orchestrators; resolves a selected range to text edits from the server.
- **[code-format.file](https://lumine-code.github.io/docs.html#services/code-format.file)** (`1.0.0`): provided to formatting orchestrators; resolves a whole file to text edits from the server.
- **[code-format.on-type](https://lumine-code.github.io/docs.html#services/code-format.on-type)** (`1.0.0`): provided to formatting orchestrators; resolves text edits as the user types a trigger character.
- **[code-format.on-save](https://lumine-code.github.io/docs.html#services/code-format.on-save)** (`1.0.0`): provided to formatting orchestrators; resolves text edits on save.
- **[find-references.provider](https://lumine-code.github.io/docs.html#services/find-references.provider)** (`1.0.0`): provided to reference UIs to list occurrences of the symbol at a position.
- **[refactor.provider](https://lumine-code.github.io/docs.html#services/refactor.provider)** (`1.0.0`): provided to rename UIs; resolves to a path-to-edits map, with prepare support.
- **[intentions.list](https://lumine-code.github.io/docs.html#services/intentions.list)** (`1.0.0`): provided to the intentions UI to serve code actions and quick fixes at the cursor.
- **[linter.registry](https://lumine-code.github.io/docs.html#services/linter.registry)** (`^1.0.0`): consumed to push server diagnostics into the linter UI, one delegate per server.
- **[busy-signal](https://lumine-code.github.io/docs.html#services/busy-signal)** (`^1.0.0`): consumed to surface server work-done progress on the busy indicator.
- **[status-bar](https://lumine-code.github.io/docs.html#services/status-bar)** (`^1.0.0`): consumed to show the running servers in an item that opens the server list.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
