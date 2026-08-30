const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");
const { documentFor, windowFor } = require("./dom-context");

class WindowSurface {
  constructor({ id, kind = "detached", window, document, element = null, windowService = null }) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("A window surface requires a non-empty string id");
    }
    this.id = id;
    this.kind = kind;
    this.window = windowFor(window || document);
    this.document = documentFor(document || window);
    if (!this.window || !this.document || this.window.document !== this.document) {
      throw new TypeError("A window surface requires a matching Window and Document");
    }
    this.element = element;
    this.windowService = windowService;
    this.destroyed = false;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
  }

  isPrimary() {
    return this.kind === "primary";
  }

  isDestroyed() {
    return this.destroyed;
  }

  contains(node) {
    return documentFor(node) === this.document;
  }

  onDidFocus(callback) {
    return this.emitter.on("did-focus", callback);
  }

  onDidBlur(callback) {
    return this.emitter.on("did-blur", callback);
  }

  focus() {
    if (this.destroyed) return;
    this.windowService?.focus?.();
    this.window.focus?.();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
}

class WindowSurfaceManager {
  constructor() {
    this.surfacesById = new Map();
    this.surfacesByDocument = new WeakMap();
    this.emitter = new Emitter();
    this.activeSurface = null;
    this.primarySurface = null;
  }

  add(surface) {
    if (!(surface instanceof WindowSurface)) {
      throw new TypeError("WindowSurfaceManager only accepts WindowSurface instances");
    }
    if (this.surfacesById.has(surface.id)) {
      throw new Error(`A window surface named '${surface.id}' already exists`);
    }
    if (this.surfacesByDocument.has(surface.document)) {
      throw new Error("A Document can belong to only one window surface");
    }
    if (surface.isPrimary() && this.primarySurface) {
      throw new Error("A workspace can have only one primary window surface");
    }

    this.surfacesById.set(surface.id, surface);
    this.surfacesByDocument.set(surface.document, surface);
    if (surface.isPrimary()) this.primarySurface = surface;
    if (!this.activeSurface || surface.document.hasFocus?.()) this.activate(surface);

    const focus = () => this.activate(surface);
    const focusIn = () => this.activate(surface);
    const blur = () => surface.emitter.emit("did-blur", surface);
    surface.window.addEventListener("focus", focus);
    surface.window.addEventListener("blur", blur);
    surface.document.addEventListener("focusin", focusIn);
    surface.subscriptions.add({
      dispose: () => {
        surface.window.removeEventListener("focus", focus);
        surface.window.removeEventListener("blur", blur);
        surface.document.removeEventListener("focusin", focusIn);
      },
    });

    this.emitter.emit("did-add-surface", surface);
    return surface;
  }

  remove(surfaceOrId) {
    const surface =
      typeof surfaceOrId === "string" ? this.surfacesById.get(surfaceOrId) : surfaceOrId;
    if (!surface || this.surfacesById.get(surface.id) !== surface) return false;
    this.surfacesById.delete(surface.id);
    this.surfacesByDocument.delete(surface.document);
    if (this.primarySurface === surface) this.primarySurface = null;
    if (this.activeSurface === surface) {
      this.activeSurface = this.primarySurface || this.surfacesById.values().next().value || null;
      this.emitter.emit("did-change-active-surface", this.activeSurface);
    }
    this.emitter.emit("did-remove-surface", surface);
    surface.destroy();
    return true;
  }

  activate(surface) {
    if (!surface || this.surfacesById.get(surface.id) !== surface || surface.isDestroyed()) return;
    if (this.activeSurface !== surface) {
      this.activeSurface = surface;
      this.emitter.emit("did-change-active-surface", surface);
    }
    surface.emitter.emit("did-focus", surface);
  }

  get(id) {
    return this.surfacesById.get(id) || null;
  }

  getAll() {
    return Array.from(this.surfacesById.values());
  }

  getPrimary() {
    return this.primarySurface;
  }

  getActive() {
    return this.activeSurface || this.primarySurface;
  }

  surfaceFor(value) {
    return this.surfacesByDocument.get(documentFor(value)) || null;
  }

  onDidAddSurface(callback) {
    return this.emitter.on("did-add-surface", callback);
  }

  onDidRemoveSurface(callback) {
    return this.emitter.on("did-remove-surface", callback);
  }

  onDidChangeActiveSurface(callback) {
    return this.emitter.on("did-change-active-surface", callback);
  }

  destroy() {
    for (const surface of this.getAll()) this.remove(surface);
    this.emitter.dispose();
  }
}

module.exports = { WindowSurface, WindowSurfaceManager };
