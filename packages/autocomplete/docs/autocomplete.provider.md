# autocomplete.provider

A source of completion suggestions for the autocomplete popup: which scopes it applies to, and a `getSuggestions` function returning the candidates at a buffer position.

|             |                                                                     |
| ----------- | ------------------------------------------------------------------- |
| Version     | `1.0.0`                                                             |
| Provided by | `provideAutocomplete()` returning one provider, or an array of them |
| Consumed by | `consumeAutocomplete(provider)`                                     |
| Owner       | `autocomplete` (bundled)                                            |

To turn a language server into a completion source, register an adapter with `ide-client` instead of implementing this service directly — `ide-client` already provides `autocomplete.provider` on every adapter's behalf.

## Contract

The following TypeScript-style block describes the service in full.

```ts
import { Point, Range, ScopeDescriptor, TextEditor } from "atom";

/**
 * A {@link Range} or any object that can be accepted by {@link
 * Range.prototype.fromObject}.
 */
type RangeCompatible =
  | Range
  | [Point, Point]
  | [[number, number], [number, number]]
  | [{ row: number; column: number }, { row: number; column: number }];

/**
 * Describes a range of a buffer and the text to insert into it. This is one
 * possible insertion strategy among several for a suggestion.
 *
 * Like a Language Server Protocol `Range`, but with an editor {@link Range}.
 *
 * Language-server tooling names the same field `oldRange` rather than `range`.
 * Both are accepted.
 */
type TextEdit = {
  newText: string;
} & ({ range: RangeCompatible } | { oldRange: RangeCompatible });

/**
 * Known types of suggestions; these have predefined styles when rendered.
 * The list covers the whole Language Server Protocol `CompletionItemKind`
 * vocabulary, spelled in kebab-case, plus the grammar-flavoured types that
 * predate it.
 */
type SuggestionType =
  // Language Server Protocol kinds.
  | "text"
  | "method"
  | "function"
  | "constructor"
  | "field"
  | "variable"
  | "class"
  | "interface"
  | "module"
  | "property"
  | "unit"
  | "value"
  | "enum"
  | "keyword"
  | "snippet"
  | "color"
  | "file"
  | "reference"
  | "folder"
  | "enum-member"
  | "constant"
  | "struct"
  | "event"
  | "operator"
  | "type-parameter"
  // Types older than the protocol, still emitted by grammar-based providers.
  | "attribute"
  | "builtin"
  | "import"
  | "mixin"
  | "package"
  | "pseudo-selector"
  | "require"
  | "selector"
  | "tag"
  | "type";

/**
 * A single suggestion as returned by `getSuggestions` or
 * `getSuggestionDetailsOnSelect`.
 */
type Suggestion =
  | ({
      // A suggestion can be inserted one of several ways: as plain text, as a
      // snippet, or as a `TextEdit`. One of these three properties is therefore
      // required; the others are optional.
      //
      // Of these three, later properties win out over earlier ones. For example,
      // `textEdit` will be preferred over both `snippet` and `text` if it is
      // present.

      /**
       * The text to be inserted. Will be used if `snippet` is absent.
       */
      text?: string;

      /**
       * A snippet to insert upon suggestion selection.
       */
      snippet?: string;

      /**
       * Text edit to make when the item is chosen. Use this when you want to be
       * specific about which range of the buffer is replaced. When present, this
       * will be used as the insertion strategy instead of the default behavior.
       *
       * If a suggestion needs to make several edits upon insertion, the rest can
       * be specified via `additionalTextEdits`.
       *
       */
      textEdit?: TextEdit;

      /**
       * The text to show in the menu for this suggestion. Optional; falls back to
       * `snippet`, then `text`.
       */
      displayText?: string;

      /**
       * A dimmed detail rendered immediately after the displayed text, in the
       * same cell — typically a signature such as `(a: number): string`. Always
       * treated as plain text.
       */
      displayTextDetail?: string;

      /**
       * A list of `Range`s to replace when inserting the text. Each `Range`present
       * in this list will result in one insertion of the suggestion's textor
       * snippet.
       *
       * Can insert the autocompletion's text/snippet into one specific range or
       * multiple. Use this when you know the exact range of the current buffer
       * that should be replaced with the given text.
       *
       * Has no effect if `textEdit` is specified.
       */
      ranges?: Range[];

      /**
       * Text before the cursor that should be replaced as part of the insertion of
       * this suggestion. Optional; if omitted, the prefix before the cursor will
       * be used. Has no effect if `textEdit` or `ranges` is specified.
       */
      replacementPrefix?: string;

      /**
       * What the typed prefix is scored against, when that is not the text the
       * user reads. Falls back to `displayText`, then `text`, then `snippet`.
       *
       * Only consulted when the provider sets `filterSuggestions`.
       */
      filterText?: string;

      /**
       * The provider's own relevance ordering, compared as an opaque string —
       * the Language Server Protocol field of the same name. It breaks ties
       * between suggestions that answer the typed prefix equally well; it
       * never outranks the prefix itself.
       */
      sortText?: string;

      /**
       * Nominates this suggestion as the one to start on rather than the first
       * in the list. It remains the *default* selection, so confirming it with
       * a key bound to confirm-if-non-default still passes the key through.
       *
       * The first preselected suggestion wins if several are marked.
       */
      preselect?: boolean;

      /**
       * How inserted text should be indented, following LSP `InsertTextMode`:
       * `1` inserts it exactly as written, `2` re-indents it to match the line
       * it lands on.
       *
       * Only meaningful for an insertion spanning several lines. A snippet is
       * re-indented by default, so pass `1` to keep a body the provider has
       * already laid out; plain text is left alone by default, so pass `2` to
       * have it adjusted.
       */
      insertTextMode?: 1 | 2;

      /**
       * A "type" for this suggestion. Used to classify suggestions and distinguish
       * them visually. The types of {@link SuggestionType} are preferred (and have
       * predefined styles), but you can use an arbitrary string if none of those
       * types suffice.
       */
      type?: SuggestionType | string;

      /**
       * Text edits to make when the item is chosen — in addition to the main item.
       *
       * These are typically optional edits, such as an automatic `import`
       * statement that's inserted when a suggestion warrants it.
       *
       * When present, these edits are made in all code paths, regardless of the
       * original insertion strategy.
       *
       */
      additionalTextEdits?: TextEdit;

      /**
       * A label to display before the suggestion. This can indicate useful
       * information like a method return type. Both text and HTML variants are
       * supported; `leftLabelHTML` takes precedence over `leftLabel` when both are
       * present.
       */
      leftLabel?: string;
      leftLabelHTML?: string;

      /**
       * A label to display after the suggestion. This can indicate useful
       * information like a type annotation. Both text and HTML variants are
       * supported; `rightLabelHTML` takes precedence over `rightLabel` when both
       * are present.
       */
      rightLabel?: string;
      rightLabelHTML?: string;

      /**
       * Class name to add to the suggestion's row in the HTML. Allows for further
       * styling customization, if needed.
       */
      className?: string;

      /**
       * An override to allow you to specify your own icon. Should follow Octicon
       * conventions; e.g., `"<i class="icon-move-right"></i>"`. Optional.
       */
      iconHTML?: string;

      /**
       * A docstring summary or short description of the suggestion. When
       * specified, it will be displayed at the bottom of the suggestions list.
       * Optional.
       */
      description?: string;

      /**
       * The same summary written in Markdown. Takes precedence over
       * `description` when both are present: it is rendered and sanitized, and
       * fenced code blocks are syntax highlighted.
       */
      descriptionMarkdown?: string;

      /**
       * A url to the documentation or more information about this suggestion. When
       * specified, a `More…` link will be displayed in the description area.
       */
      descriptionMoreURL?: string;

      /**
       * A list of indices where the characters in the prefix appear in this
       * suggestion's text.
       * @type {Object}
       */
      characterMatchIndices?: number[];

      /**
       * Single characters that accept this suggestion when typed while it is
       * highlighted. The character is inserted after the suggestion, so typing
       * `(` on a highlighted `console` yields `console(`.
       *
       * Honoured only when the `autocomplete.commitCharacters` setting is on,
       * which it is not by default. For a snippet suggestion the character
       * lands wherever the expansion left the cursor, which is its first tab
       * stop rather than the end of the inserted text.
       */
      commitCharacters?: string[];

      // (Either `text`, `snippet`, or `textEdit` must be provided.)
    } & { text: string })
  | { snippet: string }
  | { textEdit: TextEdit };

/**
 * The provider object that you should make available to `autocomplete`.
 * This should be the return value of whatever method you specified in your
 * `providedServices` metadata.
 */
type ServiceProvider = {
  /**
   * Scope selector for which this provider should be active. Multiple values
   * can be given separated by commas. Required: a provider without one is
   * rejected at registration.
   */
  scopeSelector: string;
  /**
   * Scope selector for which this provider should be inactive, even if the
   * scope otherwise matches `scopeSelector`. Multiple values can be given
   * separated by commas. Optional.
   */
  disableForScopeSelector?: string;

  /**
   * The priority of this provider relative to others. Higher numbers beat
   * lower numbers.
   */
  inclusionPriority: number;

  /**
   * When `true`, this provider excludes options from providers with a lower
   * priority from even appearing in the menu.
   */
  excludeLowerPriority: boolean;

  /**
   * The priority of this provider's suggestions relative to other suggestions
   * that may exist in the list. Influences the ordering of suggestions within
   * a menu.
   */
  suggestionPriority: number;

  /**
   * When `true`, `autocomplete` expects to receive many suggestions and
   * will filter the list based on what's already been typed in the token. When
   * `false`, you assert that whatever you deliver to `autocomplete` has
   * already been filtered.
   */
  filterSuggestions: boolean;

  /**
   * Single characters that should open the suggestion list when typed, even
   * where autocomplete would otherwise leave it closed — most importantly when
   * the user has turned off suggestions on keystroke. Optional.
   *
   * Read on every keystroke rather than held onto, so a provider whose set
   * grows or shrinks at runtime — a language server that has just finished
   * starting, say — can expose it as a getter.
   */
  triggerCharacters?: Set<string>;

  /**
   * Retrieves suggestions for a given editor at a given point. Can consult
   * other metadata. Can go async.
   */
  getSuggestions(meta: {
    /** The current text editor. */
    editor: TextEditor;
    /** The position of the cursor. */
    bufferPosition: Point;
    /**
     * The scope descriptor at the given buffer position.
     */
    scopeDescriptor: ScopeDescriptor;
    /**
     * The prefix that the user has typed before the cursor. Typically
     * represents all word-like characters between the cursor and the last
     * non-word character.
     */
    prefix: string;
    /**
     * Whether the user activated this menu manually or had it appear
     * automatically while typing.
     */
    activatedManually: boolean;
    /**
     * Why suggestions are being asked for, numbered as LSP's
     * `CompletionTriggerKind`: `1` when the list was invoked — typed into,
     * or asked for by hand — and `2` when one of this provider's
     * `triggerCharacters` was typed.
     *
     * `3`, a re-request of a list the provider itself marked incomplete, is
     * never raised here: only the provider knows a list was incomplete, so it
     * is the side that reports that kind onwards.
     */
    triggerKind: 1 | 2;
    /**
     * The character that fired the trigger when `triggerKind` is `2`, and
     * `null` otherwise. Saves re-reading the buffer to work out which one it
     * was.
     */
    triggerCharacter: string | null;
  }): Suggestion[] | Promise<Suggestion[]>;

  /**
   * Fills in further details on this suggestion when it is highlighted in the
   * menu. Optional.
   *
   * A language server can use this method to send `completionItem/resolve` and
   * return an updated suggestion with the new data.
   */
  getSuggestionDetailsOnSelect?(suggestion: Suggestion): Promise<Suggestion>;

  /**
   * Invoked after a chosen suggestion is inserted into the editor. Optional.
   */
  onDidInsertSuggestion?(meta: {
    /** The current text editor. */
    editor: TextEditor;
    /** The position of the cursor when the suggestion was chosen. */
    triggerPosition: Point;
    /** The suggestion that was chosen. */
    suggestion: Suggestion;
  }): void;

  /**
   * Called when your provider needs to be cleaned up. Optional.
   */
  dispose?(): void;
};
```

## Registration

In your `package.json`, add:

```json
"providedServices": {
  "autocomplete.provider": {
    "versions": {
      "1.0.0": "provideAutocomplete"
    }
  }
}
```

Name the method `provideAutocomplete`: the convention across the workspace is
`provide`/`consume` plus the PascalCased service name, with a trailing
`provider` segment dropped.

Then, in your main package export, define a method of the same name:

```js
module.exports = {
  activate() {
    // existing activation code
  }

  provideAutocomplete() {
    // Return a value that conforms to the `ServiceProvider` interface
    // described above…
    return new Provider()

    // …or return multiple such providers as an array.
    return [new Provider(), new OtherProvider()]
  }
}
```

## Minimal example

```js
module.exports = {
  provideAutocomplete() {
    return {
      scopeSelector: ".source.js",
      getSuggestions({ prefix }) {
        if (prefix.length < 2) return [];
        return MY_KEYWORDS.filter((word) => word.startsWith(prefix)).map((word) => ({
          text: word,
          type: "keyword",
          description: `the ${word} keyword`,
        }));
      },
    };
  },
};
```

## Behavior

`autocomplete` guesses at the “prefix” — that is, the range of characters before the cursor that might be part of whatever suggestion you will insert.

For some languages, you may need to override this by specifying a `replacementPrefix` value for each suggestion:

```js
let provider = {
  scopeSelector: ".source.js",
  getSuggestions({ editor, bufferPosition }) {
    let prefix = this.getPrefix(editor, bufferPosition);
  },

  getPrefix(editor, bufferPosition) {
    // Whatever your prefix regex might be.
    let regex = /[\w0-9_-]+$/;

    // Get the text for the line up to the triggered buffer position.
    let line = (line = editor.getTextInRange([[bufferPosition.row, 0], bufferPosition]));

    // Match the regex to the line, and return the match (if any).
    return line.match(regex)?.[0] ?? "";
  },
};
```

## Teardown

`consumeAutocomplete` returns nothing, so a provider is unregistered by its own optional `dispose()` rather than by a `Disposable` handed back to you. Implement it if your provider holds subscriptions, a worker, or a cache.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
