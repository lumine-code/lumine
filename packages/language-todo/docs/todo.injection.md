# todo.injection

Lets a language grammar highlight `TODO`-style markers inside its own comments, by injecting the todo grammar at nodes it nominates.

|             |                                                         |
| ----------- | ------------------------------------------------------- |
| Version     | `1.0.0`                                                 |
| Provided by | `provideTodoInjection()` returning the injection helper |
| Consumed by | `consumeTodoInjection(todo)`                            |
| Owner       | `language-todo` (bundled)                               |

Consumed by eighteen language packages. The shape is identical to [`hyperlink.injection`](https://lumine-code.github.io/docs.html#services/hyperlink.injection); a grammar package usually consumes both in the same file.

The markers recognised are `TODO`, `FIXME`, `CHANGED`, `XXX`, `IDEA`, `HACK`, `NOTE`, `REVIEW`, `NB`, `BUG`, `QUESTION`, `COMBAK`, `TEMP`, `DEBUG`, `OPTIMIZE`, and `WARNING`.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "todo.injection": {
      "versions": { "^1.0.0": "consumeTodoInjection" }
    }
  }
}
```

Tree-sitter grammars only — injection points are a Tree-sitter concept, so a TextMate-only package has nothing to consume.

## Contract

```ts
type TodoInjection = {
  addInjectionPoint(
    scopeName: string,
    options: {
      types: string | string[];
      language?(node: Node): string | null | undefined;
      content?(node: Node): Node | Node[];
    },
  ): void;

  test(node: Node): boolean;
};
```

| Member                                  | Description                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `addInjectionPoint(scopeName, options)` | Registers an injection point on a grammar. `scopeName` is the parent language's scope.                             |
| `options.types`                         | Required. One node type or an array of them — the nodes that may contain a marker.                                 |
| `options.language(node)`                | Optional. Return a language name to force one, `null` to suppress, or `undefined` to fall through.                 |
| `options.content(node)`                 | Optional. Narrows the injection to some of the node's children. Defaults to the node itself.                       |
| `test(node)`                            | The default check — whether the node's text contains one of the markers. Exposed for a custom `language` callback. |

## Minimal example

```js
const SCOPES = ["source.mylang", "source.mylang.embedded"];

exports.consumeTodoInjection = (todo) => {
  for (const scope of SCOPES) {
    todo.addInjectionPoint(scope, { types: ["comment"] });
  }
};
```

## Behavior

Register `comment` node types only. Unlike hyperlinks, markers are meaningful in comments and noise everywhere else — injecting into strings will highlight the word `NOTE` in ordinary prose.

The injection fires only for nodes whose text actually contains one of the markers, which is what keeps the cost proportional to the comments rather than to the file.

Injection is **per comment node**, not per document. That is a deliberate performance compromise rather than the ideal design, so a package with unusually many small comments may see the cost add up; it is not something a consumer can tune.

Register each scope your package ships separately. The table is keyed by exact scope name, so a dialect needs its own call.

## Teardown

`addInjectionPoint` returns nothing and injection points cannot be removed, so the registration lasts for the life of the window. Register at activation and unconditionally.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
