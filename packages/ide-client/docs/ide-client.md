# ide-client

Registers a language server with the editor. The adapter says how to launch it and which grammars it serves; `ide-client` does the rest of LSP.

|             |                                                   |
| ----------- | ------------------------------------------------- |
| Version     | `1.0.0`                                           |
| Provided by | `provideIdeClient()` returning the client service |
| Consumed by | `consumeIdeClient(client)`                        |
| Owner       | `ide-client` (bundled)                            |

An adapter package is small — a manifest entry, a `resolveServer`, and a grammar list. Everything a language server can do then arrives in the editor at once, because `ide-client` implements the twelve UI-facing services (`autocomplete.provider`, `symbol.provider`, `hover.provider`, `outline.provider`, `refactor.provider`, `find-references.provider`, `intentions.list`, and the four `code-format.*`) on every adapter's behalf. You do not implement any of them.

The full types are `lib/main.d.ts` in this package.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "ide-client": {
      "versions": { "^1.0.0": "consumeIdeClient" }
    }
  }
}
```

## Contract

The adapter you register:

```ts
interface LanguageServerAdapter {
  id: string;
  displayName: string;
  grammarScopes: string[];
  resolveServer(context: ServerResolutionContext): Promise<ServerLaunch | null>;

  languageId?: string;
  languageIdForScope?(scopeName: string): string | undefined;
  documentSelector?: Array<{ language?: string; scheme?: string; pattern?: string }>;
  sessionScope?: "project-root" | "workspace";
  getInitializationOptions?(context: { rootPath: string; rootUri: string }): unknown;
  getSettings?(): unknown;
  settingsKeyPaths?: string[];
  getWorkspaceConfiguration?(section?: string, resource?: string): unknown;
  transformDocumentText?(text: string, context: { editor: TextEditor; uri: string }): string;
  restoreDocumentText?(text: string, context: { editor: TextEditor; uri: string }): string;
  transformServerCapabilities?(caps: Record<string, unknown>): Record<string, unknown>;
}
```

Four fields are required:

| Field                    | Description                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | Stable identifier, also the key for `getLog`.                                                                                  |
| `displayName`            | Shown to the user in status and logs.                                                                                          |
| `grammarScopes`          | Which editors this server serves.                                                                                              |
| `resolveServer(context)` | Returns a `ServerLaunch`, or `null` when the server is not installed — which disables the adapter quietly rather than failing. |

`ServerLaunch` is `{ command, args?, cwd?, env?, transport?, host?, port?, version? }` with `transport` one of `"stdio"` (default), `"ipc"`, or `"socket"`.

The service you receive:

| Member                                                            | Description                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `registerAdapter(adapter)`                                        | Registers it and returns a `Disposable`.                                                 |
| `sessionForEditor(editor)`                                        | The session serving that editor, or `null`. May still be starting.                       |
| `activeSessionForEditor(editor)`                                  | Resolves once the session has finished starting; `null` when absent, failed, or stopped. |
| `getSessions()`                                                   | Every session.                                                                           |
| `request(editor, method, params, opts)`                           | Sends an arbitrary LSP request through that editor's session. `opts.signal` cancels it.  |
| `onDidChangeSession(fn)`                                          | `{ session, state, error? }` on every state transition.                                  |
| `onDidPublishDiagnostics(fn)`                                     | Raw `textDocument/publishDiagnostics` payloads.                                          |
| `onDidLog(fn)`, `getLog(adapterId)`                               | Server stderr and protocol log.                                                          |
| `restart(session)`, `stop(session)`                               | Lifecycle control.                                                                       |
| `applyWorkspaceEdit(edit, label)`                                 | Applies an LSP `WorkspaceEdit` to the workspace.                                         |
| `openNotebook`, `changeNotebook`, `saveNotebook`, `closeNotebook` | The notebook document half of LSP.                                                       |

## Minimal example

```js
const { Disposable } = require("atom");

module.exports = {
  consumeIdeClient(client) {
    return client.registerAdapter({
      id: "my-language-server",
      displayName: "My Language Server",
      grammarScopes: ["source.mylang"],
      async resolveServer({ rootPath }) {
        const command = await which("my-langserver");
        if (!command) return null;
        return { command, args: ["--stdio"], cwd: rootPath };
      },
      getSettings: () => ({ mylang: atom.config.get("my-package.serverSettings") }),
      settingsKeyPaths: ["my-package.serverSettings"],
    });
  },
};
```

## Behavior

`resolveServer` returning `null` is the supported way to be a no-op: an adapter whose server is not installed should return `null` rather than throw, and nothing appears in the UI.

Sessions are keyed by `sessionScope`. `"project-root"`, the default, gives each project folder its own server, because most servers resolve their configuration relative to a root and would answer for the wrong project otherwise. `"workspace"` gives the window a single server whose identity never moves, whichever folders come and go.

A `"project-root"` server that declares `workspace.workspaceFolders.supported` **and** `changeNotifications` does not pay for a second process per folder: the running session takes the new folder through `workspace/didChangeWorkspaceFolders` and is then reachable under both. Servers that declare neither get an instance each. Nothing has to be set on the adapter for this — the capabilities decide.

`getSessions()` returns each server once however many folders it answers for.

`sessionForEditor` may hand back a session that is still starting. Await `activeSessionForEditor` when the next thing you do is a request.

The `languageId` sent to the server is resolved in order: `languageIdForScope(scopeName)`, then the built-in scope table, then the blanket `languageId`. Override only the level you actually need.

`getSettings` is pushed as `workspace/didChangeConfiguration` after initialize, and re-pushed whenever a config key listed in `settingsKeyPaths` changes. Without `settingsKeyPaths` the settings are sent once and never refreshed.

`transformDocumentText` can adapt an editor's text before `didOpen`, `didChange`, and `didSave`. An adapter that uses it receives full-document changes so the server never sees a mixture of transformed and original text. `restoreDocumentText` reverses the adaptation in formatting, rename, and workspace edits before they reach the editor. A transform must preserve line positions outside the text it intentionally hides.

`session.supports(method, editor)` honours dynamic registrations, so ask it rather than reading `capabilities` yourself when a server registers capabilities after initialize.

`transformServerCapabilities` is the escape hatch for a server that under- or over-reports what it can do.

## Teardown

`registerAdapter` returns a `Disposable` that unregisters the adapter and stops its sessions — return it directly from `consumeIdeClient`, as in the example. Sessions are also stopped when `ide-client` deactivates, so an adapter needs no shutdown logic of its own.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
