# bracket-matcher

Reports which bracket pair is currently highlighted, and when that changes.

|             |                                                      |
| ----------- | ---------------------------------------------------- |
| Version     | `1.0.0`                                              |
| Provided by | `provideBracketMatcher()` returning the query object |
| Consumed by | `consumeBracketMatcher(service)`                     |
| Owner       | `bracket-matcher` (bundled)                          |

For anything that wants to draw the match somewhere other than in the buffer — a scrollbar overview, a minimap, a status indicator.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "bracket-matcher": {
      "versions": { "^1.0.0": "consumeBracketMatcher" }
    }
  }
}
```

## Contract

```ts
type BracketMatcher = {
  getMatchRanges(editor: TextEditor): { range1: Range; range2: Range } | null;
  observe(callback: (editor: TextEditor, ranges: MatchRanges | null) => void): Disposable;
};
```

| Member                   | Description                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `getMatchRanges(editor)` | The two buffer ranges of the highlighted pair, or `null` when nothing is highlighted in that editor. |
| `observe(callback)`      | Called with `(editor, ranges)` on every match change. Returns a `Disposable`.                        |

`range1` is the bracket at or beside the cursor and `range2` is its partner, so neither is guaranteed to come first in the buffer.

## Minimal example

```js
module.exports = {
  consumeBracketMatcher(service) {
    return service.observe((editor, ranges) => {
      this.drawMarkers(editor, ranges ? [ranges.range1, ranges.range2] : []);
    });
  },
};
```

## Behavior

`null` is a normal answer, not an error: it means the cursor is not on or beside a bracket, or that editor has no highlight yet. Handle it on every call and in every `observe` callback.

`observe` does not replay the current state — it reports changes from the moment you subscribe. Call `getMatchRanges` yourself for the initial value.

The ranges are read from markers that track edits, so fetch them when you need them rather than holding them across buffer changes.

Tag matching in markup languages resolves through the same service, so the two ranges may cover whole tags rather than single characters.

## Teardown

`observe` returns a `Disposable`; return it from `consumeBracketMatcher` or add it to your own collection. Nothing else needs unwinding.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
