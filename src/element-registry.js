const { Disposable } = require("@lumine-code/event-kit");
const { windowFor } = require("./dom-context");

// Custom-element constructors are tied to the Window whose HTMLElement they
// extend. Store factories, not constructors, so every workspace surface gets a
// constructor from its own realm.
module.exports = class ElementRegistry {
  constructor() {
    this.definitions = new Map();
    this.windows = new Set();
    this.installedNamesByWindow = new WeakMap();
  }

  define(name, factory, options) {
    if (typeof name !== "string" || !name.includes("-")) {
      throw new TypeError("A custom-element name must contain a hyphen");
    }
    if (typeof factory !== "function") {
      throw new TypeError("A custom-element definition must be a Window-local class factory");
    }
    if (this.definitions.has(name)) {
      throw new Error(`A custom-element factory is already registered for '${name}'`);
    }

    const definition = { name, factory, options };
    this.definitions.set(name, definition);
    for (const domWindow of this.windows) this.installDefinition(domWindow, definition);

    return new Disposable(() => {
      // The platform has no undefine operation. Disposal prevents installation
      // into future surfaces; definitions already installed in live documents
      // remain valid until those documents are destroyed.
      if (this.definitions.get(name) === definition) this.definitions.delete(name);
    });
  }

  addWindow(value) {
    const domWindow = windowFor(value);
    if (!domWindow?.customElements) {
      throw new TypeError("A live Window with a CustomElementRegistry is required");
    }
    if (this.windows.has(domWindow)) return new Disposable();

    this.windows.add(domWindow);
    this.installedNamesByWindow.set(domWindow, new Set());
    for (const definition of this.definitions.values()) {
      this.installDefinition(domWindow, definition);
    }

    return new Disposable(() => {
      this.windows.delete(domWindow);
      this.installedNamesByWindow.delete(domWindow);
    });
  }

  installDefinition(domWindow, definition) {
    const installedNames = this.installedNamesByWindow.get(domWindow);
    if (!installedNames || installedNames.has(definition.name)) return;

    const constructor = definition.factory({
      window: domWindow,
      document: domWindow.document,
      HTMLElement: domWindow.HTMLElement,
    });
    if (typeof constructor !== "function") {
      throw new TypeError(`The factory for '${definition.name}' did not return a constructor`);
    }
    if (!(constructor.prototype instanceof domWindow.HTMLElement)) {
      throw new TypeError(
        `The constructor for '${definition.name}' must extend the target Window's HTMLElement`,
      );
    }

    const existing = domWindow.customElements.get(definition.name);
    if (existing) {
      if (existing !== constructor) {
        throw new Error(
          `Custom element '${definition.name}' was defined outside the Lumine element registry`,
        );
      }
      installedNames.add(definition.name);
      return;
    }

    domWindow.customElements.define(definition.name, constructor, definition.options);
    installedNames.add(definition.name);
  }

  destroy() {
    this.definitions.clear();
    this.windows.clear();
    this.installedNamesByWindow = new WeakMap();
  }
};
