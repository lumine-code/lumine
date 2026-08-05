const { Emitter, Disposable } = require("event-kit");
const crypto = require("crypto");
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const { createStylesElement } = require("./styles-element");
const {
  transformDeprecatedShadowDOMSelectors,
  transformDeprecatedMathUsage,
} = require("./deprecated-style-transforms");

// Extended: A singleton instance of this class available via `atom.styles`,
// which you can use to globally query and observe the set of active style
// sheets. The `StyleManager` doesn't add any style elements to the DOM on its
// own, but is instead subscribed to by individual `<atom-styles>` elements,
// which clone and attach style elements in different contexts.
module.exports = class StyleManager {
  constructor() {
    this.emitter = new Emitter();
    this.styleElements = [];
    this.styleElementsBySourcePath = {};
    this.deprecationsBySourcePath = {};
  }

  initialize({ configDirPath }) {
    this.configDirPath = configDirPath;
    if (this.configDirPath != null) {
      this.cacheDirPath = path.join(this.configDirPath, "compile-cache", "style-manager");
    }
  }

  /*
  Section: Event Subscription
  */

  // Extended: Invoke `callback` for all current and future style elements.
  //
  // * `callback` {Function} that is called with style elements.
  //   * `styleElement` An `HTMLStyleElement` instance. The `.sheet` property
  //     will be null because this element isn't attached to the DOM. If you want
  //     to attach this element to the DOM, be sure to clone it first by calling
  //     `.cloneNode(true)` on it. The style element will also have the following
  //     non-standard properties:
  //     * `sourcePath` A {String} containing the path from which the style
  //       element was loaded.
  //     * `context` A {String} indicating the target context of the style
  //       element.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to cancel the
  // subscription.
  observeStyleElements(callback) {
    for (let styleElement of this.getStyleElements()) {
      callback(styleElement);
    }

    return this.onDidAddStyleElement(callback);
  }

  // Extended: Invoke `callback` when a style element is added.
  //
  // * `callback` {Function} that is called with style elements.
  //   * `styleElement` An `HTMLStyleElement` instance. The `.sheet` property
  //     will be null because this element isn't attached to the DOM. If you want
  //     to attach this element to the DOM, be sure to clone it first by calling
  //     `.cloneNode(true)` on it. The style element will also have the following
  //     non-standard properties:
  //     * `sourcePath` A {String} containing the path from which the style
  //       element was loaded.
  //     * `context` A {String} indicating the target context of the style
  //       element.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to cancel the
  // subscription.
  onDidAddStyleElement(callback) {
    return this.emitter.on("did-add-style-element", callback);
  }

  // Extended: Invoke `callback` when a style element is removed.
  //
  // * `callback` {Function} that is called with style elements.
  //   * `styleElement` An `HTMLStyleElement` instance.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to cancel the
  // subscription.
  onDidRemoveStyleElement(callback) {
    return this.emitter.on("did-remove-style-element", callback);
  }

  // Extended: Invoke `callback` when an existing style element is updated.
  //
  // * `callback` {Function} that is called with style elements.
  //   * `styleElement` An `HTMLStyleElement` instance. The `.sheet` property
  //      will be null because this element isn't attached to the DOM. The style
  //      element will also have the following non-standard properties:
  //     * `sourcePath` A {String} containing the path from which the style
  //       element was loaded.
  //     * `context` A {String} indicating the target context of the style
  //       element.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to cancel the
  // subscription.
  onDidUpdateStyleElement(callback) {
    return this.emitter.on("did-update-style-element", callback);
  }

  onDidUpdateDeprecations(callback) {
    return this.emitter.on("did-update-deprecations", callback);
  }

  /*
  Section: Reading Style Elements
  */

  // Extended: Get all loaded style elements.
  getStyleElements() {
    return this.styleElements.slice();
  }

  addStyleSheet(source, params = {}) {
    let styleElement;
    let updated;
    if (params.sourcePath != null && this.styleElementsBySourcePath[params.sourcePath] != null) {
      updated = true;
      styleElement = this.styleElementsBySourcePath[params.sourcePath];
    } else {
      updated = false;
      styleElement = document.createElement("style");
      if (params.sourcePath != null) {
        styleElement.sourcePath = params.sourcePath;
        styleElement.setAttribute("source-path", params.sourcePath);
      }
      if (params.context != null) {
        styleElement.context = params.context;
        styleElement.setAttribute("context", params.context);
      }
      if (params.priority != null) {
        styleElement.priority = params.priority;
        styleElement.setAttribute("priority", params.priority);
      }
    }

    let textContent = source;
    let deprecationMessages = [];

    // The deprecated-style transformations upgrade stylesheets authored as
    // Less for older versions of the editor. Hand-authored plain CSS must
    // never be rewritten — the math transform in particular can mangle
    // data: URIs and modern CSS functions.
    const lessSource = params.sourcePath == null || path.extname(params.sourcePath) === ".less";

    if (lessSource && !params.skipDeprecatedSelectorsTransformation) {
      const transformed = this.upgradeStyleSheet(
        textContent,
        params.context,
        transformDeprecatedShadowDOMSelectors,
      );

      textContent = transformed.source;
      deprecationMessages.push(transformed.deprecationMessage);
    }

    if (lessSource && !params.skipDeprecatedMathUsageTransformation) {
      const transformed = this.upgradeStyleSheet(
        textContent,
        params.context,
        transformDeprecatedMathUsage,
      );

      textContent = transformed.source;
      deprecationMessages.push(transformed.deprecationMessage);
    }

    // Once done with any and all transformations we can apply our new textContent
    styleElement.textContent = textContent;

    // Reduce the deprecation messages array to remove any null, undefined, or empty text values
    // Anything not 'truthy'
    deprecationMessages = deprecationMessages.filter((ele) => ele);

    if (deprecationMessages.length > 0) {
      // we do in fact have deprecations
      let deprecationMsg = deprecationMessages.join("\n");

      this.deprecationsBySourcePath[params.sourcePath] = {
        message: deprecationMsg,
      };
      this.emitter.emit("did-update-deprecations");
    }

    if (updated) {
      this.emitter.emit("did-update-style-element", styleElement);
    } else {
      this.addStyleElement(styleElement);
    }

    return new Disposable(() => {
      this.removeStyleElement(styleElement);
    });
  }

  addStyleElement(styleElement) {
    let insertIndex = this.styleElements.length;
    if (styleElement.priority != null) {
      for (let i = 0; i < this.styleElements.length; i++) {
        const existingElement = this.styleElements[i];
        if (existingElement.priority > styleElement.priority) {
          insertIndex = i;
          break;
        }
      }
    }

    this.styleElements.splice(insertIndex, 0, styleElement);
    if (
      styleElement.sourcePath != null &&
      this.styleElementsBySourcePath[styleElement.sourcePath] == null
    ) {
      this.styleElementsBySourcePath[styleElement.sourcePath] = styleElement;
    }
    this.emitter.emit("did-add-style-element", styleElement);
  }

  removeStyleElement(styleElement) {
    const index = this.styleElements.indexOf(styleElement);
    if (index !== -1) {
      this.styleElements.splice(index, 1);
      if (styleElement.sourcePath != null) {
        delete this.styleElementsBySourcePath[styleElement.sourcePath];
      }
      this.emitter.emit("did-remove-style-element", styleElement);
    }
  }

  // Applies one of the transformations in `./deprecated-style-transforms`,
  // memoizing the result on disk so a style sheet is only transformed once.
  upgradeStyleSheet(styleSheet, context, transform) {
    if (this.cacheDirPath != null) {
      const hash = crypto.createHash("sha1");
      // The transform has to be part of the key. Both transforms run over the
      // same style sheet in turn, and the second one sees the first one's
      // output unchanged whenever the first is a no-op — so keying on the
      // source alone makes the second read back the first's cached result and
      // never run at all.
      hash.update(transform.name);
      if (context != null) {
        hash.update(context);
      }
      hash.update(styleSheet);
      const cacheFilePath = path.join(this.cacheDirPath, hash.digest("hex"));
      try {
        return JSON.parse(fs.readFileSync(cacheFilePath));
      } catch {
        const transformed = transform(styleSheet, context);
        fs.writeFileSync(cacheFilePath, JSON.stringify(transformed));
        return transformed;
      }
    } else {
      return transform(styleSheet, context);
    }
  }

  getDeprecations() {
    return this.deprecationsBySourcePath;
  }

  clearDeprecations() {
    this.deprecationsBySourcePath = {};
  }

  getSnapshot() {
    return this.styleElements.slice();
  }

  restoreSnapshot(styleElementsToRestore) {
    for (let styleElement of this.getStyleElements()) {
      if (!styleElementsToRestore.includes(styleElement)) {
        this.removeStyleElement(styleElement);
      }
    }

    const existingStyleElements = this.getStyleElements();
    for (let styleElement of styleElementsToRestore) {
      if (!existingStyleElements.includes(styleElement)) {
        this.addStyleElement(styleElement);
      }
    }
  }

  buildStylesElement() {
    const stylesElement = createStylesElement();
    stylesElement.initialize(this);
    return stylesElement;
  }

  /*
  Section: Paths
  */

  // Extended: Get the path of the user style sheet in `~/.lumine`.
  //
  // Returns a {String}.
  getUserStyleSheetPath() {
    if (this.configDirPath == null) {
      return "";
    } else {
      const stylesheetPath = fs.resolve(path.join(this.configDirPath, "styles"), ["css"]);
      if (fs.isFileSync(stylesheetPath)) {
        return stylesheetPath;
      } else {
        return path.join(this.configDirPath, "styles.css");
      }
    }
  }
};
