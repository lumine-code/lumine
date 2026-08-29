const path = require("path");
const { pathToFileURL } = require("url");

const scriptLoadsByDocument = new WeakMap();

function isDocument(value) {
  return Boolean(value && value.nodeType === 9 && value.defaultView);
}

function isWindow(value) {
  return Boolean(value && value.window === value && value.document);
}

function documentFor(value) {
  if (isDocument(value)) return value;
  if (isWindow(value)) return value.document;
  if (isDocument(value?.ownerDocument)) return value.ownerDocument;
  if (isDocument(value?.document)) return value.document;
  return null;
}

function windowFor(value) {
  if (isWindow(value)) return value;
  return documentFor(value)?.defaultView || null;
}

function isElement(value) {
  if (!value || value.nodeType !== 1) return false;
  const domWindow = windowFor(value);
  return Boolean(domWindow && value instanceof domWindow.Element);
}

function activeElementFor(value) {
  return documentFor(value)?.activeElement || null;
}

function customEventFor(target, type, options) {
  const CustomEventConstructor = windowFor(target)?.CustomEvent;
  if (!CustomEventConstructor) {
    throw new TypeError("A DOM target with a live Window is required to create an event");
  }
  return new CustomEventConstructor(type, options);
}

function eventPhaseFor(target, name) {
  return windowFor(target)?.Event?.[name];
}

function createElementFor(target, tagName, options) {
  const document = documentFor(target);
  if (!document) throw new TypeError("A DOM target with an ownerDocument is required");
  return document.createElement(tagName, options);
}

function scriptURL(document, source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("A script source must be a non-empty path or URL");
  }
  if (path.isAbsolute(source)) return pathToFileURL(source).href;
  return new URL(source, document.baseURI).href;
}

function globalValue(domWindow, name) {
  if (!name) return domWindow;
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("A script global must be a non-empty dotted name");
  }
  let value = domWindow;
  for (const part of name.split(".")) value = value?.[part];
  if (value === undefined) throw new Error(`Script loaded without defining window.${name}`);
  return value;
}

async function loadScript(target, source, { global } = {}) {
  const document = documentFor(target);
  const domWindow = windowFor(document);
  if (!document?.head || !domWindow || domWindow.closed) {
    throw new Error("Cannot load a script into a closed or detached Document");
  }
  const url = scriptURL(document, source);
  let loads = scriptLoadsByDocument.get(document);
  if (!loads) {
    loads = new Map();
    scriptLoadsByDocument.set(document, loads);
  }
  let loaded = loads.get(url);
  if (!loaded) {
    loaded = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      const closePoll = globalThis.setInterval(() => {
        if (domWindow.closed) didClose();
      }, 100);
      const cleanup = () => {
        globalThis.clearInterval(closePoll);
        script.removeEventListener("load", didLoad);
        script.removeEventListener("error", didFail);
        domWindow.removeEventListener("beforeunload", didClose);
      };
      const didLoad = () => {
        cleanup();
        resolve();
      };
      const didFail = () => {
        cleanup();
        reject(new Error(`Failed to load script ${url}`));
      };
      const didClose = () => {
        cleanup();
        reject(new Error(`Document closed while loading script ${url}`));
      };
      script.addEventListener("load", didLoad, { once: true });
      script.addEventListener("error", didFail, { once: true });
      domWindow.addEventListener("beforeunload", didClose, { once: true });
      document.head.appendChild(script);
    });
    // Keep the settled promise: an executed UMD bundle is a document-level
    // singleton, and a failed source must not be retried behind the caller's
    // back with partially initialized globals left in that realm.
    loads.set(url, loaded);
  }
  await loaded;
  if (domWindow.closed) throw new Error(`Document closed after loading script ${url}`);
  return globalValue(domWindow, global);
}

/**
 * @public
 * @status extended
 *
 * Realm-safe DOM helpers available through `lumine.dom`.
 */
class DomContext {
  /**
   * @public
   * @status extended
   *
   * Resolve the live `Document` that owns a Window, DOM node, or document-like object.
   *
   * @param {Document|Window|Node|Object} value - A DOM value or object carrying a `document` or `ownerDocument`.
   * @returns {Document|null} The owning live Document, or `null` when none can be resolved.
   */
  static documentFor(value) {
    return documentFor(value);
  }

  /**
   * @public
   * @status extended
   *
   * Resolve the live `Window` that owns a Window, Document, DOM node, or document-like object.
   *
   * @param {Document|Window|Node|Object} value - A DOM value or object carrying a `document` or `ownerDocument`.
   * @returns {Window|null} The owning live Window, or `null` when none can be resolved.
   */
  static windowFor(value) {
    return windowFor(value);
  }

  /**
   * @public
   * @status extended
   *
   * Load a script once in a specific Document and optionally return the global it defines in that Window. Filesystem paths are converted to `file:` URLs. A secondary realm never falls back to the primary renderer's `require()`.
   *
   * @param {Document|Window|Node} target - A value resolving to the destination Document.
   * @param {string} source - An absolute filesystem path or URL.
   * @param {Object} [options] - Script loading options.
   * @param {string} [options.global] - A dotted Window-global name to return after the script loads.
   * @returns {Promise<*>} The requested global, or the destination Window when no global name is supplied.
   */
  static async loadScript(target, source, options) {
    return loadScript(target, source, options);
  }
}

Object.assign(DomContext, {
  activeElementFor,
  createElementFor,
  customEventFor,
  eventPhaseFor,
  isDocument,
  isElement,
  isWindow,
});

module.exports = DomContext;
