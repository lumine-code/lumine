const { CompositeDisposable } = require("@lumine-code/event-kit");
const { documentFor } = require("./dom-context");

module.exports = class StyleMount {
  constructor(styleManager, target, { context = null } = {}) {
    this.styleManager = styleManager;
    this.document = documentFor(target);
    if (!this.document?.head) throw new TypeError("A style mount requires a document with a head");
    this.context = context;
    this.elementsBySource = new Map();
    this.subscriptions = new CompositeDisposable();
    this.element = this.document.createElement("lumine-styles");
    if (context != null) this.element.setAttribute("context", context);
    this.document.head.appendChild(this.element);

    this.subscriptions.add(
      styleManager.observeStyleElements((source) => this.add(source)),
      styleManager.onDidUpdateStyleElement((source) => this.update(source)),
      styleManager.onDidRemoveStyleElement((source) => this.remove(source)),
    );
  }

  matches(source) {
    return this.context == null || source.context === this.context;
  }

  createElement(source) {
    const element = this.document.createElement("style");
    element.textContent = source.textContent;
    for (const attribute of ["source-path", "context", "priority"]) {
      if (source.hasAttribute?.(attribute)) {
        element.setAttribute(attribute, source.getAttribute(attribute));
      }
    }
    element.sourcePath = source.sourcePath;
    element.context = source.context;
    element.priority = source.priority;
    return element;
  }

  add(source) {
    if (!this.matches(source) || this.elementsBySource.has(source)) return;
    const element = this.createElement(source);
    let reference = null;
    if (element.priority != null) {
      reference = Array.from(this.element.querySelectorAll("style[priority]")).find(
        (candidate) =>
          Number(candidate.priority ?? candidate.getAttribute("priority")) > element.priority,
      );
    }
    this.element.insertBefore(element, reference);
    this.elementsBySource.set(source, element);
  }

  update(source) {
    const element = this.elementsBySource.get(source);
    if (element) element.textContent = source.textContent;
  }

  remove(source) {
    const element = this.elementsBySource.get(source);
    if (!element) return;
    this.elementsBySource.delete(source);
    element.remove();
  }

  getElementForSource(source) {
    return this.elementsBySource.get(source) || null;
  }

  dispose() {
    this.subscriptions.dispose();
    for (const element of this.elementsBySource.values()) element.remove();
    this.elementsBySource.clear();
    this.element.remove();
  }
};
