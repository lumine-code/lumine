const { Disposable } = require("@lumine-code/event-kit");
const {
  setTimeout: scheduleBackgroundUpdate,
  clearTimeout: cancelBackgroundUpdate,
} = require("node:timers");

const AnyConstructor = Symbol("any-constructor");

/**
 * @public
 * @status essential
 *
 * `ViewRegistry` handles the association between model and view
 * types in Lumine. We call this association a View Provider. As in, for a given
 * model, this class can provide a view via {@link #getView}, as long as the
 * model/view association was registered via {@link #addViewProvider}
 *
 * If you're adding your own kind of pane item, a good strategy for all but the
 * simplest items is to separate the model and the view. The model handles
 * application logic and is the primary point of API interaction. The view
 * just handles presentation.
 *
 * Note: Models can be any object, but must implement a `getTitle()` function
 * if they are to be displayed in a {@link Pane}
 *
 * View providers inform the workspace how your model objects should be
 * presented in the DOM. A view provider must always return a DOM node, which
 * makes [HTML 5 custom elements](http://www.html5rocks.com/en/tutorials/webcomponents/customelements/)
 * an ideal tool for implementing views in Lumine.
 *
 * You can access the `ViewRegistry` object via `lumine.views`.
 */
module.exports = class ViewRegistry {
  #participantGeneration = null;

  constructor(lumineEnvironment) {
    this.animationFrameRequest = null;
    this.documentReadInProgress = false;
    this.performDocumentUpdate = this.performDocumentUpdate.bind(this);
    this.handlePresentationVisibilityChange = this.handlePresentationVisibilityChange.bind(this);
    this.lumineEnvironment = lumineEnvironment;
    this.clear();
  }

  clear() {
    for (const observer of this.participantObservers?.values() ?? []) observer.disconnect();
    this.views = new WeakMap();
    this.paneItemDocuments = new WeakMap();
    this.windowParticipants = new Map();
    this.#participantGeneration = {};
    this.participantDocuments = new WeakMap();
    this.participantObservers = new Map();
    this.retiredPresentationWindows = new WeakSet();
    this.providers = [];
    this.clearDocumentRequests();
  }

  /** @private Rebind presentation-only listeners after initial mounting or DOM adoption. */
  didAttachPaneItem(item, pane, element) {
    if (this.paneItemDocuments.get(item) === element.ownerDocument) return;
    const window = pane.getContainer()?.getWindow();
    if (!window || window.getDocument() !== element.ownerDocument) return;
    const result = item.didAttachToWindow?.({ window, document: element.ownerDocument });
    if (result?.then)
      throw new TypeError("didAttachToWindow must bind presentation listeners synchronously.");
    this.paneItemDocuments.set(item, element.ownerDocument);
    for (const [root, participant] of this.windowParticipants)
      if (root === element || element.contains(root))
        this.bindWindowParticipant(root, participant, window);
  }

  /**
   * @public
   * @status public
   *
   * Register a presentation component that needs state preparation across documents.
   * Disposing its registration allows the same DOM root to be registered again.
   * @param {Element} root - The component's DOM root within a pane item.
   * @param {Object} participant - prepareWindowChange, didAttachToWindow, didChangeWindow and cancelWindowChange callbacks.
   * @returns {Disposable} Removes this component's lifecycle participation.
   * @category Window Participants
   */
  addWindowParticipant(root, participant) {
    if (this.windowParticipants.has(root))
      throw new Error("The presentation component is already registered.");
    const generation = this.#participantGeneration;
    this.windowParticipants.set(root, participant);
    this.participantDocuments.delete(root);
    const unregister = () => {
      // clear() starts a new generation, even when it reuses this root and participant.
      if (this.#participantGeneration !== generation) return;
      if (this.windowParticipants.get(root) !== participant) return;
      this.windowParticipants.delete(root);
      this.participantDocuments.delete(root);
    };
    try {
      this.attachPresentationDocument(root.ownerDocument);
      if (root.isConnected) {
        const window = this.lumineEnvironment.workspace.getWindowForElement(root);
        if (window) this.bindWindowParticipant(root, participant, window);
      }
    } catch (error) {
      unregister();
      throw error;
    }
    return new Disposable(unregister);
  }

  /** @private Rebind embedded components created or adopted after their pane first mounted. */
  attachPresentationDocument(document) {
    if (this.participantObservers.has(document)) return new Disposable();
    const refresh = () => {
      const workspace = this.lumineEnvironment?.workspace;
      if (!workspace || workspace.isAlive?.() === false) return;
      const window = workspace.getWindows().find((window) => window.getDocument() === document);
      if (!window) return;
      for (const [root, participant] of this.windowParticipants)
        if (root.isConnected && root.ownerDocument === document)
          this.bindWindowParticipant(root, participant, window);
    };
    const observer = new document.defaultView.MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    this.participantObservers.set(document, observer);
    return new Disposable(() => {
      observer.disconnect();
      if (this.participantObservers.get(document) === observer)
        this.participantObservers.delete(document);
    });
  }

  bindWindowParticipant(root, participant, window) {
    const documents = this.participantDocuments;
    if (documents.get(root) === root.ownerDocument) return;
    participant.didAttachToWindow?.({ window, document: root.ownerDocument });
    documents.set(root, root.ownerDocument);
  }

  /** @private Capture an item and its registered embedded presentation components together. */
  async preparePaneItemWindowChange(item, context) {
    const view = this.getView(item);
    const entries = new Set([
      item,
      ...[...this.windowParticipants]
        .filter(([root]) => root === view || view.contains(root))
        .map(([, participant]) => participant),
    ]);
    const states = [];
    const {
      awaitLifecycleCleanup,
      captureLifecycleError,
      throwLifecycleErrors,
    } = require("./package-lifecycle-errors");
    try {
      for (const participant of entries) {
        try {
          states.push({ participant, state: await participant.prepareWindowChange?.(context) });
        } catch (error) {
          if (!context.sourceUnavailable) throw error;
          context.onRecoveryError?.(error);
          states.push({ participant, skip: true });
        }
      }
    } catch (error) {
      const errors = [error];
      for (const { participant, state } of states) {
        await awaitLifecycleCleanup(errors, () =>
          participant.cancelWindowChange?.({ ...context, state }),
        );
        captureLifecycleError(errors, () => {
          if (typeof state?.dispose === "function") state.dispose();
        });
      }
      throwLifecycleErrors(errors, "Unable to prepare the pane item's presentation components.");
    }
    return {
      async didChange(context) {
        const errors = [];
        for (const { participant, state, skip } of states) {
          if (skip) continue;
          if (context.rollback)
            await awaitLifecycleCleanup(errors, () =>
              participant.didChangeWindow?.({ ...context, state }),
            );
          else await participant.didChangeWindow?.({ ...context, state });
        }
        throwLifecycleErrors(errors, "Unable to restore the pane item's presentation components.");
      },
      async cancel() {
        const errors = [];
        for (const { participant, state } of states)
          await awaitLifecycleCleanup(errors, () =>
            participant.cancelWindowChange?.({ ...context, state }),
          );
        throwLifecycleErrors(errors, "Unable to cancel the presentation preparations.");
      },
      dispose() {
        const errors = [];
        for (const { state } of states)
          captureLifecycleError(errors, () => {
            if (typeof state?.dispose === "function") state.dispose();
          });
        throwLifecycleErrors(errors, "Unable to release the presentation preparations.");
      },
    };
  }

  /**
   * @category Views
   */

  /**
   * @public
   * @status essential
   *
   * Register a factory that creates DOM views for model objects.
   *
   * ## Examples
   *
   * ```js
   * class Message {
   *   constructor(text) { this.text = text; }
   * }
   * const subscription = lumine.views.addViewProvider(Message, (model) => {
   *   const element = document.createElement('div');
   *   element.textContent = model.text;
   *   return element;
   * });
   * const view = lumine.views.getView(new Message('Hello'));
   * ```
   *
   * @param {Function} [modelConstructor] - Constructor `Function` for your model. If a constructor is given, the `createView` function will only be used for model objects inheriting from that constructor. Otherwise, it will be called for any object.
   * @param {Function} createView - Factory `Function` that is passed an instance of your model and must return a DOM element or `undefined`. If it returns `undefined`, then the registry will continue to search for other view providers.
   * @returns {Disposable} Dispose to remove the added provider.
   */
  addViewProvider(modelConstructor, createView) {
    let provider;
    if (arguments.length === 1) {
      switch (typeof modelConstructor) {
        case "function":
          provider = {
            createView: modelConstructor,
            modelConstructor: AnyConstructor,
          };
          break;
        default:
          throw new TypeError("Arguments to addViewProvider must be functions");
      }
    } else {
      provider = { modelConstructor, createView };
    }

    this.providers.push(provider);
    return new Disposable(() => {
      this.providers = this.providers.filter((p) => p !== provider);
    });
  }

  getViewProviderCount() {
    return this.providers.length;
  }

  /**
   * @public
   * @status essential
   *
   * Get the view associated with an object in the workspace.
   *
   * If you're just *using* the workspace, you shouldn't need to access the view
   * layer, but view layer access may be necessary if you want to perform DOM
   * manipulation that isn't supported via the model API.
   *
   * ## View Resolution Algorithm
   *
   * The view associated with the object is resolved using the following
   * sequence
   *
   *  1. Is the object an instance of `HTMLElement`? If true, return the object.
   *  2. Does the object have a method named `getElement` that returns an
   *     instance of `HTMLElement`? If true, return that value.
   *  3. Does the object have a property named `element` with a value which is
   *     an instance of `HTMLElement`? If true, return the property value.
   *  4. Is the object a jQuery object, indicated by the presence of a `jquery`
   *     property? If true, return the root DOM element (i.e. `object[0]`).
   *  5. Has a view provider been registered for the object? If true, use the
   *     provider to create a view associated with the object, and return the
   *     view.
   *
   * If no associated view is returned by the sequence an error is thrown.
   *
   * @param {Object|Element|null|undefined} object - A model or DOM element whose view is requested.
   * @returns {Element|undefined} The DOM element, or `undefined` for a null or undefined input.
   */
  getView(object) {
    if (object == null) {
      return;
    }

    let view = this.views.get(object);
    if (!view) {
      view = this.createView(object);
      this.views.set(object, view);
    }
    return view;
  }

  createView(object) {
    if (object?.nodeType === 1 && object.ownerDocument) {
      return object;
    }

    let element;
    if (object && typeof object.getElement === "function") {
      element = object.getElement();
      if (element?.nodeType === 1 && element.ownerDocument) {
        return element;
      }
    }

    if (object?.element?.nodeType === 1 && object.element.ownerDocument) {
      return object.element;
    }

    if (object && object.jquery) {
      return object[0];
    }

    for (let provider of this.providers) {
      if (provider.modelConstructor === AnyConstructor) {
        element = provider.createView(object, this.lumineEnvironment);
        if (element) {
          return element;
        }
        continue;
      }

      if (object instanceof provider.modelConstructor) {
        element = provider.createView && provider.createView(object, this.lumineEnvironment);
        if (element) {
          return element;
        }

        let ViewConstructor = provider.viewConstructor;
        if (ViewConstructor) {
          element = new ViewConstructor();
          if (element.initialize) {
            element.initialize(object);
          } else if (element.setModel) {
            element.setModel(object);
          }
          return element;
        }
      }
    }

    if (object && object.getViewClass) {
      let ViewConstructor = object.getViewClass();
      if (ViewConstructor) {
        const view = new ViewConstructor(object);
        return view[0];
      }
    }

    throw new Error(
      `Can't create a view for ${
        object.constructor.name
      } instance. Please register a view provider.`,
    );
  }

  updateDocument(fn) {
    this.documentWriters.push(fn);
    if (!this.documentReadInProgress) {
      this.requestDocumentUpdate();
    }
    return new Disposable(() => {
      this.documentWriters = this.documentWriters.filter((writer) => writer !== fn);
    });
  }

  readDocument(fn) {
    this.documentReaders.push(fn);
    this.requestDocumentUpdate();
    return new Disposable(() => {
      this.documentReaders = this.documentReaders.filter((reader) => reader !== fn);
    });
  }

  getNextUpdatePromise() {
    if (this.nextUpdatePromise == null) {
      this.nextUpdatePromise = new Promise((resolve) => {
        this.resolveNextUpdatePromise = resolve;
      });
    }

    return this.nextUpdatePromise;
  }

  clearDocumentRequests() {
    this.documentReaders = [];
    this.documentWriters = [];
    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;
    if (this.animationFrameRequest != null) {
      this.cancelDocumentUpdate();
      this.animationFrameRequest = null;
    }
  }

  requestDocumentUpdate() {
    if (this.animationFrameRequest == null) {
      const workspace = this.lumineEnvironment?.workspace;
      const presentations =
        workspace
          ?.getWindows?.()
          .map((window) => window.getDOMWindow?.())
          .filter(Boolean) ?? [];
      const focused = workspace?.getFocusedWindow()?.getDOMWindow?.();
      const candidates = [
        presentations.includes(focused) ? focused : null,
        this.preferredAnimationFrameWindow,
        ...presentations,
        this.lumineEnvironment?.document?.defaultView,
      ];
      if (!presentations.length) candidates.push(globalThis.window);
      this.animationFrameWindow =
        candidates.find(
          (window) =>
            window &&
            window.document &&
            typeof window.requestAnimationFrame === "function" &&
            typeof window.cancelAnimationFrame === "function" &&
            !window.closed &&
            !this.retiredPresentationWindows.has(window) &&
            window.document.visibilityState !== "hidden",
        ) ?? null;
      this.animationFrameDocument = this.animationFrameWindow?.document;
      this.animationFrameCancel = this.animationFrameWindow?.cancelAnimationFrame.bind(
        this.animationFrameWindow,
      );
      this.removeAnimationFrameWindowListener =
        this.animationFrameWindow?.removeEventListener?.bind(this.animationFrameWindow);
      this.animationFrameDocument?.addEventListener?.(
        "visibilitychange",
        this.handlePresentationVisibilityChange,
      );
      this.animationFrameWindow?.addEventListener?.(
        "pagehide",
        this.handlePresentationVisibilityChange,
      );
      this.animationFrameRequest = this.animationFrameWindow
        ? this.animationFrameWindow.requestAnimationFrame(this.performDocumentUpdate)
        : scheduleBackgroundUpdate(this.performDocumentUpdate, 16);
    }
  }

  /** @private Release either a visible presentation's frame or the shared runtime's background timer. */
  cancelDocumentUpdate() {
    this.removeDocumentUpdateListeners();
    if (this.animationFrameCancel) this.animationFrameCancel(this.animationFrameRequest);
    else cancelBackgroundUpdate(this.animationFrameRequest);
  }

  /** @private Move a pending frame if its presentation disappears before paint. */
  handlePresentationVisibilityChange(event) {
    if (this.animationFrameRequest == null) return;
    if (event.type !== "pagehide" && this.animationFrameDocument?.visibilityState !== "hidden")
      return;
    if (event.type === "pagehide") this.retiredPresentationWindows.add(this.animationFrameWindow);
    this.cancelDocumentUpdate();
    this.animationFrameRequest = null;
    this.requestDocumentUpdate();
  }

  /** @private Release listeners owned by the current scheduled frame. */
  removeDocumentUpdateListeners() {
    this.animationFrameDocument?.removeEventListener?.(
      "visibilitychange",
      this.handlePresentationVisibilityChange,
    );
    this.removeAnimationFrameWindowListener?.("pagehide", this.handlePresentationVisibilityChange);
    this.animationFrameDocument = this.removeAnimationFrameWindowListener = null;
  }

  /** @private Keep active auxiliary presentation independent of an occluded opener. */
  setAnimationFrameWindow(domWindow) {
    this.preferredAnimationFrameWindow = domWindow;
    if (this.animationFrameRequest != null) {
      this.cancelDocumentUpdate();
      this.animationFrameRequest = null;
      this.requestDocumentUpdate();
    }
  }

  performDocumentUpdate() {
    this.removeDocumentUpdateListeners();
    this.animationFrameWindow = null;
    this.animationFrameCancel = null;
    const { resolveNextUpdatePromise } = this;
    this.animationFrameRequest = null;
    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;

    let writer = this.documentWriters.shift();
    while (writer) {
      writer();
      writer = this.documentWriters.shift();
    }

    let reader = this.documentReaders.shift();
    this.documentReadInProgress = true;
    while (reader) {
      reader();
      reader = this.documentReaders.shift();
    }
    this.documentReadInProgress = false;

    // process updates requested as a result of reads
    writer = this.documentWriters.shift();
    while (writer) {
      writer();
      writer = this.documentWriters.shift();
    }

    if (resolveNextUpdatePromise) {
      resolveNextUpdatePromise();
    }
  }
};
