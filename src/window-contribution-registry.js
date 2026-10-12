const { Disposable } = require("@lumine-code/event-kit");

/**
 * @public
 * @status public
 *
 * Owns window-local instances of service contributions. A registration targets
 * the main window by default; all-window registrations include future windows.
 */
module.exports = class WindowContributionRegistry {
  constructor({ workspace, mount }) {
    this.workspace = workspace;
    this.mount = mount;
    this.registrations = new Set();
    this.windows = new Map();
    this.disposed = false;
    this.observation = workspace.observeWindows((editorWindow) => this.addWindow(editorWindow));
  }

  addWindow(editorWindow) {
    if (this.disposed || this.windows.has(editorWindow)) return;
    const subscription = editorWindow.onWillDestroy(() => {
      const errors = [];
      for (const registration of this.registrations) {
        try {
          this.removeInstance(registration, editorWindow);
        } catch (error) {
          errors.push(error);
        }
      }
      this.windows.delete(editorWindow);
      subscription.dispose();
      if (errors.length)
        throw new AggregateError(errors, "Unable to release window contributions.");
    });
    this.windows.set(editorWindow, subscription);
    for (const registration of this.registrations) this.addInstance(registration, editorWindow);
  }

  /** @category Registering Contributions */

  /**
   * @public
   * @status public
   *
   * Register a factory for independent presentation instances.
   * @param {Object} options - windows, create and service-specific mount options.
   * @param {String} options.windows - main (default) or all.
   * @param {Function} options.create - Receives window, document, workspace and editorContainer.
   * @returns {Disposable} Removes all instances and future mounts.
   */
  add(options) {
    return this.addRegistration(options, true);
  }

  /**
   * @public
   * @status public
   *
   * Own the lifetime of a service client's window-local controller.
   * @param {Object} options - windows (main by default) and create(context).
   * @param {Function} options.create - Returns a Disposable owning that window's UI.
   * @returns {Disposable} Releases current clients and prevents future creation.
   */
  observe(options) {
    return this.addRegistration(options, false);
  }

  /** @private */
  addRegistration(options, mountDOM) {
    if (this.disposed) throw new Error("The window contribution service has been disposed.");
    const windows = options.windows ?? "main";
    if (!["main", "all"].includes(windows) || typeof options.create !== "function")
      throw new TypeError("A contribution requires create(context) and windows main or all.");
    const registration = { options: { ...options, windows }, mountDOM, instances: new Map() };
    this.registrations.add(registration);
    const disposable = new Disposable(() => {
      this.registrations.delete(registration);
      const errors = [];
      for (const editorWindow of [...registration.instances.keys()]) {
        try {
          this.removeInstance(registration, editorWindow);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Unable to remove window contributions.");
    });
    try {
      for (const editorWindow of this.windows.keys()) this.addInstance(registration, editorWindow);
    } catch (error) {
      disposable.dispose();
      throw error;
    }
    return disposable;
  }

  addInstance(registration, editorWindow) {
    if (registration.options.windows === "main" && !editorWindow.isMain()) return;
    const instance = registration.options.create({
      window: editorWindow,
      document: editorWindow.getDocument(),
      workspace: this.workspace,
      editorContainer: editorWindow.getEditorContainer(),
    });
    if (
      !instance ||
      typeof instance.dispose !== "function" ||
      (registration.mountDOM && (!instance.element || instance.element.nodeType !== 1))
    ) {
      instance?.dispose?.();
      throw new TypeError("A window contribution factory must return {element, dispose()}.");
    }
    if (
      registration.mountDOM &&
      [...registration.instances.values()].some(
        (entry) => entry.instance.element === instance.element,
      )
    ) {
      if (![...registration.instances.values()].some((entry) => entry.instance === instance))
        instance.dispose();
      throw new Error("Each window contribution must have an independent DOM element.");
    }
    try {
      const mounted = registration.mountDOM
        ? this.mount(editorWindow, { ...registration.options, item: instance.element })
        : null;
      registration.instances.set(editorWindow, { instance, mounted });
    } catch (error) {
      instance.dispose();
      throw error;
    }
  }

  removeInstance(registration, editorWindow) {
    const entry = registration.instances.get(editorWindow);
    if (!entry) return;
    registration.instances.delete(editorWindow);
    const errors = [];
    for (const release of [() => entry.mounted?.destroy(), () => entry.instance.dispose()]) {
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Unable to release a window contribution.");
  }

  /**
   * @public
   * @status public
   *
   * Release the service and all its current and future presentation instances.
   * @category Lifecycle
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.observation.dispose();
    const errors = [];
    for (const registration of this.registrations) {
      for (const editorWindow of [...registration.instances.keys()]) {
        try {
          this.removeInstance(registration, editorWindow);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this.registrations.clear();
    for (const subscription of this.windows.values()) subscription.dispose();
    this.windows.clear();
    if (errors.length)
      throw new AggregateError(errors, "Unable to dispose window contribution service.");
  }
};
