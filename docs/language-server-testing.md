# Testing language-server packages

Every `ide-*` adapter needs both automated specs and a real-window conformance manifest. Specs make behavior repeatable in CI; `script/drive.js lsp` proves that the packaged adapter, the real server process, the editor, and JSON-RPC all work together in a normal renderer.

## Run the matrix

Run these commands from the `lumine` checkout. Use one unused port for the whole session:

```powershell
node script/drive.js launch --fresh --port 9344 --link ..\ide-client --link ..\ide-yaml
node script/drive.js lsp --port 9344 -f ..\ide-yaml\spec\drive.json
node script/drive.js console --port 9344 --ms 3000
node script/drive.js issues --port 9344 --ms 3000
node script/drive.js quit --port 9344
```

`launch` creates an isolated `LUMINE_HOME` and links the package checkouts into it. Link `ide-client` whenever its current checkout is part of the test. The `lsp` command does not launch a window of its own; it drives the already-running instance.

Keep a second terminal streaming `console` or `issues` while reproducing an asynchronous failure. Renderer exceptions and rejected promises reach `console`; Chromium deprecations and other DevTools findings reach `issues`.

Do not launch a package's `lib/main.js` as an Electron main script. An editor package is activated inside Lumine and may require the `lumine` module, renderer globals, services, and package lifecycle. Starting its entry point as an application tests a different environment and produces misleading module-resolution failures.

## Manifest

Paths in a manifest are resolved from the manifest's directory. A minimal matrix is:

```json
{
  "adapter": "ide-example",
  "project": "fixtures/drive",
  "file": "fixtures/drive/example.ext",
  "grammarScope": "source.example",
  "timeout": 30000,
  "config": {
    "ide-example.server.networkFeature": false
  },
  "checks": [
    {
      "name": "completion",
      "method": "textDocument/completion",
      "position": [1, 4],
      "params": { "context": { "triggerKind": 1 } },
      "expect": { "path": "items.*.label", "includes": "example" }
    },
    {
      "name": "restart lifecycle",
      "kind": "restart",
      "expect": { "path": "current", "equals": "running" }
    }
  ]
}
```

The required top-level fields are `adapter` and a non-empty `checks` array. `project`, `file`, `grammarScope`, `config`, and `timeout` are optional. Configuration is applied before the project paths are set and the fixture is opened.

A request check accepts these fields:

| Field        | Meaning                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `name`       | Unique check name.                                                                             |
| `method`     | LSP or extension request method.                                                               |
| `params`     | Literal request parameters.                                                                    |
| `position`   | `[line, character]`, inserted as `params.position`.                                            |
| `document`   | `false` to suppress automatic `textDocument: { uri }` insertion for a `textDocument/*` method. |
| `paramsFrom` | Values copied from earlier results into this request.                                          |
| `expect`     | Assertions applied to the result.                                                              |
| `retry`      | `true` or `{timeout, interval}` to repeat a safe read until `expect` passes.                   |

Use `kind: "diagnostics"` to wait for pushed diagnostics in the client, with an optional `minLength`. Test pull diagnostics with a normal `textDocument/diagnostic` request. Use `kind: "restart"` to replace the active session and wait for its successor to reach `running`.

An expectation may select `path`, where `*` expands an array or object's values. It may then assert `exists`, `truthy`, `type`, `minLength`, `equals`, `includes`, or a regular-expression `matches` with optional `flags`. Prefer stable semantic values over whole-response snapshots; server ordering and extra protocol fields may change without changing the feature.

Use `retry` only when a server reports `running` before an asynchronous index or configuration pass makes a read result ready. The runner permits it only for known non-mutating protocol requests, requires an `expect` condition, and retries both transient request errors and results that do not satisfy that condition. Never warm a matrix with arbitrary delays or repeat rename and command execution: those are mutations, and a second attempt is a second action.

`paramsFrom` makes dependent protocol flows testable without copying opaque server data:

```json
{
  "name": "execute action command",
  "method": "workspace/executeCommand",
  "document": false,
  "paramsFrom": {
    "$": {
      "check": "code actions",
      "path": "$",
      "find": { "path": "command.command", "equals": "example.applyFix" },
      "select": "command"
    }
  },
  "expect": { "type": "null" }
}
```

Each target key is a dotted path in the new request; `$` replaces all parameters. A source names an earlier `check`, optionally reads a `path`, finds the first array or object value whose nested field `equals` a value, and then `select`s a nested value from that match. Preserve opaque `data`, commands, edits, and ranges this way so every follow-up goes back to the session that produced them.

## Coverage

Across the automated specs and real-window matrices, exercise every server feature the adapter advertises, not only completion and hover. Depending on the server, that includes:

- push and pull diagnostics;
- document and workspace symbols;
- declarations, definitions, implementations, references, and highlights;
- completion and resolve, hover, and signature help;
- formatting, range formatting, and on-type formatting;
- prepare-rename and rename;
- code actions, code lens, and command execution;
- document links, colours and colour presentations;
- folding, selection, linked-editing, inlay hints, and semantic tokens;
- server-specific requests and notifications; and
- stop/restart lifecycle behavior.

Add a manifest for each materially different language mode. For example, an adapter serving CSS, SCSS, and Less must open and query all three rather than assuming one grammar proves the other routes. Keep fixtures deterministic and offline: disable schema stores, telemetry, downloads, or discovery services that can change the response. Intentionally invalid or poorly formatted fixtures should be excluded from repository formatters and linters when changing them would erase the condition under test.

The normal package suite still owns activation, configuration, resolution order, command wiring, protocol transforms, failure paths, and edge cases that do not need a real process. Run it together with lint, formatting, and package-content checks:

```powershell
npm test
npm run lint
npm run format:check
npm pack --dry-run
```

## Compatibility rules

LSP implementations frequently accept or emit shapes that are looser than the specification suggests. Test the exact server version shipped by the package and treat its observed wire behavior as part of the adapter contract.

- Advertise only client capabilities that have an implementation, but include the complete truthful object for each one. Some servers dereference optional nested fields without guarding them.
- Ask `session.supports()` and `session.capabilityOptions()` instead of reading static server capabilities directly. Servers may register features dynamically after initialize.
- Support server-initiated standard requests that correspond to advertised capabilities. In particular, `ide-client` answers `workspace/workspaceFolders` with the current project-folder list.
- Match custom request and notification payloads exactly. Extension protocols often differ in array nesting, URI placement, and whether a command returns `null` or no value.
- Exercise every request/resolve pair through the same session. Opaque `data` belongs to the server that returned it.
- Verify multi-root adoption, configuration refresh, cancellation, diagnostics, and restart behavior where the server declares them.
- Inspect both console output and DevTools issues after the matrix. A list of passing requests is not enough when activation or teardown produced an uncaught error.
