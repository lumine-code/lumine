# hyperclick.provider

Turns a word in the editor into something clickable: the provider is asked about a range, and answers with a callback to run if the user follows it.

|             |                                              |
| ----------- | -------------------------------------------- |
| Version     | `1.0.0`                                      |
| Provided by | `provideHyperclick()` returning one provider |
| Consumed by | a hyperclick UI package                      |
| Owner       | `symbols-view` (bundled)                     |

**Nothing consumes this service today.** It is a live extension point with two providers and no UI package to drive them: `symbols-view` offers go-to-definition through it, and `autocomplete-jedi` offers Python definition lookup. Registering a provider costs nothing and does nothing until a consumer appears.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "hyperclick.provider": {
      "versions": { "1.0.0": "provideHyperclick" }
    }
  }
}
```

## Contract

```ts
type HyperclickProvider = {
  getSuggestionForWord(
    editor: TextEditor,
    text: string,
    range: Range,
  ): Suggestion | undefined | Promise<Suggestion | undefined>;

  priority?: number;
  providerName?: string;
  disableForSelector?: string;
};

type Suggestion = {
  range: Range | Range[];
  callback(): void;
};
```

| Member                                      | Description                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `getSuggestionForWord(editor, text, range)` | Required. Return a suggestion, or `undefined`/nothing to decline. May be async.                                 |
| `priority`                                  | Higher wins when several providers answer for the same range. Both current providers use `1`.                   |
| `providerName`                              | Identifies the provider to a consumer that reports which one answered.                                          |
| `disableForSelector`                        | A scope selector; ranges whose scope chain matches are skipped. Providers apply this themselves — see Behavior. |

The suggestion's `range` is what gets underlined, and does not have to equal the range you were asked about. `callback` runs when the user follows the link.

## Minimal example

```js
module.exports = {
  provideHyperclick() {
    return {
      priority: 1,
      providerName: "my-package",
      getSuggestionForWord(editor, text, range) {
        if (!editor.getGrammar().scopeName.startsWith("source.mylang")) return;
        const target = this.resolve(editor, text);
        if (!target) return;
        return {
          range,
          callback: () => atom.workspace.open(target.path, { initialLine: target.row }),
        };
      },
    };
  },
};
```

## Behavior

Declining is the common case, so make it cheap: check the grammar and the token before doing any real work. `getSuggestionForWord` is called on hover, not on click, and is therefore on a hot path.

**`disableForSelector` is advisory.** Both existing providers evaluate it themselves against the scope chain at `range.start` rather than relying on a consumer to honour it. Do the same, or the setting has no effect.

Filter out the trivial answer. `symbols-view` drops a result whose position equals the position asked about, so standing on a definition produces no affordance at all rather than a link to where you already are.

Since there is no consumer, this contract is not exercised at runtime today. Treat the two existing providers as the reference for shape rather than any consumer's expectations, and expect the details to firm up when a UI package lands.

## Teardown

There is no registered consumer and therefore no established disposal convention. A provider should assume it will simply stop being called, and keep no state that needs unwinding.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
