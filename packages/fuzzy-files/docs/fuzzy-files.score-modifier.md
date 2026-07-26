# fuzzy-files.score-modifier

Adjusts how the file finder ranks its results, so a package can push the files it knows are relevant to the top.

|             |                                                        |
| ----------- | ------------------------------------------------------ |
| Version     | `1.0.0`                                                |
| Provided by | `provideFuzzyFilesScoreModifier()` returning `{ add }` |
| Consumed by | `consumeFuzzyFilesScoreModifier(service)`              |
| Owner       | `fuzzy-files` (bundled)                                |

**No package consumes this today.** It exists so recency, git status, open editors, or a language server's notion of relatedness can influence the ordering without `fuzzy-files` knowing about any of them.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "fuzzy-files.score-modifier": {
      "versions": { "^1.0.0": "consumeFuzzyFilesScoreModifier" }
    }
  }
}
```

## Contract

```ts
type ScoreModifierService = {
  add(modifier: (score: number, item: Item) => number): Disposable;
};

type Item = {
  fPath: string;
  distance: number;
};
```

`add` registers a modifier and returns a `Disposable` that removes it. The modifier receives the score so far and the item, and returns the new score. **Higher scores rank first.**

`item` carries at least `fPath`, the project-relative path, and `distance`, which `fuzzy-files` has already folded into the base score.

## Minimal example

```js
module.exports = {
  consumeFuzzyFilesScoreModifier(service) {
    return service.add((score, item) => {
      // Float recently edited files to the top.
      return this.recentPaths.has(item.fPath) ? score * 2 : score;
    });
  },
};
```

## Behavior

Modifiers run **after** the built-in ranking, which already divides the fuzzy-match score by the item's distance and the square root of its path depth — so shallow, close files start ahead. Your modifier sees that adjusted number.

They are applied in registration order, each receiving the previous one's output, so several packages compose rather than compete. That also means a modifier returning a constant destroys every ranking decision made before it. Multiply or add a bounded amount; do not replace.

The modifier runs **once per candidate on every keystroke**, so it must be synchronous and cheap. Precompute whatever you need — a `Set` of interesting paths — and only look it up here.

Returning `NaN` or a non-number silently sinks the item to the bottom, since the comparison fails. Guard your arithmetic.

## Teardown

`add` returns a `Disposable` that removes the modifier; return it directly from your consumer method. Leaving one registered after your package deactivates keeps a stale closure on the ranking hot path.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
