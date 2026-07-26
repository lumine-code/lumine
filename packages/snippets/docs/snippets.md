# snippets

Query the loaded snippets and expand one into an editor.

|             |                                              |
| ----------- | -------------------------------------------- |
| Version     | `1.0.0`                                      |
| Provided by | `provideSnippets()` returning five functions |
| Consumed by | `consumeSnippets(service)`                   |
| Owner       | `snippets` (bundled)                         |

Consumed by completion providers that want snippets in their suggestion list, and by settings UIs that list what is available. A package that only wants to _ship_ snippets does not need this service — it puts a `snippets/` directory in its package instead.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "snippets": {
      "versions": { "^1.0.0": "consumeSnippets" }
    }
  }
}
```

## Contract

```ts
type Snippets = {
  bundledSnippetsLoaded(): boolean;
  snippetsForScopes(scopeDescriptor: ScopeDescriptor): Record<string, Snippet>;
  getUnparsedSnippets(): object[];
  getUserSnippetsPath(): string;
  insertSnippet(
    body: string,
    editor: TextEditor,
    cursor?: Cursor,
    options?: { method?: string },
  ): SnippetExpansion;
};
```

| Member                                | Description                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `bundledSnippetsLoaded()`             | Whether loading has finished. Everything else returns partial results until it does.           |
| `snippetsForScopes(scopeDescriptor)`  | The snippets applying to a scope, keyed by prefix, with the body already parsed.               |
| `getUnparsedSnippets()`               | Every snippet as loaded from disk, before parsing. For listing and editing, not for expansion. |
| `getUserSnippetsPath()`               | The path of the user's own snippets file.                                                      |
| `insertSnippet(body, editor, cursor)` | Expands a snippet body at the cursor and returns the live expansion.                           |

`insertSnippet` also accepts a fourth `{ method }` argument, which records how the expansion was triggered. Leave it out unless you are reproducing one of the package's own commands.

## Minimal example

```js
const { Disposable } = require("atom");

module.exports = {
  consumeSnippets(service) {
    this.snippets = service;
    return new Disposable(() => (this.snippets = null));
  },

  getSuggestions({ editor, bufferPosition, prefix }) {
    if (!this.snippets?.bundledSnippetsLoaded()) return [];
    const scope = editor.scopeDescriptorForBufferPosition(bufferPosition);
    return Object.entries(this.snippets.snippetsForScopes(scope))
      .filter(([snippetPrefix]) => snippetPrefix.startsWith(prefix))
      .map(([snippetPrefix, snippet]) => ({
        snippet: snippet.body,
        replacementPrefix: prefix,
        displayText: snippetPrefix,
        type: "snippet",
      }));
  },
};
```

## Behavior

**Check `bundledSnippetsLoaded()` before trusting a result.** Snippets load asynchronously from several directories, and a query made too early returns whatever has arrived so far rather than failing.

`snippetsForScopes` resolves the whole scope chain, so a snippet declared for `.source.js` is returned for a position inside `.source.js .string` too. The keys are prefixes and later sources override earlier ones under the same prefix, with the user's file winning.

`insertSnippet` performs a real expansion with tab stops and mirrors — it is not a text insertion. The returned expansion stays live until the user tabs out of it or the buffer change invalidates it.

`getUnparsedSnippets` returns the raw records including their source paths, which is what a settings UI needs and what an expansion path should not use.

## Teardown

Return a `Disposable` that drops your reference. The service itself holds nothing on your behalf, and an expansion started with `insertSnippet` is owned by the editor, not by you.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
