# Services

Packages extend one another through **services**: one package offers an object, another receives it. Nothing is imported across package boundaries and neither side needs the other installed — if the provider is missing, the consumer's method simply never runs.

## How it works

A provider declares what it offers in its `package.json`:

```json
{
  "providedServices": {
    "status-bar": {
      "versions": { "2.0.0": "provideStatusBar" }
    }
  }
}
```

A consumer declares what it wants, with a semver range:

```json
{
  "consumedServices": {
    "status-bar": {
      "versions": { "^2.0.0": "consumeStatusBar" }
    }
  }
}
```

Both then export the named method. The provider's returns the service object; the consumer's receives it, once per matching provider:

```js
module.exports = {
  provideStatusBar() {
    return { addLeftTile, addRightTile };
  },
};
```

```js
module.exports = {
  consumeStatusBar(service) {
    return service.addLeftTile({
      windows: "all",
      create({ document, editorContainer }) {
        const element = document.createElement("span");
        const subscription = editorContainer.observeActivePaneItem((item) => {
          element.textContent = item?.getTitle?.() ?? "No active tab";
        });
        return { element, dispose: () => subscription.dispose() };
      },
    });
  },
};
```

Title-bar and status-bar contributions default to the main window. An explicit `windows: "all"` factory creates independent DOM and subscriptions in every current and future `EditorWindow`, while the package activates once. A contribution's disposal removes all of its instances. Use `context.editorContainer` for local activity and `context.window` for native window actions; shared document services remain workspace-owned. See the [title-bar contract](https://github.com/lumine-code/title-bar/blob/master/docs/title-bar.md) and [status-bar contract](https://github.com/lumine-code/status-bar/blob/master/docs/status-bar.md).

Return a `Disposable` from a consumer method and Lumine calls it when the provider goes away, so a package can cleanly drop a service it is no longer being offered.

Order does not matter. Lumine connects providers and consumers whichever activates first, and connects late arrivals as they load.

### Bootstrap and lazy work

Packages bootstrap synchronously. A provider publishes its declared service during `activate()`, and a consumer connects to providers that are already available; consuming a service never activates another package. Keep expensive provider implementation behind an `ensure` function or an asynchronous service method, and let the consumer await that method when it performs the operation.

### Names are matched exactly

A service name is an opaque string. The `.` in `linter.provider` groups related services for a reader — it is **not** a path, so consuming `linter` does not reach a provider of `linter.provider`. Get the name exactly right or nothing happens: there is no error, no warning in the console, and no failing spec. Missing wiring is silent.

### Versions

Service versions follow semver. A provider declares exact versions and a consumer requests the range it implements; use `^1.0.0`, `^1.1.0`, `^2.0.0`, or another range according to the service's canonical contract. Add compatible capabilities in a minor release and use a new major version for an incompatible shape; rename the service only when its meaning or ownership changes.

## Naming

If you are designing a service rather than consuming one, follow the workspace naming convention.

A name is either bare or `namespace.capability`, both kebab-case:

- **Bare, your package's name**, when your package offers exactly one contract and that contract is it handing out its own thing — `status-bar`, `terminal`, `pdf-view`.
- **`namespace.capability`** when your package offers two or more contracts, or when a bare name would not say what crosses the boundary. The usual case is a hub collecting plugins: the namespace belongs to the hub even though the hub is the _consumer_, so `spell-check` provides `linter.provider`. The tell is who declares `providedServices` — if that is you and you are handing out your own API, go bare.
- The namespace is a **general domain rather than a package name** when more than one package could reasonably implement the contract. `icons.provider` has two providers and belongs to neither; `symbol.document-provider` is shared by document symbol sources. Drop a `-view`/`-panel` suffix when a real domain word remains, keep it when none does — hence `outline.provider` but `tree-view.selection`.

The method is `provide`/`consume` plus the PascalCased name, dropping a trailing `provider` segment because the verb already says it: `linter.provider` → `provideLinter`, `icons.provider` → `provideIcons`.

## Contracts

Each service's canonical contract belongs in the repository of the package that owns it, normally as `docs/<service-name>.md` and, for core services, under `lumine/docs/services/`. This keeps the shape, required fields and example beside the implementation. The editor exposes package documentation under Settings → the package → Documentation.

## Contextual help

`documentation-view` owns the context-help domain. Sources provide [`context-help.provider`](https://github.com/lumine-code/documentation-view/blob/master/docs/context-help.provider.md); views consume [`context-help.registry`](https://github.com/lumine-code/documentation-view/blob/master/docs/context-help.registry.md) to request and render combined answers. A view can also consume [`context-help.panel`](https://github.com/lumine-code/documentation-view/blob/master/docs/context-help.panel.md) to open its existing answer in the documentation dock without another provider request.

Providers implement `getHelp(editor, position, {signal})` and optionally `getGutterHelp(editor, row, {signal})`. Each call owns its cancellation state so a tooltip request cannot cancel a simultaneous panel request. Custom content returns a `render()` factory that creates fresh DOM, with an optional disposer, for each surface. Consumers dispose their own rendering when it closes.

This replaces `hover.provider` during preproduction. Migrate providers and consumers directly to the context-help contracts; there are no compatibility aliases. `hover.signature-provider` remains the independent contract for function signature help.

## Jupyter integrations

The nine Jupyter packages share kernel sessions, explicit editor contexts, owned asynchronous requests, execution receipts, and canonical output rendering. See [Jupyter services and lifecycle](https://github.com/lumine-code/jupyter-repl/blob/master/docs/3_integration.md) for package responsibilities and teardown rules.

## Workspace content

Launcher owns the `launcher.provider` contract for creating new center content. A provider publishes a descriptor during bootstrap and creates a fresh, unattached pane item when requested; Launcher captures the destination, opens the item in center, and cancels or cleans up unfinished creations when the destination or provider disappears. Core provides the Text Editor factory on the same service hub. Existing resource viewers continue to register named path openers on the workspace; creating new content and opening existing resources are independent capabilities.

The `launcher` service exposes the Open and New pickers to other packages. See the [creation provider contract](https://github.com/lumine-code/launcher/blob/master/docs/launcher.provider.md) and [picker service contract](https://github.com/lumine-code/launcher/blob/master/docs/launcher.md).
