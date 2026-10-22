const _ = require("@lumine-code/underscore-plus");
const path = require("path");
const { fileURLToPath } = require("url");
const { Emitter, Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const fs = require("@lumine-code/fs-plus");
const ProjectDirectory = require("./project-directory");
const RipgrepDirectorySearcher = require("./ripgrep-directory-searcher");
const Dock = require("./dock");
const Model = require("./model");
const StateStore = require("./state-store");
const TextEditor = require("./text-editor");
const NullGrammar = require("./null-grammar");
const Panel = require("./panel");
const PanelContainer = require("./panel-container");
const ModalFlow = require("./modal-flow");
const Task = require("./task");
const WorkspaceCenter = require("./workspace-center");
const EditorWindow = require("./editor-window");
const transferPaneLayout = require("./pane-window-transfer");
const { fileEditorForItem, embeddedEditorForItem } = require("./item-text-editors");
const { confirmItemsClose } = require("./pane-item-close-batch");
const { createWorkspaceElement } = require("./workspace-element");
const layoutDrag = require("./layout-drag");
// Builds detached dialog models and their optional modal hosts with this
// window's services.
const ModalDialogFactory = require("./modal-dialog-factory");
const FileDocumentRegistry = require("./file-document-registry");
const ItemOpenRequestManager = require("./item-open-request-manager");
const ItemRegistry = require("./item-registry");
const CommandAvailabilityObserver = require("./command-availability-observer");
const { AlwaysIgnoredNames, compile, merge } = require("./ignored-names");
const { defaultLocationForItem, allowedLocationsForItem } = require("./pane-item-locations");
const { captureLifecycleError, throwLifecycleErrors } = require("./package-lifecycle-errors");

const PATH_KINDS = ["file", "directory"];
const OPEN_DESTINATIONS = ["current", "new-window", "detached-window"];

function protocolForURI(uri) {
  try {
    return new URL(uri).protocol;
  } catch {
    return null;
  }
}

function isPathURI(uri) {
  if (typeof uri !== "string" || !uri) return false;
  if (path.isAbsolute(uri)) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1].toLowerCase();
  return !scheme || scheme === "file";
}

function pathOpenerPredicate(callback, uri, options) {
  const result = callback(uri, options);
  if (typeof result !== "boolean") {
    throw new TypeError("Path opener predicates must return a boolean synchronously");
  }
  return result;
}

function normalizePathOpening(uri, options = {}) {
  if (typeof uri === "string" && /^file:/i.test(uri)) {
    const url = new URL(uri);
    if (url.hash && options.uriFragment == null) options = { ...options, uriFragment: url.hash };
    uri = fileURLToPath(url);
  }
  return { uri, options };
}

// Given a path pattern like `foo/bar/baz` and a list of the current root path
// basenames, reinterprets the path pattern and decides which root(s) it refers
// to.
//
// We need to do this when there are multiple project roots, since the first
// segment may tell us which root is being targeted.
//
// Returns a two-item array. The first item is the root basename to which the
// pattern applies, or `null` if it applies to all roots. The second item is
// the normalized path exclusion to pass along to the searcher when applicable.
//
// Exclusions can be interpreted in the same manner and will be correctly
// normalized.
//
// Examples:
//
// If `foo` is in `rootBasenames`, pattern `foo/bar` will be reinterpreted to
// `bar`; `['foo', 'bar']` will be returned.
//
// If `foo` is in `rootBasenames`, pattern `!foo/bar` will be reinterpreted to
// `!bar`; `['foo', '!bar']` will be returned.
//
// If `foo` _is not_ in `rootBasenames`, pattern `foo/bar` will remain as-is;
// `[null, 'foo/bar']` will be returned.
//
// If `foo` _is not_ in `rootBasenames`, pattern `!foo/bar` will remain as-is;
// `[null, '!foo/bar']` will be returned.
//
function extractProjectRootsFromPathPattern(pathPattern, rootBasenames) {
  let negated = pathPattern.startsWith("!");
  if (negated) {
    pathPattern = pathPattern.substring(1);
  }
  let prefix = negated ? "!" : "";
  let normalized = pathPattern.replace(/\\/g, "/");
  let originalPathPattern = normalized;
  if (pathPattern === "") return [null, ""];
  let rootBasename;
  if (!normalized.includes("/")) {
    rootBasename = normalized;
    pathPattern = "";
  } else {
    let index = normalized.indexOf("/");
    rootBasename = normalized.substring(0, index);
    pathPattern = normalized.slice(index + 1);
  }

  if (rootBasenames.includes(rootBasename)) {
    return [rootBasename, `${prefix}${pathPattern}`];
  }
  return [null, `${prefix}${originalPathPattern}`];
}

function getBasenamesFromProjectRoots() {
  let roots = lumine.project.getPaths();
  return roots.map((r) => path.basename(r));
}

const STOPPED_CHANGING_ACTIVE_PANE_ITEM_DELAY = 100;
const ALL_LOCATIONS = ["center", "left", "right", "bottom"];
const DOCK_LOCATIONS = ["left", "right", "bottom"];

/**
 * @public
 * @status essential
 *
 * Manages the shared workspace and its presentation windows.
 * An instance of this class is available via the `lumine.workspace` global.
 *
 * Interact with this object to open files, be notified of current and future
 * editors, and manipulate panes. To add panels, use {@link Workspace#addTopPanel}
 * and friends.
 *
 * ## Workspace Items
 *
 * The term "item" refers to anything that can be displayed
 * in a pane within the workspace, either in the {@link WorkspaceCenter} or in one
 * of the three {@link Dock Docks}. The workspace expects items to conform to the
 * following interface:
 *
 * ### Required Methods
 *
 * #### `getTitle()`
 *
 * Returns a `String` containing the title of the item to display on its
 * associated tab.
 *
 * ### Optional Methods
 *
 * #### `copy({signal})`
 *
 * Returns a fresh live item or a Promise for one, with an independent detached
 * view root. If omitted, copy and split-copy operations silently resolve to
 * null without changing panes, focus or preview state. Focus and move,
 * including split-move, remain available. Views may share
 * their underlying document, but own their subscriptions, selection and viewport.
 * Honor the AbortSignal before publishing a copy and release abandoned resources.
 * Serialization and URI openers are not substitutes for this copy contract.
 * Copy factories capture document and view state before awaiting initialization.
 * Retargeting items emit `onDidChangeURI` after every document publication, even
 * if its URI returns to an earlier value. Moving and copying promote previews
 * only after committing and invoke `terminatePendingState()` to cancel pending reuse.
 *
 * #### `canCopy()`
 *
 * Returns a Boolean to restrict an item's copy capability. Returning false
 * silently skips copy and split-copy without notifications or changes to panes,
 * focus or preview state. If omitted, a callable `copy()` method enables copying.
 * Returning true does not enable copying when the item has no `copy()` method.
 *
 * #### `getSingletonKey()`
 *
 * Returns a namespaced non-empty String to allow one item per logical resource
 * in this workspace. A constant key identifies a workspace tool; a resource key
 * permits separate result sets. Omit it or return null when uniqueness is not
 * required. Resource uniqueness is independent of copy capability.
 * Changing a singleton key emits `onDidChangeSingletonKey`, or `onDidChangeURI`
 * when the key follows the URI. Reopening a key activates its existing item.
 *
 * #### `getPaneItemRevision()`
 *
 * Returns a monotonic document revision so asynchronous copies detect document
 * replacement with an unchanged URI. Omit it when the item does not retarget its
 * document, or use `onDidChangeURI` when its URI always changes with the document.
 *
 * #### Presentation window lifecycle
 *
 * `didAttachToWindow({window, document})` synchronously binds presentation-only
 * listeners after first mounting or DOM adoption. Use that document and its
 * defaultView for UI, while retaining workspace-owned models and resources.
 *
 * `prepareWindowChange({sourceWindow, targetWindow})` may asynchronously capture
 * state that DOM adoption cannot retain, such as an iframe's browsing context.
 * Its returned state is passed to `didChangeWindow({...context, state})` after
 * movement. Rollback invokes that method with reversed windows and
 * `rollback: true`; a preparation cancelled before movement invokes
 * `cancelWindowChange({...context, state})`. A returned state may implement
 * `dispose()` to release temporary resources after commit or rollback.
 * These methods preserve the live document, terminal or kernel; they do not
 * reopen an item through its URI. Layout mutations in participating windows
 * remain locked while their presentation operation is pending.
 *
 * `getPaneItemDocument()` may return a shared document object used by independent
 * views. Close batches confirm that document once, passing `lastView` to
 * `shouldPromptToSave`. Text editors use their buffer as the document identity.
 *
 * #### `getElement()`
 *
 * If your item already *is* a DOM element, you do not need to implement this
 * method. Otherwise it should return the element you want to display to
 * represent this item.
 *
 * #### `destroy()`
 *
 * Destroys the item. This will be called when the item is removed from its
 * parent pane.
 *
 * #### `onDidDestroy(callback)`
 *
 * Called by the workspace so it can be notified when the item is destroyed.
 * Must return a `Disposable`.
 *
 * #### `serialize()`
 *
 * Serialize the state of the item. Must return an object that can be passed to
 * `JSON.stringify`. The state should include a field called `deserializer`,
 * which names a deserializer declared in your `package.json`. This method is
 * invoked on items when serializing the workspace so they can be restored to
 * the same location later.
 *
 * #### `getURI()`
 *
 * Returns the URI associated with the item.
 *
 * #### `onDidChangeURI(callback)`
 *
 * Notifies the workspace when the item begins representing a different URI.
 * Emit after committing the new document, and return a `Disposable`.
 * The workspace publishes {@link Workspace#onDidChangePaneItemURI} for consumers
 * whose context depends on the document rather than the item identity.
 *
 * #### `getLongTitle()`
 *
 * Returns a `String` containing a longer version of the title to display in
 * places like the window title or on tabs their short titles are ambiguous.
 *
 * #### `onDidChangeTitle(callback)`
 *
 * Called by the workspace so it can be notified when the item's title changes.
 * Must return a `Disposable`.
 *
 * #### `getIconName()`
 *
 * Return a `String` with the semantic name of an icon. The icon registry
 * resolves that name to a descriptor, so an icon provider may render it as
 * classes, an image, SVG, or a letter.
 *
 * ### `onDidChangeIcon(callback)`
 *
 * Called by the icon binding so it can be notified when the item's icon
 * changes. Must return a `Disposable`.
 *
 * #### `getDefaultLocation()`
 *
 * Tells the workspace where your item should be opened in absence of a user
 * override. Items can appear in the center or in a dock on the left, right, or
 * bottom of the workspace.
 *
 * Returns a `String` with one of the following values: `'center'`, `'left'`,
 * `'right'`, `'bottom'`. If this method is not defined, `'center'` is the
 * default.
 *
 * #### `getAllowedLocations()`
 *
 * Tells the workspace where this item can be moved. Returns an `Array` of one
 * or more of the following values: `'center'`, `'left'`, `'right'`, or
 * `'bottom'`. If this method is not defined, the item is allowed only in the
 * location returned by `getDefaultLocation()`, or in `'center'` when that
 * method is not defined either.
 *
 * #### `getDefaultVisibility()`
 *
 * Declares the initial visibility of a dock item registered with
 * {@link Workspace#addDefaultDockItem}. Returns `"visible"` to show it in a new
 * layout, or `"project-or-empty"` to show it when opening a project (including
 * a project with files) or starting without requested documents. Opening only
 * files does not show a `"project-or-empty"` item. An absent method, `undefined`, `false`
 * or `"manual"` leaves opening to the user.
 *
 * Saved dock layouts take precedence, including hidden docks and closed items.
 * Defaults never take focus or replace an existing dock item. They run once
 * during initial startup, not after later file openings or package activation.
 * Explicit {@link Workspace#open} calls do not consult this method.
 *
 * #### `isPersistentDockItem()`
 *
 * Tells the workspace that this item should survive restoring a saved
 * workspace layout into the current window. Persistent items are carried over
 * to the restored layout instead of being destroyed along with the previous
 * one. Unlike permanent dock items, the user can still close them at any time.
 *
 * #### `isPermanentDockItem()`
 *
 * Tells the workspace whether or not this item can be closed by the user by
 * clicking an `x` on its tab. Use of this feature is discouraged unless there's
 * a very good reason not to allow users to close your item. Items can be made
 * permanent *only* when they are contained in docks. Center pane items can
 * always be removed. Note that it is currently still possible to close dock
 * items via the `Close Pane` option in the context menu and via Lumine APIs, so
 * you should still be prepared to handle your dock items being destroyed by the
 * user even if you implement this method.
 *
 * #### `save()`
 *
 * Saves the item.
 *
 * #### `saveAs(path)`
 *
 * Saves the item to the specified path.
 *
 * #### `getPath()`
 *
 * Returns the local path associated with this item. This is only used to set
 * the initial location of the "save as" dialog.
 *
 * #### `getFileState()`
 *
 * Returns one mutually exclusive state string: `"unmodified"` when the document
 * matches its saved base, `"modified"` when it has local changes, `"conflicted"`
 * when it has diverged from its backing file, or `"removed"` when its backing
 * file no longer exists.
 *
 * #### `onDidChangeFileState(callback)`
 *
 * Called by the workspace so it can be notified when the item's file state
 * changes. The callback receives the new state. Must return a `Disposable`.
 *
 * #### `getPreferredHeight()`
 *
 * If this item is displayed in the bottom {@link Dock}, called by the workspace when
 * initially displaying the dock to set its height. Once the dock has been
 * resized by the user, their height will override this value.
 *
 * Returns a `Number`.
 *
 * #### `getPreferredWidth()`
 *
 * If this item is displayed in the left or right {@link Dock}, called by the
 * workspace when initially displaying the dock to set its width. Once the dock
 * has been resized by the user, their width will override this value.
 *
 * Returns a `Number`.
 *
 * #### `onDidTerminatePendingState(callback)`
 *
 * If the workspace is configured to use *pending pane items*, the workspace
 * will subscribe to this method to terminate the pending state of the item.
 * Must return a `Disposable`.
 *
 * #### `shouldPromptToSave()`
 *
 * This method indicates whether Lumine should prompt the user to save this item
 * when the user closes or reloads the window. Returns a boolean.
 */
module.exports = class Workspace extends Model {
  #itemOpenRequests;
  #projectStateChanges = new Set();
  #resettingItemOpens = 0;
  #layoutGeneration = 0;
  #paneItemRegistry = new ItemRegistry();
  #windowLifecycleChanging = false;
  #windowCleanupDepth = 0;
  #pendingWindowOpens = new Set();
  #windowOperationOpenOptions = new WeakSet();
  #windowRestoreOpenOptions = new WeakSet();
  #pathOpenerResolutionListeners = new Set();
  #defaultDockItems = new Set();
  #defaultDockItemsPrepared = false;
  #defaultDockItemsApplied = false;

  constructor(params) {
    super(...arguments);

    this.disposables = new CompositeDisposable();
    this.updateDocumentEdited = this.updateDocumentEdited.bind(this);
    this.didDestroyPaneItem = this.didDestroyPaneItem.bind(this);
    this.didChangeActivePaneOnPaneContainer = this.didChangeActivePaneOnPaneContainer.bind(this);
    this.didChangeActivePaneItemOnPaneContainer =
      this.didChangeActivePaneItemOnPaneContainer.bind(this);
    this.didActivatePaneContainer = this.didActivatePaneContainer.bind(this);

    this.enablePersistence = params.enablePersistence;
    this.packageManager = params.packageManager;
    this.config = params.config;
    this.commandRegistry = params.commandRegistry;
    this.project = params.project;
    this.fileDocuments = new FileDocumentRegistry();
    this.fileMoveReadiness = Promise.resolve();
    this.disposables.add(this.fileDocuments);
    this.observeFileDocuments();
    this.notificationManager = params.notificationManager;
    this.viewRegistry = params.viewRegistry;
    this.modalDialogServices = {
      workspace: this,
      config: params.config,
      commandRegistry: params.commandRegistry,
      keymapManager: params.keymapManager,
      tooltipManager: params.tooltipManager,
      textEditorRegistry: params.textEditorRegistry,
      textEditorFactory: params.textEditorFactory,
      applicationDelegate: params.applicationDelegate,
    };
    this.modalDialogFactory = new ModalDialogFactory(this.modalDialogServices);
    this.grammarRegistry = params.grammarRegistry;
    this.applicationDelegate = params.applicationDelegate;
    this.assert = params.assert;
    this.deserializerManager = params.deserializerManager;
    this.textEditorRegistry = params.textEditorRegistry;
    this.textEditorFactory = params.textEditorFactory;
    this.styleManager = params.styleManager;
    this.draggingItem = false;
    this.itemLocationStore = new StateStore("LuminePreviousItemLocations", 1);

    this.emitter = new Emitter();
    this.openers = [];
    this.openerReuseCapabilities = new Map();
    this.pathOpeners = [];
    this.pathOpenerItems = new WeakMap();
    this.textPathOpener = {
      id: "text-editor",
      label: "Text Editor",
      pathKinds: ["file"],
      destinations: [...OPEN_DESTINATIONS],
      handlesItem: (item) => item instanceof TextEditor,
    };
    this.projectPathOpener = {
      id: "project-folder",
      label: "Project Folder",
      pathKinds: ["directory"],
      destinations: ["current", "new-window"],
      opener: async (uri) => {
        await this.project.setState([uri]);
        return "";
      },
    };
    this.#itemOpenRequests = new ItemOpenRequestManager({
      isAvailable: () =>
        this.isAlive() && this.#resettingItemOpens === 0 && !this.projectStateChanging,
    });
    this.paneItemURIs = new WeakMap();
    this.destroyedItemURIs = [];
    this.longTitles = null;
    this.stoppedChangingActivePaneItemTimeout = null;
    this.grammarUsageEntries = new Map();
    this.registeredGrammarUsageLeases = new Map();
    this.activeItemGrammarUsageLeases = new Map();
    this.paneDocumentsAwaitingGrammarObservation = new WeakSet();
    this.registeredTextEditorGrammarSubscription = null;

    this.ripgrepDirectorySearcher = new RipgrepDirectorySearcher();
    this.consumeServices(this.packageManager);

    this.paneContainers = {
      center: this.createCenter(),
      left: this.createDock("left"),
      right: this.createDock("right"),
      bottom: this.createDock("bottom"),
    };
    this.activePaneContainer = this.paneContainers.center;
    this.hasActiveTextEditor = false;
    this.previousActiveFileTextEditor = undefined;
    this.previousActiveEmbeddedTextEditor = undefined;

    this.panelContainers = {
      top: new PanelContainer({
        viewRegistry: this.viewRegistry,
        location: "top",
      }),
      left: new PanelContainer({
        viewRegistry: this.viewRegistry,
        location: "left",
        dock: this.paneContainers.left,
      }),
      right: new PanelContainer({
        viewRegistry: this.viewRegistry,
        location: "right",
        dock: this.paneContainers.right,
      }),
      bottom: new PanelContainer({
        viewRegistry: this.viewRegistry,
        location: "bottom",
        dock: this.paneContainers.bottom,
      }),
      header: new PanelContainer({
        viewRegistry: this.viewRegistry,
        location: "header",
      }),
      footer: new PanelContainer({
        viewRegistry: this.viewRegistry,
        location: "footer",
      }),
      modal: new PanelContainer({
        viewRegistry: this.viewRegistry,
        location: "modal",
      }),
    };

    this.incoming = new Map();
    this.editorWindows = new Set();
    this.mainEditorWindow = null;
    this.windowOperations = new Map();
  }

  /** @private Wire the physical main window at the environment composition root. */
  initializeEditorWindows(windowService, domWindow) {
    this.windowService = windowService;
    const main = new EditorWindow({
      workspace: this,
      editorContainer: this.getCenter().paneContainer,
      windowService,
      main: true,
    });
    this.mainEditorWindow = main;
    for (const location of ["left", "right", "bottom"]) {
      this.paneContainers[location].paneContainer.editorWindow = main;
    }
    if (domWindow) main.setPresentation(domWindow, this.element ?? null);
    this.registerEditorWindow(main);
    return main;
  }

  /** @private Publish a fully owned presentation to current and future UI clients. */
  registerEditorWindow(editorWindow) {
    if (editorWindow.getWorkspace() !== this || this.editorWindows.has(editorWindow)) {
      throw new TypeError("An editor window must belong to this workspace exactly once.");
    }
    this.editorWindows.add(editorWindow);
    const subscription = editorWindow.onDidDestroy(() => {
      this.editorWindows.delete(editorWindow);
      this.disposables.remove(subscription);
      subscription.dispose();
      this.emitter.emit("did-remove-window", editorWindow);
    });
    this.disposables.add(subscription);
    this.emitter.emit("did-add-window", editorWindow);
  }

  /**
   * @public
   * @status public
   *
   * Get this workspace's main presentation window.
   * @returns {EditorWindow|null} The main window, or null before window initialization.
   * @category Windows
   */
  getMainWindow() {
    return this.mainEditorWindow;
  }

  /**
   * @public
   * @status public
   *
   * Get all presentation windows belonging to this workspace.
   * @returns {Array<EditorWindow>} The current windows.
   * @category Windows
   */
  getWindows() {
    return [...this.editorWindows];
  }

  /**
   * @public
   * @status public
   *
   * Create an additional editor window sharing this workspace's documents and packages.
   * New calls are refused while the workspace windows prepare to unload.
   * @param {Object} options - Optional native bounds and visibility.
   * @returns {Promise<EditorWindow>} The ready presentation window.
   * @category Windows
   */
  openEditorWindow(options = {}) {
    const completingOperation = this.#windowOperationOpenOptions.delete(options);
    const restoring = this.#windowRestoreOpenOptions.delete(options);
    if (
      this.#windowCleanupDepth > 0 ||
      (this.#windowLifecycleChanging && !completingOperation) ||
      (this.projectStateChanging && !completingOperation && !restoring)
    )
      return Promise.reject(new Error("The workspace windows are preparing to unload."));
    if (!this.editorWindowHost || !this.isAlive())
      return Promise.reject(new Error("This workspace cannot open an editor window."));
    const opening = this.editorWindowHost.open(options);
    this.#pendingWindowOpens.add(opening);
    return opening.finally(() => this.#pendingWindowOpens.delete(opening));
  }

  /** @private Prevent close and transfer from mutating the same container concurrently. */
  runWindowOperation(windows, callback) {
    if (this.windowLifecycleChanging)
      return Promise.reject(new Error("The workspace windows are preparing to unload."));
    if (windows.some((window) => this.windowOperations.has(window)))
      return Promise.reject(new Error("An editor window operation is already in progress."));
    const operation = Promise.resolve().then(callback);
    for (const window of windows) this.windowOperations.set(window, operation);
    return operation.finally(() => {
      for (const window of windows) {
        if (this.windowOperations.get(window) === operation) this.windowOperations.delete(window);
      }
    });
  }

  /** @private Keep reset/discard barriers independent of an orderly-unload gate. */
  get windowLifecycleChanging() {
    return (
      this.#windowLifecycleChanging || this.#windowCleanupDepth > 0 || this.projectStateChanging
    );
  }

  set windowLifecycleChanging(value) {
    this.#windowLifecycleChanging = value;
  }

  /** @private Temporarily exclude new pane operations while existing work is drained. */
  beginWindowCleanup() {
    this.#windowCleanupDepth++;
    return new Disposable(() => this.#windowCleanupDepth--);
  }

  /** @private Exclude unrelated opens and window transfers while replacing the center. */
  beginProjectStateChange() {
    const token = { generation: this.#layoutGeneration };
    this.#projectStateChanges.add(token);
    const release = new Disposable(() => this.#projectStateChanges.delete(token));
    try {
      this.#itemOpenRequests.reset();
      return release;
    } catch (error) {
      release.dispose();
      throw error;
    }
  }

  /** @private A reset's replacement layout does not inherit an obsolete transition gate. */
  get projectStateChanging() {
    return [...this.#projectStateChanges].some(
      (token) => token.generation === this.#layoutGeneration,
    );
  }

  /** @private A synchronous mutation phase excludes external layout changes during transfer. */
  runWindowMutation(callback) {
    this.windowMutationDepth = (this.windowMutationDepth ?? 0) + 1;
    try {
      return callback();
    } finally {
      this.windowMutationDepth--;
    }
  }

  /** @private Finish transfers before serializing or releasing the shared runtime. */
  async whenWindowOperationsIdle({ prepareToUnload = true } = {}) {
    if (prepareToUnload) this.windowLifecycleChanging = true;
    while (this.windowOperations.size > 0 || this.#pendingWindowOpens.size > 0)
      await Promise.allSettled([
        ...new Set([...this.windowOperations.values(), ...this.#pendingWindowOpens]),
      ]);
  }

  /**
   * @public
   * @status public
   *
   * Observe current and future presentation windows of this workspace.
   * @param {Function} callback - Receives each EditorWindow once.
   * @returns {Disposable} Removes the observation.
   * @category Event Subscription
   */
  observeWindows(callback) {
    for (const editorWindow of this.getWindows()) callback(editorWindow);
    return this.emitter.on("did-add-window", callback);
  }

  /**
   * @public
   * @status public
   *
   * Get the presentation window whose document currently has focus.
   * @returns {EditorWindow|null} The focused window, or null when the workspace lacks focus.
   * @category Windows
   */
  getFocusedWindow() {
    return this.getWindows().find((editorWindow) => editorWindow.getDocument()?.hasFocus()) ?? null;
  }

  /**
   * @public
   * @status public
   *
   * Get the presentation containing a DOM element, including embedded frames.
   * @param {Element} element - An element belonging to a workspace presentation.
   * @returns {EditorWindow|null} The owning presentation.
   * @category Windows
   */
  getWindowForElement(element) {
    let ownerDocument = element?.ownerDocument;
    while (ownerDocument) {
      const presentation = this.getWindows().find(
        (candidate) => candidate.getDocument() === ownerDocument,
      );
      if (presentation) return presentation;
      try {
        ownerDocument = ownerDocument.defaultView?.frameElement?.ownerDocument;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * @public
   * @status public
   *
   * Capture a command's presentation and document targets before asynchronous work.
   * @param {Event|Element} eventOrElement - The dispatch event or original DOM target.
   * @returns {Object} window, pane, item, editor, fileEditor and embeddedEditor.
   * @category Command Context
   */
  resolveCommandContext(eventOrElement) {
    const target = eventOrElement?.target ?? eventOrElement;
    const window =
      this.getWindowForElement(target) ?? this.getFocusedWindow() ?? this.getMainWindow();
    let element = target?.nodeType === 1 ? target : target?.parentElement;
    let pane = null;
    while (element) {
      const candidate = element.closest?.("lumine-pane")?.getModel?.();
      if (candidate && this.getPanes().includes(candidate)) {
        pane = candidate;
        break;
      }
      try {
        element = element.ownerDocument?.defaultView?.frameElement;
      } catch {
        break;
      }
    }
    const documentPane =
      pane?.getContainer().getLocation() === "center"
        ? pane
        : pane
          ? this.getCenter().getActivePane()
          : (window?.getEditorContainer().getActivePane() ?? this.getCenter().getActivePane());
    pane ??= documentPane;
    const documentItem = documentPane?.getActiveItem();
    const directEditor = this.getTextEditorForElement(target, { includeMini: false });
    return Object.freeze({
      window,
      pane,
      item: pane?.getActiveItem(),
      editor: directEditor ?? (documentItem instanceof TextEditor ? documentItem : undefined),
      fileEditor: fileEditorForItem(documentItem),
      embeddedEditor: directEditor ?? embeddedEditorForItem(documentItem),
      documentPane,
      documentItem,
    });
  }

  /**
   * @public
   * @status public
   *
   * Close an auxiliary presentation after its document panes accept closing. For the main window, forward the native close request; its save prompts run through the native window lifecycle.
   * @param {EditorWindow} editorWindow - A window belonging to this workspace.
   * @returns {Promise<Boolean>} Whether the auxiliary window closed or the main-window close request was sent. False means the window was unavailable, busy, or refused closing.
   * @category Windows
   */
  async closeEditorWindow(editorWindow) {
    if (!this.editorWindows.has(editorWindow)) return false;
    if (editorWindow.isMain()) {
      await this.windowService.close();
      return true;
    }
    const pending = this.windowOperations.get(editorWindow);
    if (pending) return false;
    return this.runWindowOperation([editorWindow], async () => {
      const container = editorWindow.getEditorContainer();
      const items = container.getPaneItems();
      if (
        !(await container.confirmClose({
          windowCloseRequested: false,
          projectHasPaths: this.project.getPaths().length > 0,
        }))
      )
        return false;
      if (
        container.getPaneItems().length !== items.length ||
        container.getPaneItems().some((item, index) => item !== items[index])
      )
        return false;
      await this.releaseEditorWindow(editorWindow);
      return true;
    });
  }

  /** @private Release an accepted close or an empty transfer source, attempting every cleanup. */
  async releaseEditorWindow(editorWindow) {
    const container = editorWindow.getEditorContainer();
    const domWindow = editorWindow.getDOMWindow();
    const errors = [];
    for (const cleanup of [
      () => this.runWindowMutation(() => container.destroy()),
      () => this.getCenter().removePaneContainer(container),
      () => editorWindow.destroy(),
      () => editorWindow.windowService.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (
      this.viewRegistry.animationFrameWindow === domWindow ||
      this.viewRegistry.preferredAnimationFrameWindow === domWindow
    )
      this.viewRegistry.setAnimationFrameWindow(this.getMainWindow()?.getDOMWindow());
    if (errors.length) throw new AggregateError(errors, "Unable to release the editor window.");
  }

  /** @private Reset/restore owns document teardown and must not ask for another close approval. */
  async discardEditorWindows() {
    const cleanup = this.beginWindowCleanup();
    try {
      // Recovery can remove its source window before native show/focus settles.
      // The surviving main container remains owned by that operation.
      await this.whenWindowOperationsIdle({ prepareToUnload: false });
      for (const window of this.getWindows().filter((window) => !window.isMain()))
        await this.releaseEditorWindow(window);
    } finally {
      cleanup.dispose();
    }
  }

  /**
   * @public
   * @status public
   *
   * Present an existing document pane in a new window without reopening its items.
   * @param {Pane} pane - A document pane belonging to this workspace.
   * @returns {Promise<EditorWindow>} The new presentation.
   * @category Windows
   */
  async detachPane(pane) {
    const source = pane?.getContainer();
    if (!source || source.getLocation() !== "center" || !this.getPanes().includes(pane))
      throw new Error("Only document panes of this workspace can be detached.");
    return this.runWindowOperation([source.getWindow()], async () => {
      // An operation queued before the unload gate must be able to finish its
      // own presentation, while unrelated public opens remain excluded.
      const options = { show: false };
      this.#windowOperationOpenOptions.add(options);
      const destination = await this.openEditorWindow(options);
      this.windowOperations.set(destination, this.windowOperations.get(source.getWindow()));
      try {
        await transferPaneLayout(this, source, destination.getEditorContainer(), [pane]);
      } catch (error) {
        if (destination.getEditorContainer().getPaneItems().length === 0)
          await this.releaseEditorWindow(destination);
        else await destination.windowService.show();
        throw error;
      } finally {
        this.windowOperations.delete(destination);
      }
      await destination.windowService.show();
      await destination.focus();
      return destination;
    });
  }

  /**
   * @public
   * @status public
   *
   * Move one exact document tab into a new editor window sharing this workspace.
   * @param {Object} item - A live center pane item.
   * @returns {Promise<EditorWindow>} The additional presentation.
   * @category Windows
   */
  async detachItem(item) {
    const pane = this.paneForItem(item);
    if (!pane || pane.getContainer().getLocation() !== "center")
      throw new Error("Only document tabs of this workspace can be detached.");
    const destination = await this.openEditorWindow({ show: false });
    try {
      await this.movePaneItem(item, {
        sourcePane: pane,
        targetPane: destination.getEditorContainer().getActivePane(),
      });
    } catch (error) {
      if (destination.getEditorContainer().getPaneItems().length === 0)
        await this.releaseEditorWindow(destination);
      else await destination.windowService.show();
      throw error;
    }
    await destination.windowService.show();
    await destination.focus();
    return destination;
  }

  /**
   * @public
   * @status public
   *
   * Reattach an additional window's complete pane layout to the main window.
   * @param {EditorWindow} editorWindow - An additional window of this workspace.
   * @returns {Promise<EditorWindow>} The main presentation after reattachment.
   * @category Windows
   */
  async attachWindow(editorWindow) {
    if (!this.editorWindows.has(editorWindow) || editorWindow.isMain())
      throw new Error("Only an additional window of this workspace can be attached.");
    const main = this.getMainWindow();
    // A newly shown window can receive its logo click before detach finishes
    // focusing it. Keep that request, but let the current layout settle first.
    for (;;) {
      const pending = [editorWindow, main]
        .map((window) => this.windowOperations.get(window))
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled([...new Set(pending)]);
      // Another queued click may already have attached or closed this window.
      if (!this.editorWindows.has(editorWindow)) return main;
    }
    return this.runWindowOperation([editorWindow, main], async () => {
      const source = editorWindow.getEditorContainer();
      await transferPaneLayout(this, source, main.getEditorContainer(), source.getPanes());
      await this.releaseEditorWindow(editorWindow);
      await main.focus();
      return main;
    });
  }

  /** @private Restore models from an unexpectedly lost native presentation. */
  async recoverClosedEditorWindow(window) {
    if (
      !this.isAlive() ||
      this.windowLifecycleChanging ||
      !this.editorWindows.has(window) ||
      window.isMain()
    )
      return;
    await this.whenWindowOperationsIdle({ prepareToUnload: false });
    if (!this.isAlive() || this.windowLifecycleChanging || window.isDestroyed()) return;
    const main = this.getMainWindow();
    await this.runWindowOperation([window, main], async () => {
      const source = window.getEditorContainer();
      const errors = [];
      await transferPaneLayout(this, source, main.getEditorContainer(), source.getPanes(), {
        sourceUnavailable: true,
        onRecoveryError: (error) => errors.push(error),
      });
      await this.releaseEditorWindow(window);
      await main.show();
      await main.focus();
      this.notificationManager.addWarning("The editor window closed unexpectedly.", {
        detail: errors.length
          ? `Its editors have been restored in the main window. Some display state could not be restored: ${errors.map((error) => error.message).join("; ")}`
          : "Its editors have been restored in the main window.",
        dismissable: true,
      });
    });
  }

  observeFileDocuments() {
    this.fileDocumentObservation?.dispose();
    this.fileDocumentObservation = this.project.observeBuffers((buffer) => {
      const registration = this.registerFileDocument({
        owner: buffer,
        getPath: () => buffer.getFileMovePath(),
        setPath: (target) => buffer.relocateFile(target),
        beginFileOperation: () => buffer.beginFileOperation(),
        endFileOperation: () => buffer.endFileOperation(),
      });
      buffer.onDidDestroy(() => registration.dispose());
    });
  }

  getElement() {
    if (!this.element) {
      this.element = createWorkspaceElement().initialize(this, {
        config: this.config,
        project: this.project,
        viewRegistry: this.viewRegistry,
        styleManager: this.styleManager,
      });
    }
    this.workspaceDropManager?.rebind(this.element);
    return this.element;
  }

  /**
   * @public
   * @status public
   *
   * Register a shared document for explicit filesystem moves in this workspace.
   *
   * @param {Object} descriptor - The document adapter.
   * @param {Object} descriptor.owner - The shared document identity.
   * @param {Function} descriptor.getPath - Return the current path.
   * @param {Function} descriptor.setPath - Retarget without resetting document state.
   * @param {Function} descriptor.beginFileOperation - Defer filesystem reactions.
   * @param {Function} descriptor.endFileOperation - Resume and reconcile reactions.
   * @returns {Disposable} The document registration.
   * @category File Operations
   */
  registerFileDocument(descriptor) {
    return this.fileDocuments.register(descriptor);
  }

  /**
   * @public
   * @status public
   *
   * Suspend affected documents and defer repository discovery before moving files. Complete the returned
   * transaction with confirmed moves, including partial results on failure.
   *
   * @param {Array<Object>} plannedRenames - Entries with oldPath, newPath and isDirectory.
   * @returns {Object} A transaction with a ready promise and an asynchronous complete(confirmedRenames) method.
   * @category File Operations
   */
  beginFileMove(plannedRenames) {
    const documents = this.fileDocuments.beginFileMove(plannedRenames);
    const repositories = this.project.repositoryRegistry.beginFileMove(plannedRenames);
    // Preparations may finish out of order, but callers start workers in the
    // planned order. Preserve that order without waiting for earlier moves to
    // finish copying. A failed preparation must not block later transactions.
    const ready = Promise.all([this.fileMoveReadiness, documents.ready, repositories.ready]).then(
      () => {},
    );
    this.fileMoveReadiness = ready.catch(() => {});
    let completion;
    return {
      ready,
      complete: (confirmedRenames = []) => {
        completion ||= (async () => {
          const failures = [];
          for (const transaction of [documents, repositories]) {
            try {
              await transaction.complete(confirmedRenames);
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length) throw new AggregateError(failures, "Unable to complete file move");
        })();
        return completion;
      },
    };
  }

  createCenter() {
    return new WorkspaceCenter({
      workspace: this,
      globalItemRegistry: this.#paneItemRegistry,
      config: this.config,
      applicationDelegate: this.applicationDelegate,
      notificationManager: this.notificationManager,
      deserializerManager: this.deserializerManager,
      viewRegistry: this.viewRegistry,
      didActivate: this.didActivatePaneContainer,
      didChangeActivePane: this.didChangeActivePaneOnPaneContainer,
      didChangeActivePaneItem: this.didChangeActivePaneItemOnPaneContainer,
      didDestroyPaneItem: this.didDestroyPaneItem,
    });
  }

  createDock(location) {
    return new Dock({
      workspace: this,
      globalItemRegistry: this.#paneItemRegistry,
      location,
      config: this.config,
      applicationDelegate: this.applicationDelegate,
      deserializerManager: this.deserializerManager,
      notificationManager: this.notificationManager,
      viewRegistry: this.viewRegistry,
      didActivate: this.didActivatePaneContainer,
      didChangeActivePane: this.didChangeActivePaneOnPaneContainer,
      didChangeActivePaneItem: this.didChangeActivePaneItemOnPaneContainer,
      didDestroyPaneItem: this.didDestroyPaneItem,
    });
  }

  reset(packageManager) {
    this.#layoutGeneration++;
    this.#clearDefaultDockItems();
    this.#defaultDockItemsPrepared = false;
    this.#defaultDockItemsApplied = false;
    this.#resettingItemOpens++;
    try {
      const domWindow = this.mainEditorWindow?.getDOMWindow();
      for (const editorWindow of this.getWindows()) editorWindow.destroy();
      this.#itemOpenRequests.reset();
      this.incoming.clear();
      this.packageManager = packageManager;
      this.fileMoveReadiness = Promise.resolve();
      void this.modalDialogFactory.destroy();
      this.modalDialogFactory = new ModalDialogFactory(this.modalDialogServices);
      this.emitter.dispose();
      this.emitter = new Emitter();

      this.registeredTextEditorGrammarSubscription?.dispose();
      this.registeredTextEditorGrammarSubscription = null;
      for (const lease of this.registeredGrammarUsageLeases.values()) lease.dispose();
      this.registeredGrammarUsageLeases.clear();

      if (this.activeItemTextEditorsSubscription) {
        this.activeItemTextEditorsSubscription.dispose();
        this.activeItemTextEditorsSubscription = null;
      }
      for (const lease of this.activeItemGrammarUsageLeases.values()) lease.dispose();
      this.activeItemGrammarUsageLeases.clear();

      this.paneContainers.center.destroy();
      this.paneContainers.left.destroy();
      this.paneContainers.right.destroy();
      this.paneContainers.bottom.destroy();

      _.values(this.panelContainers).forEach((panelContainer) => {
        panelContainer.destroy();
      });

      this.paneContainers = {
        center: this.createCenter(),
        left: this.createDock("left"),
        right: this.createDock("right"),
        bottom: this.createDock("bottom"),
      };
      this.activePaneContainer = this.paneContainers.center;
      this.hasActiveTextEditor = false;
      this.previousActiveFileTextEditor = undefined;
      this.previousActiveEmbeddedTextEditor = undefined;

      this.panelContainers = {
        top: new PanelContainer({
          viewRegistry: this.viewRegistry,
          location: "top",
        }),
        left: new PanelContainer({
          viewRegistry: this.viewRegistry,
          location: "left",
          dock: this.paneContainers.left,
        }),
        right: new PanelContainer({
          viewRegistry: this.viewRegistry,
          location: "right",
          dock: this.paneContainers.right,
        }),
        bottom: new PanelContainer({
          viewRegistry: this.viewRegistry,
          location: "bottom",
          dock: this.paneContainers.bottom,
        }),
        header: new PanelContainer({
          viewRegistry: this.viewRegistry,
          location: "header",
        }),
        footer: new PanelContainer({
          viewRegistry: this.viewRegistry,
          location: "footer",
        }),
        modal: new PanelContainer({
          viewRegistry: this.viewRegistry,
          location: "modal",
        }),
      };

      this.openers = [];
      this.openerReuseCapabilities.clear();
      this.pathOpeners = [];
      this.#pathOpenerResolutionListeners.clear();
      this.pathOpenerItems = new WeakMap();
      this.destroyedItemURIs = [];
      this.invalidateLongTitles();
      if (this.element) {
        this.element.destroy();
        this.element = null;
      }
      this.consumeServices(this.packageManager);
      if (this.windowService) {
        this.initializeEditorWindows(this.windowService, domWindow);
      }
    } finally {
      this.#resettingItemOpens--;
    }
  }

  initialize({ configDirPath }) {
    // we set originalFontSize to avoid breaking packages that might have relied on it
    this.originalFontSize = this.config.get("defaultFontSize");

    this.itemLocationStore.initialize({ configDirPath });

    this.subscribeToAddedItems();
    this.subscribeToRegisteredTextEditorGrammarUsage();
    this.subscribeToMovedItems();
    this.subscribeToDockToggling();
    this.disposables.remove(this.commandAvailabilityObserver);
    this.commandAvailabilityObserver?.dispose();
    this.commandAvailabilityObserver = new CommandAvailabilityObserver(this);
    this.disposables.add(this.commandAvailabilityObserver);
  }

  closeStateStore() {
    this.itemLocationStore.close();
  }

  consumeServices({ serviceHub }) {
    this.launcherProviderRegistration?.dispose();
    this.disposables.remove(this.launcherProviderRegistration);
    const generation = { active: true };
    const registration = serviceHub.provide("launcher.provider", {
      "1.0.0": {
        id: "text-editor",
        label: "Text Editor",
        order: 0,
        create: ({ signal } = {}) => {
          signal?.throwIfAborted();
          if (!generation.active || !this.isAlive()) {
            throw new Error("The workspace launcher provider is no longer active.");
          }
          return this.buildTextEditor();
        },
      },
    });
    this.launcherProviderRegistration = new Disposable(() => {
      generation.active = false;
      registration.dispose();
    });
    this.disposables.add(this.launcherProviderRegistration);
    this.directorySearchers = [];
    serviceHub.consume("workspace.search-provider", "^1.0.0", (provider) =>
      this.directorySearchers.unshift(provider),
    );
  }

  // Called by the Serializable mixin during serialization.
  serialize() {
    return {
      deserializer: "Workspace",
      packagesWithActiveGrammars: this.getPackageNamesWithActiveGrammars(),
      destroyedItemURIs: this.destroyedItemURIs.slice(),
      paneContainers: {
        center: this.paneContainers.center.serialize(),
        left: this.paneContainers.left.serialize(),
        right: this.paneContainers.right.serialize(),
        bottom: this.paneContainers.bottom.serialize(),
      },
    };
  }

  /**
   * @public
   * @status extended
   *
   * Register a dock item's initial visibility declaration without constructing
   * it during package activation. Call this from the package's synchronous
   * bootstrap and dispose the registration when the package deactivates.
   *
   * After the synchronous package bootstraps, the workspace calls `getItem`
   * and reads the item's `getDefaultVisibility()`. It reserves the dock's space
   * before the first workspace frame, then opens its content after layout
   * restoration. A saved dock layout takes precedence over defaults.
   * Registrations made after this initial preparation do not open automatically.
   *
   * Disposing cancels an unfinished default opening. The package retains
   * ownership of the item and is responsible for destroying it on deactivation.
   *
   * @param {Function} getItem - Return the package's current dock item synchronously.
   * @returns {Disposable} The registration to dispose when the package deactivates.
   * @category Dock Items
   */
  addDefaultDockItem(getItem) {
    if (typeof getItem !== "function") throw new TypeError("Expected a dock item factory");
    if (!this.isAlive() || this.#defaultDockItemsPrepared) return new Disposable();
    const registration = { getItem, controller: new AbortController() };
    this.#defaultDockItems.add(registration);
    return new Disposable(() => {
      this.#defaultDockItems.delete(registration);
      registration.controller.abort();
    });
  }

  // Package bootstraps are synchronous. Reserve new default docks before
  // awaiting their resources so the first center frame has its final width.
  prepareDefaultDockItems({ hasProject, hasOpenFiles, hasPaneItemTransfer } = {}) {
    if (this.#defaultDockItemsPrepared || !this.isAlive()) return;
    this.#defaultDockItemsPrepared = true;
    const generation = this.#layoutGeneration;
    const savedLocations = new Set(this.initialDockRestoreLocations);
    // Launch intent stays empty even when a package opens its welcome page
    // during activation. Requested files may not have arrived in center yet.
    const projectOrEmpty = hasProject || (!hasOpenFiles && !hasPaneItemTransfer);
    for (const registration of [...this.#defaultDockItems]) {
      const isCurrent = () =>
        this.isAlive() &&
        generation === this.#layoutGeneration &&
        this.#defaultDockItems.has(registration) &&
        !registration.controller.signal.aborted;
      try {
        if (!isCurrent() || DOCK_LOCATIONS.every((location) => savedLocations.has(location)))
          continue;
        const item = registration.getItem();
        if (!isCurrent() || !item || item.isDestroyed?.()) continue;
        if (typeof item.then === "function")
          throw new TypeError("Default dock item factories must return synchronously");
        const visibility = item.getDefaultVisibility?.();
        if (visibility == null || visibility === false || visibility === "manual") continue;
        if (visibility !== "visible" && visibility !== "project-or-empty")
          throw new TypeError(`Unknown default dock visibility: ${visibility}`);
        if (visibility === "project-or-empty" && !projectOrEmpty) continue;
        const uri = item.getURI?.();
        if (this.paneForItem(item) || (uri && this.paneForURI(uri))) continue;
        const preferredLocation = defaultLocationForItem(item);
        const allowedLocations = allowedLocationsForItem(item);
        const location = allowedLocations.includes(preferredLocation)
          ? preferredLocation
          : allowedLocations[0];
        if (!DOCK_LOCATIONS.includes(location))
          throw new TypeError("Default dock items must open in a dock");
        const dock = this.paneContainers[location];
        if (
          !isCurrent() ||
          savedLocations.has(location) ||
          dock.getPaneItems().length > 0 ||
          dock.isVisible()
        )
          continue;
        const previousSize = dock.state.size;
        dock.reserveSpaceForItem(item);
        registration.item = item;
        registration.dock = dock;
        // A user opening another item or changing visibility while resources
        // or the default opening are pending takes precedence over the default.
        const presentation = new CompositeDisposable(
          dock.onDidChangeVisible(() => registration.controller.abort()),
          dock.onDidAddPaneItem(({ item: added }) => {
            if (added !== item) registration.controller.abort();
          }),
        );
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          presentation.dispose();
          registration.controller.signal.removeEventListener("abort", release);
          if (!dock.destroyed && dock.getPaneItems().length === 0)
            dock.setState({ visible: false, size: previousSize });
        };
        registration.release = release;
        registration.controller.signal.addEventListener("abort", release, { once: true });
        if (!isCurrent()) release();
      } catch (error) {
        if (isCurrent())
          this.notificationManager.addError("Unable to open default dock item", {
            description: error.message,
            stack: error.stack,
          });
      }
    }
  }

  // Only the content waits for deserialization. Geometry was already reserved
  // synchronously, and explicit user choices keep priority throughout startup.
  async openDefaultDockItems(context) {
    if (this.#defaultDockItemsApplied || !this.isAlive()) return;
    this.prepareDefaultDockItems(context);
    this.#defaultDockItemsApplied = true;
    const generation = this.#layoutGeneration;
    for (const registration of [...this.#defaultDockItems]) {
      const { item, dock, controller } = registration;
      const isCurrent = () =>
        this.isAlive() &&
        generation === this.#layoutGeneration &&
        this.#defaultDockItems.has(registration) &&
        !controller.signal.aborted;
      try {
        if (!isCurrent() || !item || item.isDestroyed?.()) continue;
        const uri = item.getURI?.();
        if (this.paneForItem(item) || (uri && this.paneForURI(uri))) continue;
        if (dock.destroyed || this.paneContainers[dock.getLocation()] !== dock) continue;
        if (dock.getPaneItems().length > 0) continue;
        await this.open(item, {
          searchAllPanes: true,
          activatePane: false,
          activateItem: false,
          signal: controller.signal,
        });
      } catch (error) {
        if (isCurrent())
          this.notificationManager.addError("Unable to open default dock item", {
            description: error.message,
            stack: error.stack,
          });
      } finally {
        registration.release?.();
        this.#defaultDockItems.delete(registration);
      }
    }
  }

  #clearDefaultDockItems() {
    for (const registration of this.#defaultDockItems) registration.controller.abort();
    this.#defaultDockItems.clear();
    this.initialDockRestoreLocations = null;
  }

  // Apply only the saved dock shell before package activation: its size and
  // place in the workspace are visible immediately, while its pane contents
  // remain hidden until deserialization selects the final active item.
  beginInitialDockRestore(state) {
    if (this.initialDockRestoreLocations) {
      for (const location of this.initialDockRestoreLocations) {
        this.paneContainers[location].endInitialRestore();
      }
    }
    this.initialDockRestoreLocations = [];
    if (!state?.paneContainers) return;

    for (const location of DOCK_LOCATIONS) {
      const dockState = state.paneContainers[location];
      if (!dockState) continue;
      this.paneContainers[location].beginInitialRestore(dockState);
      this.initialDockRestoreLocations.push(location);
    }
  }

  endInitialDockRestore() {
    if (!this.initialDockRestoreLocations) return;
    for (const location of this.initialDockRestoreLocations) {
      this.paneContainers[location].endInitialRestore();
    }
    this.initialDockRestoreLocations = null;
  }

  // * `options` An optional `Object` that may contain the following key:
  //   * `locations` An `Array` of the pane container locations to restore.
  //     Defaults to all four. {@link Project#setState} passes `['center']`, because
  //     the docks belong to the window rather than to the project it has open.
  deserialize(state, deserializerManager, options = {}, assertCurrent = () => {}) {
    const assertLayoutCurrent = this.#layoutGuard(assertCurrent);
    assertLayoutCurrent();
    const locations = options.locations || ALL_LOCATIONS;
    const packagesWithActiveGrammars =
      state.packagesWithActiveGrammars != null ? state.packagesWithActiveGrammars : [];
    for (let packageName of packagesWithActiveGrammars) {
      const pkg = this.packageManager.getLoadedPackage(packageName);
      if (pkg != null) {
        pkg.loadGrammarsSync();
        assertLayoutCurrent();
      }
    }
    if (state.destroyedItemURIs != null) {
      this.destroyedItemURIs = state.destroyedItemURIs;
    }

    // Carry persistent items over to the restored layout instead of destroying
    // them with the current one. The detach, teardown, restore, and re-attach
    // all happen in the same tick so the swap causes no visible flicker.
    const restoringLayout = state.paneContainers;
    const persistentItems = [];
    try {
      if (restoringLayout) {
        this.detachPersistentDockItems(locations, persistentItems, assertLayoutCurrent);
        assertLayoutCurrent();
        this.destroyPanes(locations);
      }

      if (state.paneContainers) {
        for (const location of locations) {
          assertLayoutCurrent();
          this.paneContainers[location].deserialize(
            state.paneContainers[location],
            deserializerManager,
          );
        }
      }

      this.attachPersistentDockItems(persistentItems, assertLayoutCurrent);
      assertLayoutCurrent();
      this.hasActiveTextEditor = this.getActiveTextEditor() != null;
      this.didChangeCenterTextEditorResolutions(this.getCenter().getActivePaneItem());
    } catch (error) {
      this.#recoverPersistentItems(persistentItems, assertLayoutCurrent, error);
    }
  }

  /** @private Prepare hosts before deserializing documents; unavailable hosts restore in main. */
  async prepareEditorWindowRestore(state, options = {}, assertCurrent = () => {}) {
    const prepared = { state, retiring: [], windows: [] };
    if (options.locations && !options.locations.includes("center")) return prepared;
    const guard = this.#layoutGuard(assertCurrent);
    guard();
    prepared.retiring = this.getWindows().filter((window) => !window.isMain());
    const original = state.paneContainers?.center;
    const center = original?.main
      ? { ...original, main: { ...original.main }, windows: [] }
      : original;
    prepared.state = { ...state, paneContainers: { ...state.paneContainers, center } };
    try {
      for (const saved of original?.windows ?? []) {
        try {
          const existing = prepared.retiring.find((window) => window.persistentId === saved.id);
          if (existing) {
            // A logical window retains its native name and geometry while only
            // its document layout changes. Electron names cannot overlap.
            prepared.retiring = prepared.retiring.filter((window) => window !== existing);
            prepared.windows.push({ saved, window: existing, created: false });
            continue;
          }
          const openOptions = {
            show: false,
            persistentId: saved.id,
          };
          this.#windowRestoreOpenOptions.add(openOptions);
          let window;
          try {
            window = await this.openEditorWindow(openOptions);
          } finally {
            this.#windowRestoreOpenOptions.delete(openOptions);
          }
          prepared.windows.push({ saved, window, created: true });
          guard();
        } catch (error) {
          guard();
          const incoming = saved.container.root;
          const root = center.main.root;
          center.main.root =
            root?.deserializer === "Pane" && !root.items.length
              ? incoming
              : {
                  deserializer: "PaneAxis",
                  orientation: "horizontal",
                  flexScale: 1,
                  children: [root, incoming],
                };
          if (original.activeWindowId === saved.id) {
            center.activeWindowId = "main";
            center.main.activePaneId = saved.container.activePaneId;
          }
          this.notificationManager.addWarning(
            "An editor window could not be restored. Its tabs were restored in the main window.",
            { detail: error.message },
          );
        }
      }
    } catch (error) {
      for (const { window, created } of prepared.windows)
        if (created && !window.isDestroyed() && !window.getEditorContainer().getPaneItems().length)
          await this.releaseEditorWindow(window);
      throw error;
    }

    return prepared;
  }

  /** @private Restore each prepared physical layout using the shared project's buffers. */
  async restoreEditorWindows(prepared, deserializers, assertCurrent = () => {}) {
    const guard = this.#layoutGuard(assertCurrent);
    for (const window of prepared.retiring) {
      guard();
      await this.releaseEditorWindow(window);
    }
    for (const { saved, window } of prepared.windows) {
      try {
        guard();
        window.getEditorContainer().deserialize(saved.container, deserializers);
        guard();
        await window.windowService.show();
      } catch (error) {
        await this.releaseEditorWindow(window);
        throw error;
      }
    }
    const center = prepared.state.paneContainers?.center;
    const active = this.getWindows().find(
      (window) => window.persistentId === center?.activeWindowId,
    );
    active?.getEditorContainer().getActivePane().activate();
  }

  /**
   * @public
   * @status extended
   *
   * Destroy every item in the given pane container locations,
   * leaving each of them with a single empty pane.
   *
   * Nothing is prompted for — the caller decides whether the items may go,
   * which is why this is not {@link Pane#destroyItems} on every pane.
   *
   * @param {Object} [options={}] - An optional `Object` that may contain the following key:
   * @param {Array<String>} [options.locations] - Locations to empty: center, left, right, or bottom; defaults to all four.
   * @returns {Promise<void>} that resolves once they are empty.
   * @param {Function} [assertCurrent] - Throws if the caller-owned layout operation was superseded.
   * @category Layout
   */
  async clear(options = {}, assertCurrent = () => {}) {
    const assertLayoutCurrent = this.#layoutGuard(assertCurrent);
    assertLayoutCurrent();
    const locations = options.locations || ALL_LOCATIONS;
    const persistentItems = [];
    try {
      this.detachPersistentDockItems(locations, persistentItems, assertLayoutCurrent);
      for (const pane of this.getPanesIn(locations)) {
        assertLayoutCurrent();
        await Promise.all(pane.getItems().map((item) => pane.destroyItem(item, true)));
        assertLayoutCurrent();
      }
      assertLayoutCurrent();
      this.destroyPanes(locations);
      this.attachPersistentDockItems(persistentItems, assertLayoutCurrent);
      assertLayoutCurrent();
      this.destroyedItemURIs = [];
      this.hasActiveTextEditor = this.getActiveTextEditor() != null;
      this.didChangeCenterTextEditorResolutions(this.getCenter().getActivePaneItem());
    } catch (error) {
      this.#recoverPersistentItems(persistentItems, assertLayoutCurrent, error);
    }
  }

  /** @private Prepare every close before a project snapshot, without changing its layout. */
  async prepareToClear(options = {}, assertCurrent = () => {}) {
    const guard = this.#layoutGuard(assertCurrent);
    guard();
    const locations = options.locations || ALL_LOCATIONS;
    const panes = this.getPanesIn(locations);
    const entries = panes.map((pane) => ({ pane, items: pane.getItems() }));
    const results = await Promise.allSettled(
      entries.flatMap(({ pane, items }) =>
        items
          .filter(
            (item) =>
              !(typeof item.isPersistentDockItem === "function" && item.isPersistentDockItem()),
          )
          .map((item) => pane.prepareToDestroyItem(item, true)),
      ),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Unable to prepare the workspace for closing");
    const prepared = results.map((result) => result.value);
    const validate = () => {
      guard();
      const current = this.getPanesIn(locations);
      if (
        current.length !== panes.length ||
        current.some((pane, index) => pane !== panes[index]) ||
        entries.some(({ pane, items }) => {
          const present = pane.getItems();
          return (
            present.length !== items.length || present.some((item, index) => item !== items[index])
          );
        }) ||
        prepared.some((item) => !item?.canDestroy())
      ) {
        throw new Error("The workspace changed or an item prevented the project from closing.");
      }
    };
    validate();
    const clear = () => {
      validate();
      const persistentItems = [];
      try {
        this.detachPersistentDockItems(locations, persistentItems, guard);
        for (const item of prepared) {
          guard();
          item.destroy();
        }
        guard();
        this.destroyPanes(locations);
        this.attachPersistentDockItems(persistentItems, guard);
        guard();
        this.destroyedItemURIs = [];
        this.hasActiveTextEditor = this.getActiveTextEditor() != null;
        this.didChangeCenterTextEditorResolutions(this.getCenter().getActivePaneItem());
      } catch (error) {
        this.#recoverPersistentItems(persistentItems, guard, error);
      }
    };
    return { assertReady: validate, clear };
  }

  #layoutGuard(assertCurrent) {
    const generation = this.#layoutGeneration;
    return () => {
      assertCurrent();
      if (!this.isAlive() || this.#layoutGeneration !== generation) {
        throw Object.assign(new Error("Workspace layout change was cancelled"), {
          code: "ABORT_ERR",
        });
      }
    };
  }

  #recoverPersistentItems(persistentItems, assertCurrent, error) {
    const failures = [error];
    for (const entry of persistentItems) {
      let current = true;
      try {
        assertCurrent();
      } catch {
        current = false;
      }
      try {
        if (current) {
          this.attachPersistentDockItems([entry], assertCurrent);
        } else if (!this.paneForItem(entry.item) && !entry.item.isDestroyed?.()) {
          // Reset cannot dispose an item detached from its old pane. Dispose
          // that orphan without reviving it in the replacement layout, while
          // preserving an item the new generation has already adopted.
          entry.item.destroy?.();
        }
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Unable to change the workspace layout and recover its items",
        {
          cause: error,
        },
      );
    }
    throw error;
  }

  /**
   * Every pane across the given pane container locations.
   *
   * @private
   */
  getPanesIn(locations) {
    return locations.flatMap((location) => this.paneContainers[location].getPanes());
  }

  /**
   * Removes every persistent dock item from its pane without
   * destroying it, recording where it came from so
   * {@link #attachPersistentDockItems} can put it back.
   *
   * @private
   */
  detachPersistentDockItems(locations, persistentItems, assertCurrent) {
    for (const pane of this.getPanesIn(locations)) {
      for (const item of pane.getItems()) {
        assertCurrent();
        if (typeof item.isPersistentDockItem !== "function" || !item.isPersistentDockItem()) {
          continue;
        }
        const container = this.paneContainerForItem(item);
        persistentItems.push({
          item,
          location: container.getLocation(),
          visible: typeof container.isVisible === "function" ? container.isVisible() : true,
        });
        pane.removeItem(item, true);
        assertCurrent();
      }
    }
    return persistentItems;
  }

  /**
   * Puts the items {@link #detachPersistentDockItems} took out back into
   * whatever layout now exists.
   *
   * @private
   */
  attachPersistentDockItems(persistentItems, assertCurrent = () => {}) {
    for (const { item, location, visible } of persistentItems) {
      assertCurrent();
      if (item.isDestroyed?.()) continue;
      let uri;
      if (typeof item.getURI === "function") uri = item.getURI();

      let container;
      if (this.paneForItem(item)) {
        container = this.paneContainerForItem(item);
      } else if (uri && this.paneForURI(uri)) {
        // The restored layout recreated its own copy of the item.
        if (typeof item.destroy === "function") item.destroy();
        assertCurrent();
        container = this.paneContainerForURI(uri);
      } else {
        container = this.paneContainers[location] || this.paneContainers.center;
        const pane = container.getActivePane();
        pane.addItem(item);
        assertCurrent();
        pane.activateItem(item);
        assertCurrent();
      }
      if (visible && container && typeof container.show === "function") {
        container.show();
      }
    }
  }

  /**
   * Destroys every pane in the given locations. A container's last
   * pane empties itself rather than disappearing, so each one is left with a
   * single empty pane.
   *
   * @private
   */
  destroyPanes(locations) {
    for (const pane of this.getPanesIn(locations)) {
      // Restoration has already captured or confirmed the outgoing documents.
      // Empty the final pane directly rather than starting another save dialog.
      for (const item of pane.getItems()) {
        pane.removeItem(item, false, { preservePane: true });
        item.destroy?.();
      }
      pane.destroy();
    }
  }

  getPackageNamesWithActiveGrammars() {
    const packageNames = [];
    const addGrammar = ({ packageName } = {}) => {
      if (!packageName) {
        return;
      }
      if (packageNames.indexOf(packageName) !== -1) {
        return;
      }

      packageNames.push(packageName);
    };

    const editors = this.getTextEditors();
    for (let editor of editors) {
      const languageMode = editor.getBuffer().getLanguageMode();
      if (languageMode.getUsedGrammars) {
        for (const grammar of languageMode.getUsedGrammars()) addGrammar(grammar);
      } else if (languageMode.rootLanguageLayer && languageMode.getAllLanguageLayers) {
        for (const layer of languageMode.getAllLanguageLayers()) addGrammar(layer.grammar);
      } else {
        addGrammar(editor.getGrammar());
      }
    }

    return _.uniq(packageNames);
  }

  didActivatePaneContainer(paneContainer) {
    if (paneContainer !== this.getActivePaneContainer()) {
      this.activePaneContainer = paneContainer;
      this.didChangeActivePaneItem(this.activePaneContainer.getActivePaneItem());
      this.emitter.emit("did-change-active-pane-container", this.activePaneContainer);
      this.emitter.emit("did-change-active-pane", this.activePaneContainer.getActivePane());
      this.emitter.emit(
        "did-change-active-pane-item",
        this.activePaneContainer.getActivePaneItem(),
      );
    }
  }

  didChangeActivePaneOnPaneContainer(paneContainer, pane) {
    if (paneContainer === this.getActivePaneContainer()) {
      this.emitter.emit("did-change-active-pane", pane);
    }
  }

  didChangeActivePaneItemOnPaneContainer(paneContainer, item) {
    if (paneContainer === this.getActivePaneContainer()) {
      this.didChangeActivePaneItem(item);
      this.emitter.emit("did-change-active-pane-item", item);
    }

    if (paneContainer === this.getCenter()) {
      const hadActiveTextEditor = this.hasActiveTextEditor;
      this.hasActiveTextEditor = item instanceof TextEditor;

      if (this.hasActiveTextEditor || hadActiveTextEditor) {
        const itemValue = this.hasActiveTextEditor ? item : undefined;
        this.emitter.emit("did-change-active-text-editor", itemValue);
      }

      this.didChangeCenterTextEditorResolutions(item);
    }
  }

  // The center's active item decides the derived file and embedded text
  // editors; an item that embeds its editors also reports when they change,
  // through the same protocol the getters read (see
  // {@link #getActiveFileTextEditor} and {@link #getActiveEmbeddedTextEditor}).
  didChangeCenterTextEditorResolutions(item) {
    if (this.activeItemTextEditorsSubscription) {
      this.activeItemTextEditorsSubscription.dispose();
      this.activeItemTextEditorsSubscription = null;
    }

    if (
      item != null &&
      !(item instanceof TextEditor) &&
      typeof item.onDidChangeActiveTextEditors === "function"
    ) {
      this.activeItemTextEditorsSubscription = item.onDidChangeActiveTextEditors(() => {
        this.emitTextEditorResolutionChanges();
      });
    }

    this.emitTextEditorResolutionChanges();
  }

  // Emit-if-changed for both derived editors. Items fire their change signal
  // freely — a view refresh, an editor rebuild — so the dedup lives here, and
  // switching between two views of one document stays silent.
  emitTextEditorResolutionChanges() {
    const fileTextEditor = this.getActiveFileTextEditor();
    if (fileTextEditor !== this.previousActiveFileTextEditor) {
      this.previousActiveFileTextEditor = fileTextEditor;
      this.emitter.emit("did-change-active-file-text-editor", fileTextEditor);
    }

    const embeddedTextEditor = this.getActiveEmbeddedTextEditor();
    if (embeddedTextEditor !== this.previousActiveEmbeddedTextEditor) {
      this.previousActiveEmbeddedTextEditor = embeddedTextEditor;
      this.emitter.emit("did-change-active-embedded-text-editor", embeddedTextEditor);
    }

    this.updateActiveItemGrammarUsage(fileTextEditor, embeddedTextEditor);
  }

  didChangeActivePaneItem(item) {
    this.updateDocumentEdited();
    if (this.activeItemSubscriptions) this.activeItemSubscriptions.dispose();
    this.activeItemSubscriptions = new CompositeDisposable();

    let fileStateSubscription;

    if (item != null && typeof item.onDidChangeFileState === "function") {
      fileStateSubscription = item.onDidChangeFileState(this.updateDocumentEdited);
    }

    if (fileStateSubscription != null) {
      this.activeItemSubscriptions.add(fileStateSubscription);
    }

    this.cancelStoppedChangingActivePaneItemTimeout();
    this.stoppedChangingActivePaneItemTimeout = setTimeout(() => {
      this.stoppedChangingActivePaneItemTimeout = null;
      this.emitter.emit("did-stop-changing-active-pane-item", item);
    }, STOPPED_CHANGING_ACTIVE_PANE_ITEM_DELAY);
  }

  cancelStoppedChangingActivePaneItemTimeout() {
    if (this.stoppedChangingActivePaneItemTimeout != null) {
      clearTimeout(this.stoppedChangingActivePaneItemTimeout);
    }
  }

  setDraggingItem(draggingItem) {
    _.values(this.paneContainers).forEach((dock) => {
      dock.setDraggingItem(draggingItem);
    });
  }

  subscribeToAddedItems() {
    this.onDidAddPaneItem(({ item, pane, index }) => {
      this.packageManager.hooks.trigger("core:pane-item-used");

      if (
        typeof item.getFileState === "function" &&
        typeof item.onDidChangeFileState === "function"
      ) {
        let previousFileState = item.getFileState();
        const fileStateSubscriptions = new CompositeDisposable();
        fileStateSubscriptions.add(
          item.onDidChangeFileState((fileState) => {
            const shouldClose =
              previousFileState === "unmodified" &&
              fileState === "removed" &&
              this.config.get("core.closeDeletedFileTabs");
            previousFileState = fileState;
            if (shouldClose) void pane.destroyItem(item, true);
          }),
        );
        fileStateSubscriptions.add(
          pane.onDidRemoveItem(({ item: removedItem }) => {
            if (removedItem === item) fileStateSubscriptions.dispose();
          }),
        );
      }

      if (item instanceof TextEditor) {
        this.paneDocumentsAwaitingGrammarObservation.add(item);
        let textEditorRegistration;
        try {
          textEditorRegistration = this.textEditorRegistry.add(item, { role: "document" });
        } finally {
          // TextEditorRegistry emits synchronously, so its observer has now
          // skipped this pane-owned document. Workspace attaches below, after
          // its own did-add event has reached package observers.
          this.paneDocumentsAwaitingGrammarObservation.delete(item);
        }
        const subscriptions = new CompositeDisposable(
          textEditorRegistration,
          this.textEditorFactory.maintainConfig(item),
          // Both of this editor's contributions to every long title: that it
          // is open at all, and which directory it sits in.
          item.onDidChangePath(() => this.invalidateLongTitles()),
        );
        this.invalidateLongTitles();
        if (!this.project.findBufferForId(item.buffer.id)) {
          this.project.addBuffer(item.buffer);
        }
        item.onDidDestroy(() => {
          this.invalidateLongTitles();
          subscriptions.dispose();
        });
        this.emitter.emit("did-add-text-editor", {
          textEditor: item,
          pane,
          index,
        });
        // Attach activation observations after emitting the did-add event. The
        // first observation triggers core:text-editor-used, and a package
        // activated between registry insertion and this event could otherwise
        // receive the editor twice from `observeTextEditors`.
        // (Note that the item can be destroyed by an `observeTextEditors` handler.)
        if (!item.isDestroyed()) {
          subscriptions.add(this.acquireGrammarUsageObservation(item));
        }
      }
    });
  }

  subscribeToRegisteredTextEditorGrammarUsage() {
    if (this.registeredTextEditorGrammarSubscription) return;

    this.registeredTextEditorGrammarSubscription = new CompositeDisposable(
      this.textEditorRegistry.observe((editor) => {
        const role = this.textEditorRegistry.roleFor(editor);
        // Pane documents attach only after Workspace::onDidAddTextEditor has
        // fired (see subscribeToAddedItems above). That ordering prevents a
        // newly activated package from observing the same pane editor twice.
        if (role === "input" || this.paneDocumentsAwaitingGrammarObservation.has(editor)) return;
        if (role !== "document" && role !== "fragment" && role !== "viewer") return;
        if (this.registeredGrammarUsageLeases.has(editor)) return;
        this.registeredGrammarUsageLeases.set(editor, this.acquireGrammarUsageObservation(editor));
      }),
      this.textEditorRegistry.onDidRemoveEditor((editor) => {
        const lease = this.registeredGrammarUsageLeases.get(editor);
        if (!lease) return;
        this.registeredGrammarUsageLeases.delete(editor);
        lease.dispose();
      }),
    );
  }

  acquireGrammarUsageObservation(editor) {
    if (!(editor instanceof TextEditor) || editor.isDestroyed() || editor.isMini()) {
      return new Disposable();
    }

    this.packageManager.hooks.trigger("core:text-editor-used");

    let entry = this.grammarUsageEntries.get(editor);
    if (!entry) {
      entry = {
        leases: 0,
        disposed: false,
        grammarSubscription: null,
        injectionSubscription: null,
        destroySubscription: null,
      };
      this.grammarUsageEntries.set(editor, entry);

      const disposeEntry = () => {
        if (entry.disposed) return;
        entry.disposed = true;
        if (this.grammarUsageEntries.get(editor) === entry) {
          this.grammarUsageEntries.delete(editor);
        }
        entry.grammarSubscription?.dispose();
        entry.injectionSubscription?.dispose();
        entry.destroySubscription?.dispose();
      };
      entry.dispose = disposeEntry;
      entry.destroySubscription = editor.onDidDestroy(disposeEntry);
      entry.grammarSubscription = editor.observeGrammar((grammar) => {
        entry.injectionSubscription?.dispose();
        entry.injectionSubscription = null;

        const languageMode = editor.getBuffer().getLanguageMode();
        if (typeof languageMode.onDidUseInjectionGrammar === "function") {
          entry.injectionSubscription = languageMode.onDidUseInjectionGrammar((injectionGrammar) =>
            this.handleGrammarUsed(injectionGrammar, { root: false }),
          );
        }

        this.handleGrammarUsed(grammar, { root: true });

        // A surface may register after its buffer has already tokenized (for
        // example a restored viewer). Replay only the injection grammars that
        // have materialized in that mode; PackageManager deduplicates the
        // resulting window facts.
        if (typeof languageMode.getAllInjectionLayers === "function") {
          for (const layer of languageMode.getAllInjectionLayers()) {
            if (layer?.grammar) this.handleGrammarUsed(layer.grammar, { root: false });
          }
        }
      });

      if (entry.disposed) {
        entry.grammarSubscription?.dispose();
      }
    }

    entry.leases++;
    let disposed = false;
    return new Disposable(() => {
      if (disposed) return;
      disposed = true;
      if (entry.disposed) return;
      entry.leases--;
      if (entry.leases === 0) entry.dispose();
    });
  }

  updateActiveItemGrammarUsage(fileTextEditor, embeddedTextEditor) {
    const activeItem = this.getCenter().getActivePaneItem();
    const desiredEditors = new Set();

    // Ordinary pane TextEditors already own a document-role lease. Composite
    // items such as notebooks expose their backing document and active cell
    // through this protocol without necessarily registering those editors.
    if (!(activeItem instanceof TextEditor)) {
      for (const editor of [fileTextEditor, embeddedTextEditor]) {
        if (!(editor instanceof TextEditor) || editor.isDestroyed() || editor.isMini()) continue;
        if (this.textEditorRegistry.roleFor(editor) === "input") continue;
        desiredEditors.add(editor);
      }
    }

    for (const [editor, lease] of this.activeItemGrammarUsageLeases) {
      if (desiredEditors.has(editor)) continue;
      this.activeItemGrammarUsageLeases.delete(editor);
      lease.dispose();
    }
    for (const editor of desiredEditors) {
      if (this.activeItemGrammarUsageLeases.has(editor)) continue;
      this.activeItemGrammarUsageLeases.set(editor, this.acquireGrammarUsageObservation(editor));
    }
  }

  subscribeToDockToggling() {
    const docks = [this.getLeftDock(), this.getRightDock(), this.getBottomDock()];
    docks.forEach((dock) => {
      dock.onDidChangeVisible((visible) => {
        if (visible) return;
        const { activeElement } = document;
        const dockElement = dock.getElement();
        if (dockElement === activeElement || dockElement.contains(activeElement)) {
          this.getCenter().activate();
        }
      });
    });
  }

  subscribeToMovedItems() {
    for (const paneContainer of this.getPaneContainers()) {
      paneContainer.observePanes((pane) => {
        pane.observeItems((item) => {
          this.paneItemURIs.set(item, this.getItemURI(item));
          if (typeof item.onDidChangeURI !== "function") return;
          const subscriptions = new CompositeDisposable(
            item.onDidChangeURI(() => this.didChangePaneItemURI(item, pane)),
            pane.onDidRemoveItem(({ item: removedItem }) => {
              if (removedItem === item) subscriptions.dispose();
            }),
          );
        });
        pane.onDidAddItem(({ item }) => {
          if (typeof item.getURI === "function" && this.enablePersistence) {
            const uri = item.getURI();
            if (uri) {
              const location = paneContainer.getLocation();
              const defaultLocation = defaultLocationForItem(item);
              if (location === defaultLocation) {
                this.itemLocationStore.delete(item.getURI());
              } else {
                this.itemLocationStore.save(item.getURI(), location);
              }
            }
          }
        });
      });
    }
  }

  // On macOS, fades the application window's proxy icon when the current item
  // has a dirty file state.
  updateDocumentEdited() {
    const activePaneItem = this.getActivePaneItem();
    const dirty =
      activePaneItem != null &&
      typeof activePaneItem.getFileState === "function" &&
      (typeof activePaneItem.save === "function" || typeof activePaneItem.saveAs === "function")
        ? activePaneItem.getFileState() !== "unmodified"
        : false;
    this.applicationDelegate.setWindowDocumentEdited(dirty);
  }

  /**
   * @category Event Subscription
   */

  onDidChangeActivePaneContainer(callback) {
    return this.emitter.on("did-change-active-pane-container", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback with all current and future text
   * editors in the workspace.
   *
   * @param {Function} callback - to be called with current and future text editors.
   * @param {TextEditor} callback.editor - A {@link TextEditor} that is present in {@link #getTextEditors} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeTextEditors(callback) {
    for (let textEditor of this.getTextEditors()) {
      callback(textEditor);
    }
    return this.onDidAddTextEditor(({ textEditor }) => callback(textEditor));
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback with all current and future panes items
   * in the workspace.
   *
   * @param {Function} callback - to be called with current and future pane items.
   * @param {*} callback.item - An item that is present in {@link #getPaneItems} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observePaneItems(callback) {
    return new CompositeDisposable(
      ...this.getPaneContainers().map((container) => container.observePaneItems(callback)),
    );
  }

  /**
   * @public
   * @status public
   *
   * Invoke the callback when an existing pane item changes its document URI.
   * The item and pane identities are unchanged. This includes preview reuse
   * and navigation performed by the item itself.
   *
   * @param {Function} callback - Receives `{item, pane, oldURI, newURI}`.
   * @returns {Disposable} Subscription to the URI changes.
   */
  onDidChangePaneItemURI(callback) {
    return this.emitter.on("did-change-pane-item-uri", callback);
  }

  getItemURI(item) {
    return item?.getURI?.() ?? item?.getUri?.();
  }

  didChangePaneItemURI(item, pane) {
    if (!pane.getItems().includes(item)) return;
    const oldURI = this.paneItemURIs.get(item);
    const newURI = this.getItemURI(item);
    if (oldURI === newURI) return;
    this.paneItemURIs.set(item, newURI);
    const reuseRequest = this.#itemOpenRequests.getForPane(pane);
    if (reuseRequest?.item === item) this.recordReusedPendingItemURI(reuseRequest);
    this.invalidateLongTitles();
    this.itemOpened(item);
    if (newURI && this.enablePersistence) {
      const location = pane.getContainer().getLocation();
      if (location === defaultLocationForItem(item)) this.itemLocationStore.delete(newURI);
      else this.itemLocationStore.save(newURI, location);
    }
    if (this.getActivePaneItem() === item) this.didChangeActivePaneItem(item);
    if (this.getCenter().getActivePaneItem() === item)
      this.didChangeCenterTextEditorResolutions(item);
    this.emitter.emit("did-change-pane-item-uri", { item, pane, oldURI, newURI });
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback when the active pane item changes.
   *
   * Because observers are invoked synchronously, it's important not to perform
   * any expensive operations via this method. Consider
   * {@link #onDidStopChangingActivePaneItem} to delay operations until after changes
   * stop occurring.
   *
   * @param {Function} callback - to be called when the active pane item changes.
   * @param {*} callback.item - The active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActivePaneItem(callback) {
    return this.emitter.on("did-change-active-pane-item", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback when the active pane item stops
   * changing.
   *
   * Observers are called asynchronously 100ms after the last active pane item
   * change. Handling changes here rather than in the synchronous
   * {@link #onDidChangeActivePaneItem} prevents unneeded work if the user is quickly
   * changing or closing tabs and ensures critical UI feedback, like changing the
   * highlighted tab, gets priority over work that can be done asynchronously.
   *
   * @param {Function} callback - to be called when the active pane item stops changing.
   * @param {*} callback.item - The active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidStopChangingActivePaneItem(callback) {
    return this.emitter.on("did-stop-changing-active-pane-item", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback when a text editor becomes the active
   * text editor and when there is no longer an active text editor.
   *
   * @param {Function} callback - to be called when the active text editor changes.
   * @param {TextEditor|undefined} callback.editor - The active {@link TextEditor} or undefined if there is no longer an active text editor.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActiveTextEditor(callback) {
    return this.emitter.on("did-change-active-text-editor", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback with the current active pane item and
   * with all future active pane items in the workspace.
   *
   * @param {Function} callback - to be called when the active pane item changes.
   * @param {*} callback.item - The current active pane item.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeActivePaneItem(callback) {
    callback(this.getActivePaneItem());
    return this.onDidChangeActivePaneItem(callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback with the current active text editor
   * (if any), with all future active text editors, and when there is no longer
   * an active text editor.
   *
   * @param {Function} callback - to be called when the active text editor changes.
   * @param {TextEditor|undefined} callback.editor - The active {@link TextEditor} or undefined if there is not an active text editor.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeActiveTextEditor(callback) {
    callback(this.getActiveTextEditor());

    return this.onDidChangeActiveTextEditor(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when the editor holding the active item's file
   * content changes. See {@link #getActiveFileTextEditor}.
   *
   * @param {Function} callback - to be called when the resolved editor changes.
   * @param {TextEditor|undefined} callback.editor - The resolved {@link TextEditor} or `undefined`.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActiveFileTextEditor(callback) {
    return this.emitter.on("did-change-active-file-text-editor", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback with the current and all future editors holding
   * the active item's file content. See {@link #getActiveFileTextEditor}.
   *
   * @param {Function} callback - to be called when the resolved editor changes.
   * @param {TextEditor|undefined} callback.editor - The resolved {@link TextEditor} or `undefined`.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeActiveFileTextEditor(callback) {
    callback(this.getActiveFileTextEditor());

    return this.onDidChangeActiveFileTextEditor(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when the editor being edited inside the active
   * item changes. See {@link #getActiveEmbeddedTextEditor}.
   *
   * @param {Function} callback - to be called when the resolved editor changes.
   * @param {TextEditor|undefined} callback.editor - The resolved {@link TextEditor} or `undefined`.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActiveEmbeddedTextEditor(callback) {
    return this.emitter.on("did-change-active-embedded-text-editor", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback with the current and all future editors being
   * edited inside the active item. See {@link #getActiveEmbeddedTextEditor}.
   *
   * @param {Function} callback - to be called when the resolved editor changes.
   * @param {TextEditor|undefined} callback.editor - The resolved {@link TextEditor} or `undefined`.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeActiveEmbeddedTextEditor(callback) {
    callback(this.getActiveEmbeddedTextEditor());

    return this.onDidChangeActiveEmbeddedTextEditor(callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback whenever an item is opened. Unlike
   * {@link #onDidAddPaneItem}, observers will be notified for items that are already
   * present in the workspace when they are reopened.
   *
   * @param {Function} callback - to be called whenever an item is opened.
   * @param {Object} callback.event - with the following keys:
   * @param {String} callback.event.uri - representing the opened URI. Could be `undefined`.
   * @param {*} callback.event.item - The opened item.
   * @param {Pane} callback.event.pane - The pane in which the item was opened.
   * @param {Number} callback.event.index - The index of the opened item on its pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidOpen(callback) {
    return this.emitter.on("did-open", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane is added to the workspace.
   *
   * @param {Function} callback - to be called when panes are added.
   * @param {Object} callback.event - with the following keys:
   * @param {Pane} callback.event.pane - The added pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddPane(callback) {
    return new CompositeDisposable(
      ...this.getPaneContainers().map((container) => container.onDidAddPane(callback)),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback before a pane is destroyed in the
   * workspace.
   *
   * @param {Function} callback - to be called before panes are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param {Pane} callback.event.pane - The pane to be destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillDestroyPane(callback) {
    return new CompositeDisposable(
      ...this.getPaneContainers().map((container) => container.onWillDestroyPane(callback)),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane is destroyed in the
   * workspace.
   *
   * @param {Function} callback - to be called when panes are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param {Pane} callback.event.pane - The destroyed pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDestroyPane(callback) {
    return new CompositeDisposable(
      ...this.getPaneContainers().map((container) => container.onDidDestroyPane(callback)),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback with all current and future panes in the
   * workspace.
   *
   * @param {Function} callback - to be called with current and future panes.
   * @param {Pane} callback.pane - A {@link Pane} that is present in {@link #getPanes} at the time of subscription or that is added at some later time.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observePanes(callback) {
    return new CompositeDisposable(
      ...this.getPaneContainers().map((container) => container.observePanes(callback)),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when the active pane changes.
   *
   * @param {Function} callback - to be called when the active pane changes.
   * @param {Pane} callback.pane - A {@link Pane} that is the current return value of {@link #getActivePane}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeActivePane(callback) {
    return this.emitter.on("did-change-active-pane", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback with the current active pane and when
   * the active pane changes.
   *
   * @param {Function} callback - to be called with the current and future active panes.
   * @param {Pane} callback.pane - A {@link Pane} that is the current return value of {@link #getActivePane}.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeActivePane(callback) {
    callback(this.getActivePane());
    return this.onDidChangeActivePane(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane item is added to the
   * workspace.
   *
   * @param {Function} callback - to be called when pane items are added.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The added pane item.
   * @param {Pane} callback.event.pane - containing the added item.
   * @param {Number} callback.event.index - indicating the index of the added item in its pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddPaneItem(callback) {
    return new CompositeDisposable(
      ...this.getPaneContainers().map((container) => container.onDidAddPaneItem(callback)),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane item is about to be
   * destroyed, before the user is prompted to save it.
   *
   * @param {Function} callback - to be called before pane items are destroyed. If this function returns a `Promise`, then the item will not be destroyed until the promise resolves.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The item to be destroyed.
   * @param {Pane} callback.event.pane - containing the item to be destroyed.
   * @param {Number} callback.event.index - indicating the index of the item to be destroyed in its pane.
   * @returns {Disposable} on which `.dispose` can be called to unsubscribe.
   */
  onWillDestroyPaneItem(callback) {
    return new CompositeDisposable(
      ...this.getPaneContainers().map((container) => container.onWillDestroyPaneItem(callback)),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a pane item is destroyed.
   *
   * @param {Function} callback - to be called when pane items are destroyed.
   * @param {Object} callback.event - with the following keys:
   * @param {*} callback.event.item - The destroyed item.
   * @param {Pane} callback.event.pane - containing the destroyed item.
   * @param {Number} callback.event.index - indicating the index of the destroyed item in its pane.
   * @returns {Disposable} on which `.dispose` can be called to unsubscribe.
   */
  onDidDestroyPaneItem(callback) {
    return new CompositeDisposable(
      ...this.getPaneContainers().map((container) => container.onDidDestroyPaneItem(callback)),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback when a text editor is added to the
   * workspace.
   *
   * @param {Function} callback - to be called when text editors are added.
   * @param {Object} callback.event - with the following keys:
   * @param {TextEditor} callback.event.textEditor - that was added.
   * @param {Pane} callback.event.pane - containing the added text editor.
   * @param {Number} callback.event.index - indicating the index of the added text editor in its pane.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddTextEditor(callback) {
    return this.emitter.on("did-add-text-editor", callback);
  }

  /**
   * @category Opening
   */

  /**
   * @public
   * @status essential
   *
   * Opens the given URI in Lumine asynchronously.
   * If the URI is already open, the existing item for that URI will be
   * activated. If no URI is given, or no registered opener can open
   * the URI, a new empty {@link TextEditor} will be created.
   * The destination pane is captured before asynchronous opening begins, so
   * later focus changes do not redirect the result into another window.
   * Replacing the project session cancels pending opens and refuses new ones
   * until restoration or rollback completes.
   * Resetting or destroying the workspace, or closing the chosen destination
   * pane, cancels an unfinished open and resolves it to `undefined`. A late
   * opener-owned item is disposed if it remains unattached; an item supplied
   * by the caller stays caller-owned.
   *
   * @param {String|Object} [itemOrURI] - An item to open or a `String` containing a URI.
   * @param {Object} [options]
   * @param {String} [options.opener] - The registered path opener ID to use, 'text-editor' for files, or 'project-folder' for directories. An explicit choice bypasses automatic opener preferences and only reuses an item of that opener's type.
   * @param {String} [options.destination='current'] - The requested destination; a detached opening uses 'detached-window' and supplies its pane.
   * @param {String} [options.uriFragment] - The fragment of a local file URL, forwarded to the selected path opener after its path is normalized.
   * @param {AbortSignal} [options.signal] - Cancels an unfinished opening and disposes an unpresented opener-owned result.
   * @param {Number} [options.initialLine=0] - A `Number` indicating which row to move the cursor to initially. Defaults to `0`.
   * @param {Number} [options.initialColumn=0] - A `Number` indicating which column to move the cursor to initially. Defaults to `0`.
   * @param {String} [options.split] - Either 'left', 'right', 'up' or 'down'. If 'left', the item will be opened in leftmost pane of the current active pane's row. If 'right', the item will be opened in the rightmost pane of the current active pane's row. If only one pane exists in the row, a new pane will be created. If 'up', the item will be opened in topmost pane of the current active pane's column. If 'down', the item will be opened in the bottommost pane of the current active pane's column. If only one pane exists in the column, a new pane will be created.
   * @param {Boolean} [options.activatePane=true] - A `Boolean` indicating whether to call {@link Pane#activate} on containing pane. Defaults to `true`.
   * @param {Boolean} [options.activateItem=true] - A `Boolean` indicating whether to call {@link Pane#activateItem} on containing pane. Defaults to `true`.
   * @param {Boolean} [options.pending] - A `Boolean` indicating whether or not the item should be opened in a pending state. Existing pending items in a pane are replaced with new pending items when they are opened.
   * @param {Boolean} [options.transferred=false] - A `Boolean` marking a staged cross-window item whose requested placement should be preserved by tab surfaces.
   * @param {Pane} [options.pane] - A {@link Pane} in which to open the item. File openings with searchAllPanes reuse a matching item before using this pane as their destination. When combined with `split`, the new pane is created directly beside this pane after the item is ready.
   * @param {Boolean} [options.searchAllPanes=false] - A `Boolean`. If `true`, the workspace will attempt to activate an existing item for the given URI on any pane. If `false`, only the active pane will be searched for an existing item for the same URI. Defaults to `false`.
   * @param {String} [options.location] - A `String` containing the name of the location in which this item should be opened (one of "left", "right", "bottom", or "center"). If omitted, Lumine will fall back to the last location in which a user has placed an item with the same URI or, if this is a new URI, the default location specified by the item. NOTE: This option should almost always be omitted to honor user preference.
   * @returns {Promise<Object|undefined>} that resolves to the opened item, or `undefined` when cancelled or refused.
   */
  async open(itemOrURI, options = {}) {
    const openRequest = this.#itemOpenRequests.begin({ pane: options.pane });
    const signal = options.signal;
    const abortOpening = () => openRequest.controller.abort();
    if (signal?.aborted) abortOpening();
    else signal?.addEventListener("abort", abortOpening, { once: true });
    const providedItem = typeof itemOrURI === "string" ? undefined : itemOrURI;
    let uri, item, reuseRequest, incomingPromise, pathOpener;
    let resolveItem = () => {};
    let openFailure;
    let failed = false;
    let opened = false;
    let discardedItem, itemDisposalFailure;
    const waitForOpen = async (operation) => {
      try {
        return await operation;
      } catch (error) {
        const synchronousFailure = openRequest.synchronousFailure;
        if (
          !this.#itemOpenRequests.isCurrent(openRequest) &&
          !(synchronousFailure && synchronousFailure.error === error)
        ) {
          return;
        }
        throw error;
      }
    };
    const discardUnpresentedItem = () => {
      if (
        item &&
        item !== providedItem &&
        item !== discardedItem &&
        !item.isDestroyed?.() &&
        !this.paneForItem(item)
      ) {
        discardedItem = item;
        try {
          item.destroy?.();
        } catch (error) {
          itemDisposalFailure = error;
          throw error;
        }
      }
    };
    const performOpen = async () => {
      if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
      const openingPanes = new Map(
        Object.values(this.paneContainers).map((container) => [
          container,
          container.getActivePane(),
        ]),
      );
      const openingPaneFor = (container) =>
        openingPanes.get(container) ?? container.getActivePane();
      if (typeof itemOrURI === "string") {
        ({ uri, options } = normalizePathOpening(this.project.resolvePath(itemOrURI), options));
      } else if (itemOrURI) {
        item = itemOrURI;
        if (typeof item.getURI === "function") uri = item.getURI();
      }
      openRequest.uri = uri;
      if (!item && uri) pathOpener = this.resolvePathOpener(uri, options);
      openRequest.pathOpener = pathOpener;

      // Prepare a possible destination without cancelling work there: an opener
      // can still choose a different default location. The request is registered
      // only when an opener accepts reuse or the new item's destination is known.
      let preferredLocation = options.location;
      if (!options.split) {
        const searchPane =
          (pathOpener &&
            options.searchAllPanes &&
            this.paneForPathOpener(uri, pathOpener, options)) ||
          options.pane ||
          (options.searchAllPanes
            ? item
              ? this.paneForItem(item)
              : this.paneForPathOpener(uri, pathOpener, options)
            : openingPaneFor(
                this.paneContainerForPathOpener(uri, pathOpener, options) ||
                  this.getActivePaneContainer(),
              ));
        const existingItem = item
          ? searchPane?.getItems().includes(item)
          : uri && this.itemForPathOpener(searchPane, uri, pathOpener, options);
        if (
          !existingItem &&
          !item &&
          !options.pane &&
          !preferredLocation &&
          uri &&
          this.enablePersistence
        ) {
          preferredLocation = await waitForOpen(this.itemLocationStore.load(uri));
          if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
        }
        const destinationPane = existingItem
          ? searchPane
          : options.pane ||
            openingPaneFor(this.paneContainers[preferredLocation] || this.getCenter());
        reuseRequest = openRequest;
        this.#itemOpenRequests.prepare(
          reuseRequest,
          destinationPane,
          options.pending &&
            options.activateItem !== false &&
            this.config.get("core.allowPendingPaneItems"),
        );
        const incomingReuse = this.#itemOpenRequests.getForPane(destinationPane);
        if (existingItem || incomingReuse?.uri === uri)
          this.#itemOpenRequests.activate(reuseRequest);
        if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
      }
      if (uri) {
        // Every waiter must acquire its own slot after the prior open settles.
        // Otherwise several waiters can race to construct the same missing URI.
        while (this.incoming.has(uri)) {
          await waitForOpen(this.incoming.get(uri));
          if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
        }
        incomingPromise = new Promise((resolve) => {
          resolveItem = resolve;
        });
        this.incoming.set(uri, incomingPromise);
      }

      if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
      if (!lumine.config.get("core.allowPendingPaneItems")) {
        options.pending = false;
      }

      // Avoid adding URLs as recent documents to work-around this Spotlight crash:
      // https://github.com/atom/atom/issues/10071
      if (uri && (!protocolForURI(uri) || process.platform === "win32")) {
        this.applicationDelegate.addRecentDocument(uri);
      }

      let pane, itemExistsInWorkspace, pendingSplit;
      const splitRelativeToPane =
        options.pane && ["left", "right", "up", "down"].includes(options.split);

      // Try to find an existing item in the workspace.
      if (item || uri) {
        const existingFilePane =
          pathOpener && options.searchAllPanes && !options.split
            ? this.paneForPathOpener(uri, pathOpener, options)
            : null;
        if (existingFilePane) {
          pane = existingFilePane;
        } else if (options.pane) {
          pane = options.pane;
        } else if (options.searchAllPanes) {
          pane = item ? this.paneForItem(item) : this.paneForPathOpener(uri, pathOpener, options);
        } else {
          // If an item with the given URI is already in the workspace, assume
          // that item's pane container is the preferred location for that URI.
          let container;
          if (uri) container = this.paneContainerForPathOpener(uri, pathOpener, options);
          if (!container) container = this.getActivePaneContainer();

          // The `split` option affects where we search for the item.
          pane = openingPaneFor(container);
          switch (options.split) {
            case "left":
              pane = pane.findLeftmostSibling();
              break;
            case "right":
              pane = pane.findRightmostSibling();
              break;
            case "up":
              pane = pane.findTopmostSibling();
              break;
            case "down":
              pane = pane.findBottommostSibling();
              break;
          }
        }

        // An explicit pane and split describe a new destination. Do not find
        // the URI in the anchor pane: doing so would turn a drop at the pane's
        // edge into a no-op instead of opening a distinct editor in the split.
        if (pane && !splitRelativeToPane) {
          if (item) {
            itemExistsInWorkspace = pane.getItems().includes(item);
          } else {
            item = this.itemForPathOpener(pane, uri, pathOpener, options);
            itemExistsInWorkspace = item != null;
          }
        }
      }

      // If we already have an item at this stage, we won't need to do an async
      // lookup of the URI, so we yield the event loop to ensure this method
      // is consistently asynchronous.
      if (item) await Promise.resolve();
      if (!this.#itemOpenRequests.isCurrent(openRequest)) return;

      if (!itemExistsInWorkspace) {
        const itemWasProvided = item != null;
        if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
        if (!item && !options.split) {
          if (reuseRequest && options.pending && options.activateItem !== false) {
            const destinationPane = reuseRequest.pane;
            const candidate = destinationPane.getPendingItem();
            const location = destinationPane.getContainer().getLocation();
            const defaultLocation = defaultLocationForItem(candidate);
            if (
              candidate &&
              (!preferredLocation || preferredLocation === location) &&
              (options.pane || preferredLocation || defaultLocation === location) &&
              allowedLocationsForItem(candidate).includes(location) &&
              !candidate.isModified?.() &&
              (typeof candidate.getFileState !== "function" ||
                candidate.getFileState() === "unmodified")
            ) {
              reuseRequest.item = candidate;
              reuseRequest.oldURI = this.getItemURI(candidate);
            }
          }
        }
        item =
          item ||
          (await waitForOpen(this.createItemForURI(uri, options, reuseRequest, openRequest)));
        if (!this.#itemOpenRequests.isCurrent(openRequest)) {
          discardUnpresentedItem();
          return;
        }
        if (!item) return;

        const singleton = this.#paneItemRegistry.getItemForSingletonKey(item.getSingletonKey?.());
        if (singleton && singleton !== item) {
          if (!itemWasProvided) discardUnpresentedItem();
          item = singleton;
        }

        // An opener may return an item that is already in the workspace, e.g.
        // a package reusing a singleton view for its URI. Adding such an item
        // to a second pane is illegal, so activate it where it already lives.
        const existingPane = this.paneForItem(item);
        if (existingPane) {
          pane = existingPane;
        } else if (options.pane) {
          pane = options.pane;
          if (splitRelativeToPane) {
            pendingSplit = { pane, direction: options.split };
          }
        } else {
          let location = preferredLocation;
          const defaultLocation = defaultLocationForItem(item);
          if (!location) location = defaultLocation;

          const allowedLocations = allowedLocationsForItem(item);
          location = allowedLocations.includes(location) ? location : allowedLocations[0];

          const container = this.paneContainers[location] || this.getCenter();
          pane = openingPaneFor(container);
          if (!pane || pane.isDestroyed() || !this.getPanes().includes(pane)) {
            abortOpening();
            discardUnpresentedItem();
            return;
          }
          switch (options.split) {
            case "left":
              {
                const sibling = pane.findLeftmostSibling();
                if (sibling === pane) pendingSplit = { pane, direction: "left" };
                else pane = sibling;
              }
              break;
            case "right":
              {
                const sibling = pane.findRightmostSibling();
                if (sibling === pane) pendingSplit = { pane, direction: "right" };
                else pane = sibling;
              }
              break;
            case "up":
              {
                const sibling = pane.findTopmostSibling();
                if (sibling === pane) pendingSplit = { pane, direction: "up" };
                else pane = sibling;
              }
              break;
            case "down":
              {
                const sibling = pane.findBottommostSibling();
                if (sibling === pane) pendingSplit = { pane, direction: "down" };
                else pane = sibling;
              }
              break;
          }
        }

        // Asked once the item exists, since only then is it known to be an
        // editor rather than a view a package opened. An item already living in
        // the workspace is being activated rather than added, and is never
        // refused.
        if (!existingPane && this.textEditorLimitReached(item, pane, options)) {
          this.reportTextEditorLimit(itemOrURI, options);
          // Built a moment ago and never shown; leaving it would strand its
          // buffer in the project.
          if (!itemWasProvided) discardUnpresentedItem();
          return;
        }
      }

      if (options.split) this.#itemOpenRequests.bindPane(openRequest, pane);
      else this.#itemOpenRequests.activate(openRequest, pane);
      if (!this.#itemOpenRequests.isCurrent(openRequest)) {
        discardUnpresentedItem();
        return;
      }
      if (reuseRequest?.reused) this.recordReusedPendingItemURI(reuseRequest);
      // Presentation can clear or replace pending state. Stop observing before
      // our own successful open changes it, so only external changes cancel us.
      this.#itemOpenRequests.stopTracking(openRequest);

      // A split is a presentation detail, so materialize it only after the
      // opener has produced an item and every refusal path has passed. Passing
      // the item into Pane's constructor means the pane enters the DOM already
      // populated; the empty-pane logo can never occupy an intermediate frame.
      if (pendingSplit) {
        const method = `split${pendingSplit.direction[0].toUpperCase()}${pendingSplit.direction.slice(1)}`;
        pane = pendingSplit.pane[method]({
          items: [item],
          activate: options.activatePane !== false,
        });
        if (!this.#itemOpenRequests.isCurrent(openRequest)) {
          discardUnpresentedItem();
          return;
        }
        this.#itemOpenRequests.bindPane(openRequest, pane);
        if (!this.#itemOpenRequests.isCurrent(openRequest)) {
          discardUnpresentedItem();
          return;
        }
        if (options.pending) pane.setPendingItem(item);
      }

      if (!options.pending && pane.getPendingItem() === item) {
        pane.clearPendingItem();
      }
      if (!this.#itemOpenRequests.isCurrent(openRequest)) return;

      this.itemOpened(item);
      if (!this.#itemOpenRequests.isCurrent(openRequest)) return;

      if (options.activateItem === false) {
        pane.addItem(item, { pending: options.pending, transferred: options.transferred });
      } else {
        pane.activateItem(item, { pending: options.pending, transferred: options.transferred });
      }
      if (!this.#itemOpenRequests.isCurrent(openRequest)) return;

      if (options.activatePane !== false) {
        pane.activate();
      }
      if (!this.#itemOpenRequests.isCurrent(openRequest)) return;

      const hasInitialLine =
        typeof options.initialLine === "number" &&
        !Number.isNaN(options.initialLine) &&
        options.initialLine >= 0;
      const hasInitialColumn =
        typeof options.initialColumn === "number" &&
        !Number.isNaN(options.initialColumn) &&
        options.initialColumn >= 0;
      const initialLine = hasInitialLine ? options.initialLine : 0;
      const initialColumn = hasInitialColumn ? options.initialColumn : 0;

      if (hasInitialLine || hasInitialColumn) {
        if (typeof item.setCursorBufferPosition === "function") {
          item.setCursorBufferPosition([initialLine, initialColumn], { autoscroll: false });
        }
        if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
        if (typeof item.unfoldBufferRow === "function") {
          item.unfoldBufferRow(initialLine);
        }
        if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
        if (typeof item.scrollToBufferPosition === "function") {
          item.scrollToBufferPosition([initialLine, initialColumn], {
            mode: "zone",
          });
        }
        if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
      }

      const index = pane.getActiveItemIndex();
      this.emitter.emit("did-open", { uri, pane, item, index });
      if (!this.#itemOpenRequests.isCurrent(openRequest)) return;

      // After emitting the open event, notify package-owned lazy features.
      let hookItem;
      let hookName;

      if (item instanceof TextEditor) {
        // This is a TextEditor opening, meaning a file
        hookItem = item.getTitle();
        hookName = "file-name-opened";
      } else {
        hookName = "uri-opened";
        if (typeof item.getURI === "function") {
          hookItem = item.getURI();
        } else if (typeof item.getUri === "function") {
          hookItem = item.getUri();
        } else {
          hookItem = "";
          hookName = "";
          // Some pane items do not expose an address; there is no hook to emit.
        }
      }

      if (!this.#itemOpenRequests.isCurrent(openRequest)) return;
      if (hookName?.length > 1 && hookItem?.length > 1) {
        this.packageManager.hooks.trigger(`${hookItem}:${hookName}`);
      }
      opened = true;
    };
    let cleanupFailure;
    try {
      await performOpen();
    } catch (error) {
      failed = true;
      openFailure = error;
    } finally {
      signal?.removeEventListener("abort", abortOpening);
      cleanupFailure = itemDisposalFailure;
      try {
        if (failed || !this.#itemOpenRequests.isCurrent(openRequest)) {
          discardUnpresentedItem();
        }
      } catch (error) {
        cleanupFailure = error;
      }
      try {
        this.#itemOpenRequests.finish(openRequest);
      } catch (error) {
        cleanupFailure = cleanupFailure
          ? new AggregateError([cleanupFailure, error], "Unable to dispose an open request", {
              cause: cleanupFailure,
            })
          : error;
      } finally {
        if (incomingPromise && this.incoming.get(uri) === incomingPromise)
          this.incoming.delete(uri);
        resolveItem();
      }
    }
    if (cleanupFailure) {
      if (failed && openFailure !== cleanupFailure) {
        throw new AggregateError(
          [openFailure, cleanupFailure],
          "Opening an item and its cleanup failed",
          { cause: openFailure },
        );
      }
      throw cleanupFailure;
    }
    if (failed) throw openFailure;
    if (!opened || this.#itemOpenRequests.isCancelled(openRequest)) return;
    return item;
  }

  recordReusedPendingItemURI(request) {
    if (request.historyRecorded || request.oldURI == null) return;
    request.historyRecorded = true;
    this.destroyedItemURIs.push(request.oldURI);
  }

  /**
   * @public
   * @status essential
   *
   * Search the workspace for items matching the given URI and hide them.
   * Center items are closed asynchronously and can remain open if closing is
   * prevented or cancelled. Use {@link #toggle} to await the closing result.
   *
   * @param {String|Object} itemOrURI - The item to hide or a `String` containing the URI of the item to hide.
   * @returns {Boolean} indicating whether any visible matching items were found and hiding or closing was requested.
   */
  hide(itemOrURI) {
    const { foundItems, closingItems } = this.hideItems(itemOrURI);
    for (const closing of closingItems) {
      closing.catch((error) => {
        this.notificationManager.addError("Unable to close workspace item", {
          detail: error?.message ?? String(error),
          stack: error?.stack,
        });
      });
    }
    return foundItems;
  }

  /** @private */
  hideItems(itemOrURI) {
    let foundItems = false;
    const closingItems = [];

    // If any visible item has the given URI, hide it
    for (const container of this.getPaneContainers()) {
      const isCenter = container === this.getCenter();
      if (isCenter || container.isVisible()) {
        for (const pane of container.getPanes()) {
          const activeItem = pane.getActiveItem();
          const foundItem =
            activeItem != null &&
            (activeItem === itemOrURI ||
              (typeof activeItem.getURI === "function" && activeItem.getURI() === itemOrURI));
          if (foundItem) {
            foundItems = true;
            // We can't really hide the center so we just destroy the item.
            if (isCenter) {
              closingItems.push(pane.destroyItem(activeItem));
            } else {
              container.hide();
            }
          }
        }
      }
    }

    return { foundItems, closingItems };
  }

  /**
   * @public
   * @status essential
   *
   * Search the workspace for items matching the given URI. If any are found, hide them.
   * Otherwise, open the URL.
   *
   * @param {String|Object} [itemOrURI] - The item to toggle or a `String` containing the URI of the item to toggle.
   * @returns {Promise} that resolves when the item is shown or hidden, or to `false` if closing a center item is prevented or cancelled. Rejects if closing fails.
   */
  toggle(itemOrURI) {
    const { foundItems, closingItems } = this.hideItems(itemOrURI);
    if (foundItems) {
      return Promise.all(closingItems).then((results) =>
        results.includes(false) ? false : undefined,
      );
    } else {
      return this.open(itemOrURI, { searchAllPanes: true });
    }
  }

  // Open Lumine's own license in the active pane.
  openLicense() {
    return this.openLegalFile("LICENSE");
  }

  openThirdPartyNotices() {
    return this.openLegalFile("THIRD_PARTY_NOTICES");
  }

  openLegalFile(name) {
    const source = path.join(__dirname, "..", name);
    const resource = path.join(process.resourcesPath, name);
    return this.open(fs.existsSync(source) ? source : resource);
  }

  // Synchronously open the given URI in the active pane. **Only use this method
  // in specs. Calling this in production code will block the UI thread and
  // everyone will be mad at you.**
  //
  // * `uri` A `String` containing a URI.
  // * `options` An optional options `Object`
  //   * `initialLine` A `Number` indicating which row to move the cursor to
  //     initially. Defaults to `0`.
  //   * `initialColumn` A `Number` indicating which column to move the cursor to
  //     initially. Defaults to `0`.
  //   * `activatePane` A `Boolean` indicating whether to call {@link Pane#activate} on
  //     the containing pane. Defaults to `true`.
  //   * `activateItem` A `Boolean` indicating whether to call {@link Pane#activateItem}
  //     on containing pane. Defaults to `true`.
  openSync(uri_ = "", options = {}) {
    const { initialLine, initialColumn } = options;
    const activatePane = options.activatePane != null ? options.activatePane : true;
    const activateItem = options.activateItem != null ? options.activateItem : true;

    const normalized = normalizePathOpening(this.project.resolvePath(uri_), options);
    const uri = normalized.uri;
    options = normalized.options;
    const pathOpener = this.resolvePathOpener(uri, options);
    let item = this.itemForPathOpener(this.getActivePane(), uri, pathOpener, options);
    if (uri && item == null) {
      const openers = pathOpener
        ? pathOpener === this.textPathOpener
          ? []
          : [pathOpener.opener]
        : this.getOpeners();
      for (const opener of openers) {
        item = opener(uri, options);
        if (item) break;
      }
    }
    if (pathOpener && pathOpener !== this.textPathOpener && item == null) return;
    if (item == null) {
      item = this.project.openSync(uri, { initialLine, initialColumn });
    }

    if (activateItem) {
      this.getActivePane().activateItem(item);
    }
    this.itemOpened(item);
    if (activatePane) {
      this.getActivePane().activate();
    }
    return item;
  }

  openURIInPane(uri, pane) {
    return this.open(uri, { pane });
  }

  // Whether adding `item` would take the workspace past `core.maxTextEditors`.
  //
  // Only editors are counted, and only editors are refused. They are what the
  // limit exists for — each carries a buffer, a language mode and a repository
  // subscription, and they are what arrives in floods — while the views a
  // package opens are singular and cheap. Refusing those would be its own bug:
  // it can block reaching the very setting that raises the limit.
  //
  // Never refuses in spec mode. Suites open far more files than any sane limit
  // and construct their workspaces deliberately; the limit's own specs drive
  // this method directly.
  textEditorLimitReached(item, pane, options = {}) {
    const limit = this.config.get("core.maxTextEditors");
    if (!limit || options.bypassTextEditorLimit) return false;
    if (!(item instanceof TextEditor)) return false;
    if (globalThis.lumine?.window?.isSpecMode?.()) return false;
    // A preview replaces the pending item rather than adding another.
    if (options.pending && pane?.getPendingItem()) return false;
    return this.getTextEditors().length >= limit;
  }

  // Says an open was refused, and offers to perform it anyway. One notification
  // stands at a time: a refused burst should say so once rather than stack.
  reportTextEditorLimit(itemOrURI, options) {
    const limit = this.config.get("core.maxTextEditors");
    if (this.textEditorLimitNotification) this.textEditorLimitNotification.dismiss();
    this.textEditorLimitNotification = this.notificationManager.addWarning(
      "Too many editors are open",
      {
        description:
          `Nothing was opened: ${limit} editors are already open, the limit set by ` +
          `\`core.maxTextEditors\`. Close one, raise that setting, or set it to 0 for no limit.`,
        dismissable: true,
        buttons: [
          {
            text: "Open anyway",
            onDidClick: () => {
              this.textEditorLimitNotification?.dismiss();
              return this.open(itemOrURI, { ...options, bypassTextEditorLimit: true });
            },
          },
        ],
      },
    );
    return this.textEditorLimitNotification;
  }

  /**
   * @public
   * @status public
   *
   * Creates a new item that corresponds to the provided URI.
   *
   * If no URI is given, or no registered opener can open the URI, a new empty
   * {@link TextEditor} will be created.
   *
   * @param {String} [uri] - A `String` containing a URI.
   * @returns {Promise<Object|undefined>} that resolves to the {@link TextEditor} (or other item) for the given URI.
   * @param {Object} [options] - Options supplied to URI openers.
   * @param {Object} [reuseRequest] - A pending-item reuse request owned by the workspace open lifecycle.
   * @param {Object} [openRequest=reuseRequest] - The current workspace open request used to reject obsolete results.
   */
  async createItemForURI(uri, options, reuseRequest, openRequest = reuseRequest) {
    ({ uri, options } = normalizePathOpening(uri, options));
    const pathOpener =
      openRequest && Object.hasOwn(openRequest, "pathOpener")
        ? openRequest.pathOpener
        : this.resolvePathOpener(uri, options);
    if (uri != null) {
      const openers = pathOpener
        ? pathOpener === this.textPathOpener
          ? []
          : [pathOpener.opener]
        : this.getOpeners();
      for (const opener of openers) {
        if (openRequest && !this.#itemOpenRequests.isCurrent(openRequest)) return;
        if (reuseRequest?.controller.signal.aborted) return;
        const reuse = this.openerReuseCapabilities.get(opener);
        const candidate = reuseRequest?.item;
        if (
          candidate &&
          reuseRequest.pane.getPendingItem() === candidate &&
          !candidate.isDestroyed?.() &&
          reuse?.canReusePendingItem?.(candidate, uri, options)
        ) {
          this.#itemOpenRequests.activate(reuseRequest);
          if (reuseRequest.controller.signal.aborted) return;
          let result;
          try {
            result = await reuse.reusePendingItem(candidate, uri, options, {
              signal: reuseRequest.controller.signal,
            });
          } catch (error) {
            // A view can also cancel its own operation when explicit
            // navigation or reload supersedes the workspace's preview.
            if (reuseRequest.controller.signal.aborted || error?.name === "AbortError") return;
            throw error;
          }
          if (reuseRequest.controller.signal.aborted) return;
          if (result !== false) {
            reuseRequest.reused = true;
            this.didChangePaneItemURI(candidate, reuseRequest.pane);
            return candidate;
          }
        }
        let item;
        try {
          item = opener(uri, options);
        } catch (error) {
          if (openRequest) openRequest.synchronousFailure = { error };
          throw error;
        }
        if (item != null) return item;
      }
    }

    // An explicit or default file handler owns this attempt. A refusal or
    // cancellation must not silently open the same file through another type.
    if (pathOpener && pathOpener !== this.textPathOpener) return;

    // The fallback is a center text editor, so its destination no longer
    // depends on an opener's default location.
    if (openRequest && !this.#itemOpenRequests.isCurrent(openRequest)) return;
    this.#itemOpenRequests.activate(
      reuseRequest,
      options?.pane || this.getCenter().getActivePane(),
    );
    if (reuseRequest?.controller.signal.aborted) return;
    try {
      const item = await this.openTextFile(uri, options, openRequest);
      return item;
    } catch (error) {
      const synchronousFailure = openRequest?.synchronousFailure;
      if (
        openRequest &&
        !this.#itemOpenRequests.isCurrent(openRequest) &&
        !(synchronousFailure && synchronousFailure.error === error)
      )
        return;
      switch (error.code) {
        case "CANCELLED":
          return Promise.resolve();
        case "EACCES":
          this.notificationManager.addWarning(`Permission denied '${error.path}'`);
          return Promise.resolve();
        case "EPERM":
        case "EBUSY":
        case "ENXIO":
        case "EIO":
        case "ENOTCONN":
        case "UNKNOWN":
        case "ECONNRESET":
        case "EINVAL":
        case "EMFILE":
        case "ENOTDIR":
        case "EAGAIN":
          this.notificationManager.addWarning(
            `Unable to open '${error.path != null ? error.path : uri}'`,
            { detail: error.message },
          );
          return Promise.resolve();
        default:
          throw error;
      }
    }
  }

  async openTextFile(uri, options = {}, openRequest) {
    const generation = this.#layoutGeneration;
    const isCurrent = () =>
      this.isAlive() &&
      this.#layoutGeneration === generation &&
      (!openRequest || this.#itemOpenRequests.isCurrent(openRequest));
    if (!isCurrent()) return;
    const filePath = normalizePathOpening(this.project.resolvePath(uri)).uri;

    if (filePath != null) {
      try {
        fs.closeSync(fs.openSync(filePath, "r"));
      } catch (error) {
        // allow ENOENT errors to create an editor for paths that dont exist
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const fileSize = fs.getSizeSync(filePath);

    if (fileSize >= this.config.get("core.warnOnLargeFileLimit") * 1048576) {
      // 40MB by default
      const response = await this.applicationDelegate.confirm({
        message: "Lumine will be unresponsive during the loading of very large files.",
        detail: "Do you still want to load this file?",
        buttons: ["Proceed", "Cancel"],
      });
      if (!isCurrent()) return;
      if (response === 1) {
        const error = new Error();
        error.code = "CANCELLED";
        throw error;
      }
    }

    const buffer = await this.project.bufferForPath(filePath, options);
    // A cached/shared buffer can resolve after reset or teardown without being
    // owned by this request. Leave it with its current owner and stop before
    // entering a replaced or destroyed editor factory.
    if (!isCurrent()) return;
    let editor;
    try {
      editor = this.textEditorFactory.build(Object.assign({ buffer, autoHeight: false }, options));
    } catch (error) {
      if (openRequest) openRequest.synchronousFailure = { error };
      throw error;
    }
    const preparation =
      options.activateItem === false
        ? null
        : buffer
            .getLanguageMode()
            .prepareInitialHighlighting?.(
              options.initialLine ?? editor.getCursorBufferPosition().row,
            );
    if (preparation) {
      await preparation;
      if (!isCurrent()) {
        editor.destroy();
        return;
      }
    }
    return editor;
  }

  handleGrammarUsed(grammar, { root = true } = {}) {
    if (grammar == null) {
      return;
    }

    if (grammar === NullGrammar) return;

    this.packageManager.hooks.trigger("core:grammar-used");

    if (root && typeof grammar.scopeName === "string" && grammar.scopeName.length > 0) {
      this.packageManager.hooks.trigger(`${grammar.scopeName}:root-scope-used`);
    }
    if (typeof grammar.packageName === "string" && grammar.packageName.length > 0) {
      this.packageManager.hooks.trigger(`${grammar.packageName}:grammar-used`);
    }
  }

  /**
   * @public
   * @status public
   *
   * Determine whether a value is a TextEditor instance.
   *
   * @param {*} object - An `Object` you want to perform the check against.
   * @returns {Boolean} that is `true` if `object` is a `TextEditor`.
   * @category Text Editors
   */
  isTextEditor(object) {
    return object instanceof TextEditor;
  }

  /**
   * @public
   * @status extended
   *
   * Create a new text editor.
   *
   * @returns {TextEditor}
   * @param {Object} [params] - TextEditor construction and sizing options.
   * @category Text Editors
   */
  buildTextEditor(params) {
    const editor = this.textEditorFactory.build(params);
    const subscription = this.textEditorFactory.maintainConfig(editor);
    editor.onDidDestroy(() => subscription.dispose());
    return editor;
  }

  /**
   * @public
   * @status essential
   *
   * Create a detached fuzzy-searchable {@link SelectList} model.
   *
   * Like {@link #buildTextEditor}, this returns the complete model rather than
   * a UI facade. It creates its mini TextEditor model immediately, but lazily
   * creates its private renderer and detached element on the first
   * `getElement()` call. The query editor is registered with the window only
   * while that element is connected to the DOM.
   *
   * The model owns data and behavior: items, sections, selection, query,
   * source, actions, recents, pagination and confirmation. It has no panel or
   * modal lifecycle. Pass it to {@link #addSelectList}, or let that method build
   * an owned model, when it should appear as a modal.
   *
   * The list shows one message at a time above the rows, from three props in
   * precedence order — `loadingMessage` (rendered with a spinner, and with
   * `loadingBadge` beside it), then `status`, then `infoMessage`. A `status` is
   * `{type, message, duration, sticky}`: `type` is `'info'`, `'warning'` or
   * `'error'`, `duration` clears it after that many milliseconds, and it is
   * cleared on the next query change unless `sticky`. It covers the resting
   * `infoMessage` rather than replacing it, so clearing it needs nothing put
   * back. `emptyMessage` stands in for the rows when there are none, and stands
   * down while a loading or status message is showing.
   *
   * Data may be supplied as `items`, explicit `sections`, or an asynchronous
   * `source`. `getItemId` defines stable identity, `search` defines matching and
   * query parsing, and `renderItem(item, context)` returns an `HTMLElement`, a
   * managed row view, or a standard row descriptor. `commands` and `actions`
   * declare the operations available through Enter, Shift-F10 and right click.
   *
   * @param {Object} [options] - The initial SelectList options.
   * @returns {SelectList}
   * @category Dialogs
   */
  buildSelectList(options) {
    return this.modalDialogFactory.buildSelectList(options);
  }

  /**
   * @public
   * @status essential
   *
   * Create a lazy {@link SelectListHost}. Passing model options creates a model
   * owned by the host; passing a model from {@link #buildSelectList} borrows it.
   * Destroying an owned host destroys its model, while a borrowed model remains
   * available and may be hosted again. A model can have only one live host.
   *
   * Construction creates neither a Panel nor DOM. `host.show()` creates and
   * opens the modal; `host.getPanel()` explicitly materializes it. The default
   * panel item is the model. A custom `item` must expose a view containing the
   * model element.
   *
   * Every fresh show clears the query unless one is supplied and reapplies the
   * list's `selection.initial`, defaulting to the first result unless empty
   * selection is enabled. Returning from a modal-flow step is a resume and
   * preserves both query and selection.
   *
   * @param {SelectList|Object} [modelOrOptions] - A detached model or its construction options.
   * @param {Object} [hostOptions] - Options belonging to the modal host only.
   * @param {EditorWindow} [hostOptions.window] - The presentation to host in, captured when the host is created; defaults to the focused or main window.
   * @param {*} [hostOptions.item] - Panel item; defaults to the model.
   * @param {String} [hostOptions.crumb] - Declared modal-flow label.
   * @param {Boolean} [hostOptions.visible=false] - Show when the host is first materialized.
   * @param {Boolean} [hostOptions.restoreFocus=true] - Restore focus after hiding.
   * @param {Number} [hostOptions.priority=100] - Panel ordering priority.
   * @param {String} [hostOptions.className] - Class names for the panel element.
   * @returns {SelectListHost}
   * @category Dialogs
   */
  addSelectList(modelOrOptions, hostOptions) {
    return this.modalDialogFactory.addSelectList(modelOrOptions, hostOptions);
  }

  /**
   * @public
   * @status essential
   *
   * Create a detached {@link InputDialog} model whose query editor is the value.
   *
   * This is the base of {@link #buildSelectList} without list semantics, for
   * prompts and save dialogs where the typed text is the answer. Extra DOM goes
   * above the editor through `headerElement` and below it through
   * `contentElement`. Its renderer and detached element are created lazily by
   * `getElement()`; it has no panel or modal lifecycle.
   *
   * The message line works exactly as in {@link #buildSelectList}, minus
   * `emptyMessage`: a validation failure is `status: {type: 'error', message}`,
   * and the dialog clears it on the next keystroke by itself.
   *
   * The model publishes query and confirmation events and supports the same
   * declared commands, actions, messages and asynchronous source contract as
   * SelectList. Confirmation is normally a primary action.
   *
   * @param {Object} [options] - The initial InputDialog options.
   * @returns {InputDialog}
   * @category Dialogs
   */
  buildInputDialog(options) {
    return this.modalDialogFactory.buildInputDialog(options);
  }

  /**
   * @public
   * @status essential
   *
   * Create a lazy {@link InputDialogHost}. Passing options creates an owned
   * model; passing a model from {@link #buildInputDialog} borrows it. Ownership,
   * one-host enforcement and lazy Panel/DOM materialization match
   * {@link #addSelectList}.
   *
   * @param {InputDialog|Object} [modelOrOptions] - A detached model or its construction options.
   * @param {Object} [hostOptions] - Options belonging to the modal host only.
   * @param {*} [hostOptions.item] - Panel item; defaults to the model.
   * @param {String} [hostOptions.crumb] - Declared modal-flow label.
   * @param {Boolean} [hostOptions.visible=false] - Show when the host is first materialized.
   * @param {Boolean} [hostOptions.restoreFocus=true] - Restore focus after hiding.
   * @param {Number} [hostOptions.priority=100] - Panel ordering priority.
   * @param {String} [hostOptions.className] - Class names for the panel element.
   * @returns {InputDialogHost}
   * @category Dialogs
   */
  addInputDialog(modelOrOptions, hostOptions) {
    return this.modalDialogFactory.addInputDialog(modelOrOptions, hostOptions);
  }

  /**
   * @category Modal Flow
   */

  // The keeper of the window's modal breadcrumb trail. Internal — packages
  // reach the flow through {@link Panel#show}'s `crumb` option and the delegates
  // below.
  getModalFlow() {
    if (this.modalFlowKeeper == null) {
      this.modalFlowKeeper = new ModalFlow(this);
    }
    return this.modalFlowKeeper;
  }

  /**
   * @public
   * @status essential
   *
   * Go back one step in the modal breadcrumb trail.
   *
   * A trail exists while a modal shown with {@link Panel#show}'s `crumb` option is
   * on screen. Going back hides the current step — without cancelling it —
   * and re-shows the previous panel with its state intact. Bound to
   * Shift-Escape as `modal:go-back`; Escape still cancels the visible modal,
   * which ends the whole trail.
   *
   * @returns {Boolean} — `false` when there is no step to go back to.
   * @param {EditorWindow} [window] - The presentation whose modal trail should go back; defaults to the main window.
   */
  popModal(window) {
    if (window && !window.isMain()) return window.getModalFlow().pop();
    return this.modalFlowKeeper ? this.modalFlowKeeper.pop() : false;
  }

  /**
   * @public
   * @status essential
   *
   * Jump back to an earlier step of the modal breadcrumb trail.
   *
   * @param {Number} index - The zero-based trail position to return to, as reported by {@link #getModalTrail}. The breadcrumb strip wires its crumbs to this.
   * @returns {Boolean} — `false` when the index is not an earlier step.
   */
  popModalTo(index) {
    return this.modalFlowKeeper ? this.modalFlowKeeper.popTo(index) : false;
  }

  /**
   * @public
   * @status essential
   *
   * The current modal breadcrumb trail.
   *
   * @returns {Array} of `String` labels, root first; empty when no flow is active.
   */
  getModalTrail() {
    return this.modalFlowKeeper ? this.modalFlowKeeper.getTrail() : [];
  }

  /**
   * @public
   * @status extended
   *
   * Invoke the given callback whenever the modal breadcrumb trail
   * changes — a step is entered, the flow goes back, or the trail ends.
   *
   * @param {Function} callback - receiving the trail as {@link #getModalTrail} reports it.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @category Event Subscription
   */
  onDidChangeModalTrail(callback) {
    return this.getModalFlow().onDidChangeTrail(callback);
  }

  /**
   * @public
   * @status public
   *
   * Asynchronously reopens the last-closed item's URI if it hasn't already been
   * reopened.
   *
   * @returns {Promise} that is resolved when the item is opened
   * @category Opening
   */
  reopenItem() {
    const uri = this.destroyedItemURIs.pop();
    if (uri) {
      return this.open(uri);
    } else {
      return Promise.resolve();
    }
  }

  /**
   * @public
   * @status public
   *
   * Register an opener for an internal workspace URI.
   *
   * When a URI is opened via {@link Workspace#open}, Lumine loops through its registered
   * opener functions until one returns a value for the given uri.
   * Openers are expected to return an object that inherits from HTMLElement or
   * a model which has an associated view in the {@link ViewRegistry}.
   * A {@link TextEditor} will be used if no opener returns a value.
   *
   * ## Examples
   *
   * ```js
   * lumine.workspace.addOpener((uri) => {
   *   if (uri === 'lumine://my-package/panel') return new PackagePanel()
   * })
   * ```
   *
   *
   *
   * The opener is called only when its URI is not already open in the searched
   * pane. The searchAllPanes flag expands that search. File viewers use
   * {@link Workspace#addPathOpener}, which distinguishes existing item types
   * for the same path and makes alternative views available through Launcher Open.
   *
   * @param {Function} opener - A `Function` to be called when an internal URI is being opened. Register named file viewers with {@link Workspace#addPathOpener}.
   * @param {Object} [options] - Optional preview reuse capabilities.
   * @param {Function} [options.canReusePendingItem] - Synchronously checks `(item, uri, openOptions)` without changing the item. It is checked at this opener's position in the opener order, before constructing a new item.
   * @param {Function} [options.reusePendingItem] - Asynchronously replaces the document with `(item, uri, openOptions, {signal})`. Return `false` to decline and construct normally. Any other resolved value accepts the reuse. Throw `AbortError` to cancel an open superseded by item-owned navigation or reload. Keep the previous document intact on failure, honor the abort signal before committing, and emit the item's `onDidChangeURI` event after committing. Reuse applies only to unmodified pending items in the same destination, without splitting or background opening.
   * @returns {Disposable} on which `.dispose()` can be called to remove the opener.
   * @category Opening
   */
  addOpener(opener, options = {}) {
    if (options.canReusePendingItem && typeof options.reusePendingItem !== "function") {
      throw new TypeError("A reusable opener must provide reusePendingItem");
    }
    this.openers.push(opener);
    this.openerReuseCapabilities.set(opener, options);
    return new Disposable(() => {
      _.remove(this.openers, opener);
      this.openerReuseCapabilities.delete(opener);
    });
  }

  getOpeners() {
    return this.openers;
  }

  /**
   * @public
   * @status extended
   *
   * Prepare path opener descriptors synchronously before resolving a local path.
   * Use cheap path checks before discovering optional installed integrations.
   * The callback may register openers; their canOpen predicates remain side-effect free.
   * A reentrant query skips callbacks already running, and errors propagate to the caller.
   * Internal and remote URIs do not invoke these callbacks.
   *
   * @param {Function} callback - Receives `{uri, options}` with the normalized local path, URI fragment and detected pathKind. It must finish synchronously without returning a Promise.
   * @returns {Disposable} Removes this callback; opener registrations remain separately owned.
   * @category Opening
   */
  onWillResolvePathOpeners(callback) {
    if (typeof callback !== "function")
      throw new TypeError("A path opener resolution callback must be a function");
    const listener = { callback, invoking: false };
    this.#pathOpenerResolutionListeners.add(listener);
    return new Disposable(() => this.#pathOpenerResolutionListeners.delete(listener));
  }

  /** @private Discover descriptors before availability checks or explicit ID lookup. */
  preparePathOpeners(uri, options) {
    for (const listener of [...this.#pathOpenerResolutionListeners]) {
      if (listener.invoking || !this.#pathOpenerResolutionListeners.has(listener)) continue;
      listener.invoking = true;
      try {
        const result = listener.callback({ uri, options });
        if (result && typeof result.then === "function")
          throw new TypeError("Path opener resolution callbacks must finish synchronously");
      } finally {
        listener.invoking = false;
      }
    }
  }

  /**
   * @public
   * @status extended
   *
   * Register a named path opener for automatic opening and Launcher Open.
   * Availability is checked without constructing a view or opening a path.
   *
   * @param {Object} descriptor - The path opener descriptor.
   * @param {String} descriptor.id - A unique stable opener ID.
   * @param {String} descriptor.label - The name shown in Launcher Open.
   * @param {Function} descriptor.canOpen - Synchronously return a boolean for `(uri, options)` without side effects.
   * @param {Function} descriptor.open - Create an item for `(uri, options)`, or perform an action and return an empty string. May return a Promise.
   * @param {Array<String>} [descriptor.pathKinds=['file']] - Supported local path kinds: 'file' and/or 'directory'.
   * @param {Array<String>} [descriptor.destinations=['current','new-window','detached-window']] - Supported opening destinations. Side-effect actions declare only 'current'.
   * @param {Function} [descriptor.isDefaultEligible] - Synchronously return whether this opener participates in automatic opening; defaults to true. Explicit selection bypasses this preference.
   * @param {Function} [descriptor.handlesItem] - Recognize an existing or restored item for `(item, uri, options)`, including this opener's type and any fragment-specific identity.
   * @param {Function} [descriptor.canReusePendingItem] - Check whether an unmodified pending item can be reused.
   * @param {Function} [descriptor.reusePendingItem] - Replace a pending document with `(item, uri, options, {signal})`.
   * @returns {Disposable} Removes this opener and its preview capabilities.
   * @category Opening
   */
  addPathOpener(descriptor) {
    if (
      !descriptor ||
      typeof descriptor.id !== "string" ||
      !descriptor.id ||
      typeof descriptor.label !== "string" ||
      !descriptor.label ||
      typeof descriptor.canOpen !== "function" ||
      typeof descriptor.open !== "function"
    ) {
      throw new TypeError("A path opener requires id, label, canOpen and open");
    }
    if (
      descriptor.id === this.textPathOpener.id ||
      descriptor.id === this.projectPathOpener.id ||
      this.pathOpeners.some((entry) => entry.id === descriptor.id)
    ) {
      throw new Error(`A path opener with ID '${descriptor.id}' is already registered`);
    }
    for (const key of [
      "isDefaultEligible",
      "handlesItem",
      "canReusePendingItem",
      "reusePendingItem",
    ]) {
      if (descriptor[key] != null && typeof descriptor[key] !== "function") {
        throw new TypeError(`Path opener ${key} must be a function`);
      }
    }
    const pathKinds = descriptor.pathKinds ?? ["file"];
    const destinations = descriptor.destinations ?? OPEN_DESTINATIONS;
    for (const [key, values, allowed] of [
      ["pathKinds", pathKinds, PATH_KINDS],
      ["destinations", destinations, OPEN_DESTINATIONS],
    ]) {
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((value) => !allowed.includes(value)) ||
        new Set(values).size !== values.length
      ) {
        throw new TypeError(`Path opener ${key} must list supported values without duplicates`);
      }
    }
    if (!destinations.includes("current")) {
      throw new TypeError("Path openers must support the current destination");
    }
    const record = { ...descriptor, pathKinds: [...pathKinds], destinations: [...destinations] };
    const remember = (item) => {
      if (!this.pathOpeners.includes(record)) {
        if (item && typeof item === "object" && !this.paneForItem(item)) item.destroy?.();
        return;
      }
      if (item && typeof item === "object") this.pathOpenerItems.set(item, record);
      return item;
    };
    record.opener = (uri, options = {}) => {
      if (
        !this.pathOpeners.includes(record) ||
        !isPathURI(uri) ||
        !this.pathOpenerAvailable(record, uri, options)
      )
        return;
      if (
        options.opener !== record.id &&
        record.isDefaultEligible &&
        !pathOpenerPredicate(record.isDefaultEligible, uri, this.pathOpenerOptions(uri, options))
      )
        return;
      const item = record.open(uri, options);
      return item?.then ? item.then(remember) : remember(item);
    };
    const registration = this.addOpener(record.opener, record);
    this.pathOpeners.push(record);
    return new Disposable(() => {
      registration.dispose();
      const index = this.pathOpeners.indexOf(record);
      if (index !== -1) this.pathOpeners.splice(index, 1);
    });
  }

  /**
   * @public
   * @status extended
   *
   * List path openers without invoking their opening callbacks.
   * The automatic default is first, followed by the other available openers.
   * Text Editor is always included for file paths.
   * Project Folder is included for directory paths.
   *
   * @param {String} uri - The local file or directory path, or file URI.
   * @param {Object} [options] - Opening context supplied to the predicates.
   * @param {String} [options.pathKind] - An already known 'file' or 'directory' kind; otherwise detected from the filesystem.
   * @returns {Array<Object>} Descriptors containing `id`, `label`, `isDefault` and `destinations`.
   * @category Opening
   */
  getAvailablePathOpeners(uri, options = {}) {
    ({ uri, options } = normalizePathOpening(this.project.resolvePath(uri), options));
    if (!uri || !isPathURI(uri)) return [];
    options = this.pathOpenerOptions(uri, options);
    this.preparePathOpeners(uri, options);
    const available = this.pathOpeners.filter((entry) =>
      this.pathOpenerAvailable(entry, uri, options),
    );
    const defaultOpener = this.defaultPathOpener(available, uri, options);
    const fallback = this.builtinPathOpener(uri, options);
    return [defaultOpener, ...available, fallback]
      .filter((entry, index, entries) => entries.indexOf(entry) === index)
      .map(({ id, label, destinations }) => ({
        id,
        label,
        isDefault: id === defaultOpener.id,
        destinations: [...destinations],
      }));
  }

  pathKind(uri, options = {}) {
    if (options.pathKind != null) {
      if (!PATH_KINDS.includes(options.pathKind)) {
        throw new TypeError("A path kind must be 'file' or 'directory'");
      }
      return options.pathKind;
    }
    return fs.isDirectorySync(uri) ? "directory" : "file";
  }

  builtinPathOpener(uri, options) {
    return this.pathKind(uri, options) === "directory"
      ? this.projectPathOpener
      : this.textPathOpener;
  }

  pathOpenerOptions(uri, options) {
    const pathKind = this.pathKind(uri, options);
    return options.pathKind == null ? { ...options, pathKind } : options;
  }

  pathOpenerAvailable(entry, uri, options) {
    return (
      entry.pathKinds.includes(this.pathKind(uri, options)) &&
      (!entry.canOpen ||
        pathOpenerPredicate(entry.canOpen, uri, this.pathOpenerOptions(uri, options)))
    );
  }

  defaultPathOpener(available, uri, options) {
    return (
      available.find(
        (entry) =>
          !entry.isDefaultEligible ||
          pathOpenerPredicate(entry.isDefaultEligible, uri, this.pathOpenerOptions(uri, options)),
      ) ?? this.builtinPathOpener(uri, options)
    );
  }

  resolvePathOpener(uri, options = {}) {
    ({ uri, options } = normalizePathOpening(this.project.resolvePath(uri), options));
    if (uri && isPathURI(uri)) {
      options = this.pathOpenerOptions(uri, options);
      this.preparePathOpeners(uri, options);
    }
    let entry;
    if (options.opener != null) {
      entry = [this.textPathOpener, this.projectPathOpener, ...this.pathOpeners].find(
        (candidate) => candidate.id === options.opener,
      );
      if (!entry || !isPathURI(uri) || !this.pathOpenerAvailable(entry, uri, options)) {
        throw new Error(`The '${options.opener}' opener is not available for this path`);
      }
    } else {
      if (!uri || !isPathURI(uri)) return null;
      const available = this.pathOpeners.filter((candidate) =>
        this.pathOpenerAvailable(candidate, uri, options),
      );
      entry = this.defaultPathOpener(available, uri, options);
    }
    const destination = options.destination ?? "current";
    if (!entry.destinations.includes(destination)) {
      throw new Error(`The '${entry.id}' opener does not support the '${destination}' destination`);
    }
    return entry;
  }

  /**
   * @public
   * @status extended
   *
   * Open a local path in a new independent project window with the selected opener.
   * The opener is resolved and validated before requesting any window.
   * File openings retain the current project roots; directory openings use that directory.
   *
   * @param {String} uri - The local file or directory path, or file URI.
   * @param {Object} [options] - Opening context.
   * @param {String} [options.opener] - A registered path opener ID; defaults to the automatic opener.
   * @param {String} [options.pathKind] - An already known 'file' or 'directory' kind.
   * @param {Number} [options.initialLine] - Zero-based row for the target file.
   * @param {Number} [options.initialColumn] - Zero-based column for the target file.
   * @param {String} [options.uriFragment] - A fragment forwarded to the selected file opener in the new window.
   * @param {AbortSignal} [options.signal] - An aborted signal prevents the window request.
   * @returns {Promise<void>} Resolves after requesting the new window.
   * @category Opening
   */
  async openPathInNewWindow(uri, options = {}) {
    if (options.signal?.aborted) return;
    ({ uri, options } = normalizePathOpening(this.project.resolvePath(uri), options));
    const opener = this.resolvePathOpener(uri, { ...options, destination: "new-window" });
    if (!opener) throw new Error("Only local paths can be opened in a new project window");
    const { devMode, safeMode } = this.applicationDelegate.getWindowLoadSettings();
    if (options.signal?.aborted) return;
    this.applicationDelegate.open({
      pathsToOpen:
        this.pathKind(uri, options) === "directory" ? [uri] : [...this.project.getPaths(), uri],
      opener: opener.id,
      openerPath: uri,
      ...(options.initialLine == null ? {} : { initialLine: options.initialLine }),
      ...(options.initialColumn == null ? {} : { initialColumn: options.initialColumn }),
      ...(options.uriFragment == null ? {} : { uriFragment: options.uriFragment }),
      newWindow: true,
      reuseEmptyWindow: false,
      devMode,
      safeMode,
    });
  }

  itemForPathOpener(pane, uri, opener, options = {}) {
    if (!pane) return;
    if (!opener) return pane.itemForURI(uri);
    return pane
      .getItems()
      .find(
        (item) =>
          (this.getItemURI(item) === uri || item.getPath?.() === uri) &&
          (opener.handlesItem
            ? opener.handlesItem(item, uri, options)
            : this.pathOpenerItems.get(item) === opener),
      );
  }

  paneForPathOpener(uri, opener, options) {
    if (!opener) return this.paneForURI(uri);
    return this.getPanes().find((pane) => this.itemForPathOpener(pane, uri, opener, options));
  }

  paneContainerForPathOpener(uri, opener, options) {
    if (!opener) return this.paneContainerForURI(uri);
    return this.paneForPathOpener(uri, opener, options)?.getContainer();
  }

  /**
   * @category Pane Items
   */

  /**
   * @public
   * @status essential
   *
   * Get all pane items in the workspace.
   *
   * @returns {Array<Object>} of items.
   */
  getPaneItems() {
    return _.flatten(this.getPaneContainers().map((container) => container.getPaneItems()));
  }

  /**
   * @public
   * @status essential
   *
   * Get the active {@link Pane}'s active item.
   *
   * @returns {Object|undefined} The active item, or undefined when the active pane is empty.
   */
  getActivePaneItem() {
    return this.getActivePaneContainer().getActivePaneItem();
  }

  /**
   * @public
   * @status essential
   *
   * Get all text editors in the workspace, if they are pane items.
   *
   * @returns {Array<TextEditor>} of {@link TextEditor TextEditors}.
   * @category Text Editors
   */
  getTextEditors() {
    return this.getPaneItems().filter((item) => item instanceof TextEditor);
  }

  // Long titles for every open editor, computed together and kept until
  // something they depend on changes: which editors are open, and where each
  // one's file lives. A tab bar asks for one per tab and does so again for
  // every item added, so computing them one at a time — each rescanning the
  // whole set — is what made opening a folder's worth of same-named files
  // quadratic in the number of tabs.
  getLongTitles() {
    if (this.longTitles === null) {
      this.longTitles = TextEditor.computeLongTitles(this.getTextEditors());
    }
    return this.longTitles;
  }

  invalidateLongTitles() {
    this.longTitles = null;
  }

  /**
   * @public
   * @status essential
   *
   * Get the workspace center's active item if it is a {@link TextEditor}.
   *
   * @returns {TextEditor|undefined} or `undefined` if the workspace center's current active item is not a {@link TextEditor}.
   * @category Text Editors
   */
  getActiveTextEditor() {
    const activeItem = this.getCenter().getActivePaneItem();
    if (activeItem instanceof TextEditor) {
      return activeItem;
    }
  }

  /**
   * @public
   * @status essential
   *
   * Resolve the innermost text editor containing a DOM target.
   *
   * Unlike the registry, this is a structural lookup: an editor element is
   * enough, even when its owner has not registered the model for observation.
   * It never scans or materializes any other editor views.
   *
   * @param {Element} target - An element inside a text editor.
   * @param {Object} [options]
   * @param {Boolean} [options.includeMini=true] - Whether mini editors qualify.
   * @returns {TextEditor|null} The containing editor, or `null`.
   * @category Text Editors
   */
  getTextEditorForElement(target, { includeMini = true } = {}) {
    let element = target?.nodeType === 1 ? target.closest?.("lumine-text-editor") : null;
    while (element) {
      const editor = typeof element.getModel === "function" ? element.getModel() : null;
      if (editor instanceof TextEditor && (includeMini || !editor.isMini())) return editor;
      element = element.parentElement?.closest?.("lumine-text-editor");
    }
    return null;
  }

  /**
   * @public
   * @status essential
   *
   * Get the text editor containing DOM focus, including embedded editors.
   *
   * This differs from {@link #getActiveTextEditor}, which returns the active
   * workspace-center pane item and deliberately ignores focus in package UI.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.includeMini=true] - Whether mini editors qualify.
   * @returns {TextEditor|null} The focused editor, or `null`.
   * @category Text Editors
   */
  getFocusedTextEditor(options) {
    const document =
      this.getFocusedWindow()?.getDocument() ??
      this.getActivePane()?.getContainer()?.getWindow?.()?.getDocument() ??
      this.getMainWindow()?.getDocument();
    return this.getTextEditorForElement(document?.activeElement, options);
  }

  /**
   * @public
   * @status extended
   *
   * Get the {@link TextEditor} holding the active item's file content.
   *
   * The workspace center's active item itself when it is a text editor;
   * otherwise the editor the item names through its `getFileTextEditor()`
   * method — a notebook names its backing source editor. File-identity status
   * tiles (encoding, line ending) describe this editor, so they stay truthful
   * while a richer view of the file is open.
   *
   * @returns {TextEditor} or `undefined` when the active item holds no file content.
   * @category Text Editors
   */
  getActiveFileTextEditor() {
    const activeItem = this.getCenter().getActivePaneItem();
    if (activeItem instanceof TextEditor) {
      return activeItem;
    }
    const editor =
      typeof activeItem?.getFileTextEditor === "function" ? activeItem.getFileTextEditor() : null;
    if (editor instanceof TextEditor) {
      return editor;
    }
  }

  /**
   * @public
   * @status extended
   *
   * Get the {@link TextEditor} being edited inside the active item.
   *
   * The workspace center's active item itself when it is a text editor;
   * otherwise the editor the item names through its
   * `getActiveEmbeddedTextEditor()` method — a notebook names its active
   * cell's editor. Editing-state status tiles (the grammar tile) describe
   * this editor. An item reporting embedded editors emits its
   * `onDidChangeActiveTextEditors` signal whenever either resolution may have
   * changed; the workspace dedupes and re-emits through
   * {@link #onDidChangeActiveEmbeddedTextEditor}.
   *
   * @returns {TextEditor} or `undefined` when nothing editable is active.
   * @category Text Editors
   */
  getActiveEmbeddedTextEditor() {
    const activeItem = this.getCenter().getActivePaneItem();
    if (activeItem instanceof TextEditor) {
      return activeItem;
    }
    const editor =
      typeof activeItem?.getActiveEmbeddedTextEditor === "function"
        ? activeItem.getActiveEmbeddedTextEditor()
        : null;
    if (editor instanceof TextEditor) {
      return editor;
    }
  }

  // Save all pane items.
  saveAll() {
    return Promise.all(this.getPaneContainers().map((container) => container.saveAll()));
  }

  confirmClose(options) {
    const locations = options?.locations || ALL_LOCATIONS;
    return confirmItemsClose(
      this,
      this.getPanesIn(locations).flatMap((pane) => pane.getItems().map((item) => ({ pane, item }))),
      options,
    );
  }

  /**
   * @public
   * @status extended
   *
   * Save the workspace center's active pane item.
   *
   * If the item has a URI according to its `.getURI` method, calls `.save` on
   * it; otherwise {@link #saveActivePaneItemAs} is called instead. Does nothing when
   * the item implements no `.save` method.
   *
   * Targets the center rather than the focused pane container, for the reason
   * given on {@link #destroyActivePaneItem}.
   * @param {Object} [context] - A captured command context with documentPane and documentItem; otherwise uses the active document pane.
   * @returns {Promise<*>|undefined}
   */
  saveActivePaneItem(context) {
    if (context) return context.documentPane?.saveItem(context.documentItem);
    return this.getCenter().getActivePane().saveActiveItem();
  }

  /**
   * @public
   * @status extended
   *
   * Prompt for a path and save the workspace center's active pane
   * item to it.
   *
   * Opens a native dialog where the user selects a path on disk, then calls
   * `.saveAs` on the item with the selected path. Does nothing when the item
   * implements no `.saveAs` method.
   *
   * Targets the center rather than the focused pane container, for the reason
   * given on {@link #destroyActivePaneItem}.
   * @param {Object} [context] - A captured command context with documentPane and documentItem; otherwise uses the active document pane.
   * @returns {Promise<*>|undefined}
   */
  saveActivePaneItemAs(context) {
    if (context) return context.documentPane?.saveItemAs(context.documentItem);
    return this.getCenter().getActivePane().saveActiveItemAs();
  }

  /**
   * @public
   * @status extended
   *
   * Destroy (close) the active pane item.
   *
   * Removes the active pane item and calls its `.destroy` method if it has one.
   *
   * This one resolves through the *active pane container*, so it closes the
   * focused dock's item while a dock has focus. That pairs it with
   * {@link #getActivePaneItem} and {@link #getActivePane}, which resolve the same way, and
   * is what a package wants when it has already inspected the active item and
   * decided to close it.
   *
   * Its neighbours here deliberately differ: {@link #saveActivePaneItem},
   * {@link #saveActivePaneItemAs} and {@link #closeActivePaneItemOrEmptyPaneOrWindow} are
   * pinned to the workspace center. They back `core:save`, `core:save-as` and
   * `core:close`. These commands act on the document being edited even when
   * focus is in a dock or an input field. Closing a dock item is a separate
   * action performed through its tab or package-owned commands.
   * @returns {Promise<Boolean>} Whether the active item was closed.
   */
  destroyActivePaneItem() {
    return this.getActivePane().destroyActiveItem();
  }

  /**
   * @category Panes
   */

  /**
   * @public
   * @status extended
   *
   * Get the most recently focused pane container.
   *
   * @returns {Dock|WorkspaceCenter} or the {@link WorkspaceCenter}.
   */
  getActivePaneContainer() {
    return this.activePaneContainer;
  }

  /**
   * @public
   * @status extended
   *
   * Get all panes in the workspace.
   *
   * @returns {Array<Pane>} of {@link Pane Panes}.
   */
  getPanes() {
    return _.flatten(this.getPaneContainers().map((container) => container.getPanes()));
  }

  getVisiblePanes() {
    return _.flatten(this.getVisiblePaneContainers().map((container) => container.getPanes()));
  }

  /**
   * @public
   * @status extended
   *
   * Get the active {@link Pane}.
   *
   * @returns {Pane}
   */
  getActivePane() {
    return this.getActivePaneContainer().getActivePane();
  }

  /**
   * @public
   * @status extended
   *
   * Focus the nearest visible pane in a direction, including visible docks.
   * @param {String} direction - up, down, left or right.
   * @param {Object} [options]
   * @param {Pane} [options.sourcePane] - The pane from which to navigate.
   * @returns {Pane|undefined} The pane that received focus.
   */
  focusPaneInDirection(direction, { sourcePane = this.getActivePane() } = {}) {
    const root = sourcePane?.getContainer().getWindow()?.getElement() ?? this.getElement();
    const pane = root.nearestVisiblePaneInDirection(direction, sourcePane)?.getModel();
    pane?.activate();
    return pane;
  }

  /**
   * @public
   * @status extended
   *
   * Move an exact item to an existing pane or a new split, preserving its live view.
   * @param {Object} item - The item to move.
   * @param {Object} options - sourcePane, targetPane or splitDirection, index and activatePane.
   * @returns {Promise<Object>} The final {pane, item}.
   * @category Pane Items
   */
  async movePaneItem(item, options = {}) {
    return this.paneItemTransferService.movePaneItem(item, options);
  }

  /**
   * @public
   * @status extended
   *
   * Copy an exact item before creating its destination, if the item supports copying.
   * @param {Object} item - The item whose document and view state should be copied.
   * @param {Object} options - sourcePane, targetPane or splitDirection, index, activatePane and signal.
   * @returns {Promise<Object|null>} The final {pane, item}, or null when copy() is absent or canCopy() returns false; cancellation rejects with ABORT_ERR.
   * @category Pane Items
   */
  copyPaneItem(item, options = {}) {
    return this.paneItemTransferService.copyPaneItem(item, options);
  }

  /**
   * @public
   * @status extended
   *
   * Make the next pane active.
   */
  activateNextPane() {
    return this.getActivePaneContainer().activateNextPane();
  }

  /**
   * @public
   * @status extended
   *
   * Make the previous pane active.
   */
  activatePreviousPane() {
    return this.getActivePaneContainer().activatePreviousPane();
  }

  /**
   * @public
   * @status extended
   *
   * Get the first pane container that contains an item with the given
   * URI.
   *
   * @param {String} uri - uri
   * @returns {Dock|WorkspaceCenter|undefined}, the {@link WorkspaceCenter}, or `undefined` if no item exists with the given URI.
   * @category Pane Locations
   */
  paneContainerForURI(uri) {
    return this.getPaneContainers().find((container) => container.paneForURI(uri));
  }

  /**
   * @public
   * @status extended
   *
   * Get the first pane container that contains the given item.
   *
   * @param {Object} item - the Item that the returned pane container must contain.
   * @returns {Dock|WorkspaceCenter|undefined}, the {@link WorkspaceCenter}, or `undefined` if no pane container contains the given item.
   * @category Pane Locations
   */
  paneContainerForItem(item) {
    return this.getPaneContainers().find((container) => container.paneForItem(item));
  }

  /**
   * @public
   * @status extended
   *
   * Get the first {@link Pane} that contains an item with the given URI.
   *
   * @param {String} uri - uri
   * @returns {Pane|undefined} or `undefined` if no item exists with the given URI.
   */
  paneForURI(uri) {
    for (let location of this.getPaneContainers()) {
      const pane = location.paneForURI(uri);
      if (pane != null) {
        return pane;
      }
    }
  }

  /**
   * @public
   * @status extended
   *
   * Get the {@link Pane} containing the given item.
   *
   * @param {Object} item - the Item that the returned pane must contain.
   * @returns {Pane|undefined} or `undefined` if no pane exists for the given item.
   */
  paneForItem(item) {
    for (let location of this.getPaneContainers()) {
      const pane = location.paneForItem(item);
      if (pane != null) {
        return pane;
      }
    }
  }

  // Destroy (close) the active pane.
  destroyActivePane() {
    const activePane = this.getActivePane();
    if (activePane != null) {
      activePane.destroy();
    }
  }

  /**
   * @public
   * @status extended
   *
   * Close the workspace center's active pane item, or its active pane
   * if that pane is empty, or the window if only the empty root pane is left.
   *
   * Targets the center rather than the focused pane container, for the reason
   * given on {@link #destroyActivePaneItem}.
   * @param {Object} [context] - A captured documentPane/documentItem context; otherwise uses the active document pane.
   * @returns {Promise<*>|undefined} The selected close operation, or undefined when closing an empty window is disabled.
   * @category Pane Items
   */
  closeActivePaneItemOrEmptyPaneOrWindow(context) {
    const pane = context?.documentPane ?? this.getCenter().getActivePane();
    const item = context ? context.documentItem : pane.getActiveItem();
    const container = pane.getContainer();
    if (item != null) {
      return pane.destroyItem(item);
    } else if (container.getPanes().length > 1) {
      return pane.destroy();
    } else {
      const window = container.getWindow();
      const setting =
        window && !window.isMain() ? "core.closeEmptyDetachedWindows" : "core.closeEmptyWindows";
      if (this.config.get(setting)) return (window ?? this.windowService).close();
    }
  }

  // Increase the editor font size by 1px.
  increaseFontSize() {
    this.config.set("editor.fontSize", this.config.get("editor.fontSize") + 1);
  }

  // Decrease the editor font size by 1px.
  decreaseFontSize() {
    const fontSize = this.config.get("editor.fontSize");
    if (fontSize > 1) {
      this.config.set("editor.fontSize", fontSize - 1);
    }
  }

  // Restore to the window's default editor font size.
  resetFontSize() {
    this.config.set("editor.fontSize", this.config.get("editor.defaultFontSize"));
  }

  // Removes the item's uri from the list of potential items to reopen.
  itemOpened(item) {
    let uri;
    if (typeof item.getURI === "function") {
      uri = item.getURI();
    } else if (typeof item.getUri === "function") {
      uri = item.getUri();
    }

    if (uri != null) {
      _.remove(this.destroyedItemURIs, uri);
    }
  }

  // Adds the destroyed item's uri to the list of items to reopen.
  didDestroyPaneItem({ item }) {
    this.invalidateLongTitles();
    let uri;
    if (typeof item.getURI === "function") {
      uri = item.getURI();
    } else if (typeof item.getUri === "function") {
      uri = item.getUri();
    }

    if (uri != null) {
      this.destroyedItemURIs.push(uri);
    }
  }

  // Called by Model superclass when destroyed
  destroyed() {
    this.#pathOpenerResolutionListeners.clear();
    this.#clearDefaultDockItems();
    const failures = [];
    const capture = (callback) => captureLifecycleError(failures, callback);
    capture(() => this.launcherProviderRegistration?.dispose());
    this.disposables.remove(this.launcherProviderRegistration);
    this.launcherProviderRegistration = null;
    for (const editorWindow of this.getWindows()) capture(() => editorWindow.destroy());
    this.#layoutGeneration++;
    capture(() => this.#itemOpenRequests.destroy());
    this.incoming.clear();
    capture(() => this.registeredTextEditorGrammarSubscription?.dispose());
    this.registeredTextEditorGrammarSubscription = null;
    for (const lease of this.registeredGrammarUsageLeases.values()) capture(() => lease.dispose());
    this.registeredGrammarUsageLeases.clear();
    for (const lease of this.activeItemGrammarUsageLeases.values()) capture(() => lease.dispose());
    this.activeItemGrammarUsageLeases.clear();
    capture(() => this.fileDocumentObservation?.dispose());
    capture(() => this.fileDocuments.dispose());
    capture(() => this.closeStateStore());
    capture(() => {
      void this.modalDialogFactory.destroy();
    });
    capture(() => this.paneContainers.center.destroy());
    capture(() => this.paneContainers.left.destroy());
    capture(() => this.paneContainers.right.destroy());
    capture(() => this.paneContainers.bottom.destroy());
    capture(() => this.cancelStoppedChangingActivePaneItemTimeout());
    if (this.activeItemSubscriptions != null) {
      capture(() => this.activeItemSubscriptions.dispose());
    }
    if (this.element) capture(() => this.element.destroy());
    for (const entry of [...this.grammarUsageEntries.values()]) capture(() => entry.dispose());
    this.grammarUsageEntries.clear();
    throwLifecycleErrors(failures, "Unable to destroy every workspace presentation cleanly.");
  }

  /**
   * @category Pane Locations
   */

  /**
   * @public
   * @status essential
   *
   * Get the {@link WorkspaceCenter} aggregating the document panes of all workspace windows.
   * @returns {WorkspaceCenter} The document-pane aggregate for this workspace.
   */
  getCenter() {
    return this.paneContainers.center;
  }

  /**
   * @public
   * @status essential
   *
   * Get the {@link Dock} to the left of the editor window.
   * @returns {Dock} The main window's dock.
   */
  getLeftDock() {
    return this.paneContainers.left;
  }

  /**
   * @public
   * @status essential
   *
   * Get the {@link Dock} to the right of the editor window.
   * @returns {Dock} The main window's dock.
   */
  getRightDock() {
    return this.paneContainers.right;
  }

  /**
   * @public
   * @status essential
   *
   * Get the {@link Dock} below the editor window.
   * @returns {Dock} The main window's dock.
   */
  getBottomDock() {
    return this.paneContainers.bottom;
  }

  getPaneContainers() {
    return [
      this.paneContainers.center,
      this.paneContainers.left,
      this.paneContainers.right,
      this.paneContainers.bottom,
    ];
  }

  getVisiblePaneContainers() {
    const center = this.getCenter();
    return lumine.workspace
      .getPaneContainers()
      .filter((container) => container === center || container.isVisible());
  }

  /**
   * @public
   * @status extended
   *
   * Declare that a drag which resizes editors has begun — a pane divider, a
   * dock handle, a panel's own resize grip, a gutter's width handle.
   *
   * Such a drag moves editor widths once per animation frame for as long as the
   * button is held, and work derived from those widths is worth deferring until
   * it stops. Soft wrap is the one that ships: it re-wraps on every width
   * change except while a drag is live, when it waits for the width to settle
   * rather than reflowing a frame the next one abandons. Anything that resizes
   * an editor from a `mousemove` should declare it; a one-shot layout change
   * should not, since it is already the final width.
   *
   * Embedded surfaces in the focused presentation temporarily stop taking mouse
   * events until the drag ends. Resize handles should also prevent the primary
   * mousedown's default focus change so the current editor or frame keeps focus.
   *
   * @returns {Disposable} on which `.dispose()` ends the drag. It is safe to
   *   call more than once, which these gestures usually need: a mouseup, a
   *   mousemove that finds no button held any more, a teardown mid-drag.
   * @category Layout
   */
  beginLayoutDrag() {
    const document = this.getFocusedWindow()?.getDocument() ?? this.getMainWindow()?.getDocument();
    return layoutDrag.beginLayoutDrag(document);
  }

  /**
   * @category Panels
   */

  /**
   * @public
   * @status essential
   *
   * Get an `Array` of all the panel items at the bottom of the editor window.
   * @returns {Array<Panel>} The panels in this main-window location.
   */
  getBottomPanels() {
    return this.getPanels("bottom");
  }

  /**
   * @public
   * @status essential
   *
   * Adds a panel item to the bottom of the editor window.
   *
   * @param {Object} options
   * @param {*} options.item - Your panel content. It can be DOM element, a jQuery element, or a model with a view registered via {@link ViewRegistry#addViewProvider}. We recommend the latter. See {@link ViewRegistry#addViewProvider} for more information.
   * @param {Boolean} [options.visible] - false if you want the panel to initially be hidden (default: true)
   * @param {Number} [options.priority] - Determines stacking order. Lower priority items are forced closer to the edges of the window. (default: 100)
   * @returns {Panel}
   */
  addBottomPanel(options) {
    return this.addPanel("bottom", options);
  }

  /**
   * @public
   * @status essential
   *
   * Get an `Array` of all the panel items to the left of the editor window.
   * @returns {Array<Panel>} The panels in this main-window location.
   */
  getLeftPanels() {
    return this.getPanels("left");
  }

  /**
   * @public
   * @status essential
   *
   * Adds a panel item to the left of the editor window.
   *
   * @param {Object} options
   * @param {*} options.item - Your panel content. It can be DOM element, a jQuery element, or a model with a view registered via {@link ViewRegistry#addViewProvider}. We recommend the latter. See {@link ViewRegistry#addViewProvider} for more information.
   * @param {Boolean} [options.visible] - false if you want the panel to initially be hidden (default: true)
   * @param {Number} [options.priority] - Determines stacking order. Lower priority items are forced closer to the edges of the window. (default: 100)
   * @returns {Panel}
   */
  addLeftPanel(options) {
    return this.addPanel("left", options);
  }

  /**
   * @public
   * @status essential
   *
   * Get an `Array` of all the panel items to the right of the editor window.
   * @returns {Array<Panel>} The panels in this main-window location.
   */
  getRightPanels() {
    return this.getPanels("right");
  }

  /**
   * @public
   * @status essential
   *
   * Adds a panel item to the right of the editor window.
   *
   * @param {Object} options
   * @param {*} options.item - Your panel content. It can be DOM element, a jQuery element, or a model with a view registered via {@link ViewRegistry#addViewProvider}. We recommend the latter. See {@link ViewRegistry#addViewProvider} for more information.
   * @param {Boolean} [options.visible] - false if you want the panel to initially be hidden (default: true)
   * @param {Number} [options.priority] - Determines stacking order. Lower priority items are forced closer to the edges of the window. (default: 100)
   * @returns {Panel}
   */
  addRightPanel(options) {
    return this.addPanel("right", options);
  }

  /**
   * @public
   * @status essential
   *
   * Get an `Array` of all the panel items at the top of the editor window.
   * @returns {Array<Panel>} The panels in this main-window location.
   */
  getTopPanels() {
    return this.getPanels("top");
  }

  /**
   * @public
   * @status essential
   *
   * Adds a panel item to the top of the editor window above the tabs.
   *
   * @param {Object} options
   * @param {*} options.item - Your panel content. It can be DOM element, a jQuery element, or a model with a view registered via {@link ViewRegistry#addViewProvider}. We recommend the latter. See {@link ViewRegistry#addViewProvider} for more information.
   * @param {Boolean} [options.visible] - false if you want the panel to initially be hidden (default: true)
   * @param {Number} [options.priority] - Determines stacking order. Lower priority items are forced closer to the edges of the window. (default: 100)
   * @returns {Panel}
   */
  addTopPanel(options) {
    return this.addPanel("top", options);
  }

  /**
   * @public
   * @status essential
   *
   * Get an `Array` of all the panel items in the header.
   * @returns {Array<Panel>} The panels in this main-window location.
   */
  getHeaderPanels() {
    return this.getPanels("header");
  }

  /**
   * @public
   * @status essential
   *
   * Adds a panel item to the header.
   *
   * @param {Object} options
   * @param {*} options.item - Your panel content. It can be DOM element, a jQuery element, or a model with a view registered via {@link ViewRegistry#addViewProvider}. We recommend the latter. See {@link ViewRegistry#addViewProvider} for more information.
   * @param {Boolean} [options.visible] - false if you want the panel to initially be hidden (default: true)
   * @param {Number} [options.priority] - Determines stacking order. Lower priority items are forced closer to the edges of the window. (default: 100)
   * @returns {Panel}
   */
  addHeaderPanel(options) {
    return this.addPanel("header", options);
  }

  /**
   * @public
   * @status essential
   *
   * Get an `Array` of all the panel items in the footer.
   * @returns {Array<Panel>} The panels in this main-window location.
   */
  getFooterPanels() {
    return this.getPanels("footer");
  }

  /**
   * @public
   * @status essential
   *
   * Adds a panel item to the footer.
   *
   * @param {Object} options
   * @param {*} options.item - Your panel content. It can be DOM element, a jQuery element, or a model with a view registered via {@link ViewRegistry#addViewProvider}. We recommend the latter. See {@link ViewRegistry#addViewProvider} for more information.
   * @param {Boolean} [options.visible] - false if you want the panel to initially be hidden (default: true)
   * @param {Number} [options.priority] - Determines stacking order. Lower priority items are forced closer to the edges of the window. (default: 100)
   * @returns {Panel}
   */
  addFooterPanel(options) {
    return this.addPanel("footer", options);
  }

  /**
   * @public
   * @status essential
   *
   * Get an `Array` of all the modal panel items
   * @returns {Array<Panel>} The panels in this main-window location.
   */
  getModalPanels() {
    return this.getPanels("modal");
  }

  /**
   * @public
   * @status essential
   *
   * Adds a panel item as a modal dialog.
   *
   * @param {Object} options
   * @param {*} options.item - Your panel content. It can be a DOM element, a jQuery element, or a model with a view registered via {@link ViewRegistry#addViewProvider}. We recommend the model option. See {@link ViewRegistry#addViewProvider} for more information.
   * @param {EditorWindow} [options.window] - The explicit presentation; defaults to the main window.
   * @param {Boolean} [options.visible] - false if you want the panel to initially be hidden (default: true)
   * @param {Number} [options.priority] - Determines stacking order. Lower priority items are forced closer to the edges of the window. (default: 100)
   * @param {Boolean|Element} [options.autoFocus] - true if you want modal focus managed for you by Lumine. Lumine will automatically focus on this element or your modal panel's first tabbable element when the modal opens and will restore the previously selected element when the modal closes. Lumine will also automatically restrict user tab focus within your modal while it is open. (default: false)
   * @param {Boolean} [options.restoreFocus] - false if you want to manage focus restoration yourself. By default, when a modal panel is hidden, focus returns to the element that was focused before the modal opened — or, for chained modals, before the first modal in the chain opened. (default: true)
   * @param {String} [options.crumb] - the label this panel carries on the modal breadcrumb trail. Used when the panel is shown as a flow step without an explicit label — `panel.show({crumb: true})` — and when a step shown on top of this panel adopts it as the trail root. See {@link Panel#show}.
   * @returns {Panel}
   */
  addModalPanel(options = {}) {
    if (options.window) return options.window.addModalPanel(options);
    return this.addPanel("modal", options);
  }

  /**
   * @public
   * @status essential
   *
   * Find the panel displaying a given item.
   *
   * @param {*} item - Item the panel contains
   * @returns {Panel|null} associated with the given item. Returns `null` when the item has no panel.
   */
  panelForItem(item) {
    for (let location in this.panelContainers) {
      const container = this.panelContainers[location];
      const panel = container.panelForItem(item);
      if (panel != null) {
        return panel;
      }
    }
    return null;
  }

  getPanels(location) {
    return this.panelContainers[location].getPanels();
  }

  addPanel(location, options) {
    if (options == null) {
      options = {};
    }
    const panel = new Panel(options, this.viewRegistry);
    if (location === "modal") {
      panel.flowKeeper = this.getModalFlow();
    } else if (panel.crumb != null) {
      throw new TypeError("The crumb option is only supported on modal panels");
    }
    return this.panelContainers[location].addPanel(panel);
  }

  /**
   * @category Searching and Replacing
   */

  /**
   * @public
   * @status public
   *
   * Performs a search across all files in the workspace as they exist on disk.
   * Open text buffers are not searched.
   *
   *
   *
   * #### Caveats
   *
   * When a project has multiple roots, the patterns in `options.paths` may opt
   * into or out of specific roots.
   *
   * For instance: when only one root is present, `'foo/bar.js'` is construed
   * as a glob meant to match `<root>/foo/bar.js`; when multiple roots are
   * present and at least one project root has a base directory name of `foo`,
   * then `foo/bar.js` is construed as a glob meant only for root `foo` and
   * meant to match `bar.js`.
   *
   * @param {RegExp} regex - to search with.
   * @param {Object} [options]
   * @param {Array<String>} [options.paths] - An `Array` of glob patterns to search within. (See note below for multi-root projects.)
   * @param {Array<String>} [options.ignoredNames] - an `Array` of additional `String` globs to exclude.
   * @param {Boolean} options.useCoreIgnoredNames - whether to include `core.ignoredNames`; defaults to `true`.
   * @param {Boolean} options.excludeVcsIgnoredPaths - whether to honor VCS ignore files. Defaults to `core.excludeVcsIgnoredPaths`.
   * @param {Function} [options.onPathsSearched] - to be periodically called with number of paths searched.
   * @param {Number} options.leadingContextLineCount - default `0`; The number of lines before the matched line to include in the results object.
   * @param {Number} options.trailingContextLineCount - default `0`; The number of lines after the matched line to include in the results object.
   * @param {Function} iterator - callback on each file found.
   * @returns {Promise} with a `cancel()` method that will cancel all of the underlying searches that were started as part of this scan.
   */
  scan(regex, options = {}, iterator) {
    if (_.isFunction(options)) {
      iterator = options;
      options = {};
    }

    const coreIgnoredNames =
      options.useCoreIgnoredNames === false ? [] : (this.config.get("core.ignoredNames") ?? []);
    const ignoredNames = compile(
      merge(AlwaysIgnoredNames, coreIgnoredNames, options.ignoredNames),
    ).patterns;
    const excludeVcsIgnoredPaths =
      options.excludeVcsIgnoredPaths ?? this.config.get("core.excludeVcsIgnoredPaths") ?? true;

    const hasMultipleProjectRoots = lumine.project.getPaths().length > 1;
    let pathsWithProjectRoots = options.paths?.map((p) => [null, p]) ?? undefined;
    if (hasMultipleProjectRoots) {
      let rootBasenames = getBasenamesFromProjectRoots();
      pathsWithProjectRoots = options.paths
        ? options.paths.map((p) => extractProjectRootsFromPathPattern(p, rootBasenames))
        : options.paths;
    } else if (pathsWithProjectRoots) {
      pathsWithProjectRoots = options.paths?.map((p) => [null, p]) ?? undefined;
    }

    // Find a searcher for every Directory in the project. Each searcher that
    // is matched will be associated with an Array of Directory objects in the
    // Map.
    const directoriesForSearcher = new Map();
    const customInclusionsForDirectory = new Map();

    // We set this variable's initial value to what we need it to be in order
    // for a single project root to pass the check below — because if there's
    // only one project root, it can never be skipped altogether.
    let hasOnlyExclusions = true;

    for (const directory of this.project.getDirectories()) {
      let isExplicitlyExcluded = false;
      let filteredPaths = options.paths;
      if (hasMultipleProjectRoots && options.paths) {
        // When there are multiple project roots, we must interpret each path
        // inclusion as though it _could_ start with a segment that references
        // the basename of the project root. That's how users can refine path
        // inclusions/exclusions in a multi-project environment.
        //
        // But we don't want to _mandate_ that path exclusions work this way,
        // since that would make it more tedious to specify globs like (e.g.)
        // `**/src/*.js`. We should only interpret the first segment to refer
        // to a project root if the basename matches that of one of our actual
        // project roots.
        //
        // Given a project with two root folders whose basenames are `foo` and
        // `bar`, here's how various path values are reinterpreted:
        //
        // * `foo/src` is interpreted to mean "search root `foo` with inclusion
        //   `src` and ignore other roots."
        // * `!foo/src` is interpreted to mean "search root `foo` and exclude
        //   results from `src`; also, search root `bar` with no path
        //   inclusions or exclusions."
        // * `foo` is interpreted to mean "search only root `foo` with no path
        //   inclusions or exclusions."
        // * `!foo` is interpreted to mean "search all roots except for `foo`
        //   with no path inclusions or exclusions."
        // * `src/*.js` cannot refer to a project root (since there is no root
        //   with basename of `src`), so it is not reinterpreted; each root
        //   will be searched with a path inclusion of `src/*.js`.
        //
        // Based on these rules, each project root gets its own custom `paths`
        // value; some values may be modified, and some entries in the list may
        // be filtered out entirely.
        //
        // Note that we allow any number of arbitrary paths to be added to a
        // project; the basename of the path is not guaranteed to be unique.
        // But if the user (for instance) adds two different roots with the
        // basename `foo`, we can fairly conclude that they are not concerned
        // with the ability to search only one root and not the other via path
        // exclusions.
        //
        let basename = path.basename(directory.getPath());
        filteredPaths = [];
        for (let [intendedRoot, singlePath] of pathsWithProjectRoots) {
          let isExclusion = singlePath.startsWith("!");
          if (!isExclusion) {
            hasOnlyExclusions = false;
          }
          if (intendedRoot === null) {
            // This path pattern was specifically meant for this root, or else
            // was meant to apply to all roots.
            filteredPaths.push(singlePath);
          } else if (intendedRoot === basename) {
            // This path pattern was specifically meant for this root.
            if (singlePath === "!") {
              // This path pattern is specifically excluding this project root
              // altogether! Thus we should skip searching in it entirely, even
              // if other path patterns would have matched.
              isExplicitlyExcluded = true;
              break;
            }
            // Otherwise it counts as an inclusion.
            filteredPaths.push(singlePath);
          } else {
            // This path pattern is referring to a specific pattern in another
            // root. Do nothing.
          }
        }
        customInclusionsForDirectory.set(directory, filteredPaths);
      }

      // Ordinarily, when `paths` is undefined or empty, we interpret that as
      // meaning that we should search the entire root.
      //
      // But when there are multiple project roots, it's harder to discern.
      // Here are the rules we're trying to follow:
      //
      // * If `paths` explicitly excludes the current root entirely, we'll skip
      //   it, no matter what. (For example, `!foo` will exclude root `foo`, no
      //   matter what other values may be present in `paths`.)
      // * Otherwise, if `paths` includes at least one value that applies to
      //   the current root — either because its basename is mentioned
      //   explicitly or because it is a pattern whose first segment does not
      //   match up with a root basename — then we will include it in the
      //   search.
      // * If neither of the first two rules applies, that means no `paths`
      //   target the current root, but it is still presumed to be included
      //   unless it is _implicitly excluded_ by the given paths. For instance:
      //   if there are roots `foo` and `bar`, and `paths` contains only
      //   `bar/src`, then the fact the user opted into `bar` by name is
      //   interpreted as implicitly excluding `foo`.
      // * On the other hand, if `paths` contained only `!bar/src` in the
      //   example above, then no other roots were explicitly included or
      //   implicitly excluded; thus `foo` would be included in the search.
      //
      if (isExplicitlyExcluded || ((filteredPaths ?? []).length === 0 && !hasOnlyExclusions)) {
        // This directory is either explicitly or implicitly excluded in its
        // entirety based on the normalized value of `paths`.
        continue;
      }

      // ripgrep is the built-in searcher; a package-provided directory searcher
      // (workspace.search-provider) still takes precedence when it claims the dir.
      let searcher = this.ripgrepDirectorySearcher;
      for (const directorySearcher of this.directorySearchers) {
        if (directorySearcher.canSearchDirectory(directory)) {
          searcher = directorySearcher;
          break;
        }
      }
      let directories = directoriesForSearcher.get(searcher);
      if (!directories) {
        directories = [];
        directoriesForSearcher.set(searcher, directories);
      }
      directories.push(directory);
    }

    // Define the onPathsSearched callback.
    let onPathsSearched;
    if (_.isFunction(options.onPathsSearched)) {
      // Each directory search reports its own cumulative count, even when
      // several roots use the same searcher.
      const onPathsSearchedOption = options.onPathsSearched;
      let totalNumberOfPathsSearched = 0;
      const numberOfPathsSearchedForDirectory = new Map();
      onPathsSearched = function (directory, numberOfPathsSearched) {
        const oldValue = numberOfPathsSearchedForDirectory.get(directory);
        if (oldValue) {
          totalNumberOfPathsSearched -= oldValue;
        }
        numberOfPathsSearchedForDirectory.set(directory, numberOfPathsSearched);
        totalNumberOfPathsSearched += numberOfPathsSearched;
        return onPathsSearchedOption(totalNumberOfPathsSearched);
      };
    } else {
      onPathsSearched = function () {};
    }

    // Kick off all of the searches and unify them into one Promise.
    const allSearches = [];
    directoriesForSearcher.forEach((directories, searcher) => {
      const searchOptions = {
        inclusions: options.paths || [],
        includeHidden: true,
        excludeVcsIgnores: excludeVcsIgnoredPaths,
        exclusions: ignoredNames,
        follow: this.config.get("core.followSymlinks"),
        leadingContextLineCount: options.leadingContextLineCount || 0,
        trailingContextLineCount: options.trailingContextLineCount || 0,
        PCRE2: options.PCRE2,
        didMatch: iterator,
        didError(error) {
          return iterator(null, error);
        },
      };
      // When there are multiple roots, we build separate `inclusions` for each
      // root. If those were set earlier, we should use them now.
      //
      // Several roots can share a searcher, but each directory needs a
      // separate search with its own inclusions and progress callback.
      let directorySearchers = directories.map((dir) => {
        let customInclusions = customInclusionsForDirectory.get(dir);
        let customSearchOptions = {
          ...searchOptions,
          didSearchPaths(count) {
            return onPathsSearched(dir, count);
          },
        };
        if (customInclusions) {
          customSearchOptions.inclusions = customInclusions;
        }
        return searcher.search([dir], regex, customSearchOptions);
      });
      allSearches.push(...directorySearchers);
    });

    const searchPromise = Promise.all(allSearches);

    // Make sure the Promise that is returned to the client is cancelable. To
    // be consistent with the existing behavior, instead of cancel() rejecting
    // the promise, it should resolve it with the special value 'cancelled'. At
    // least the built-in search-panel package relies on this behavior.
    let isCancelled = false;
    const cancellablePromise = new Promise((resolve, reject) => {
      const onSuccess = function () {
        if (isCancelled) {
          resolve("cancelled");
        } else {
          resolve(null);
        }
      };

      const onFailure = function (error) {
        for (let promise of allSearches) {
          promise.cancel();
        }
        reject(error);
      };

      searchPromise.then(onSuccess, onFailure);
    });
    cancellablePromise.cancel = () => {
      isCancelled = true;
      // Note that cancelling all of the members of allSearches will cause all of the searches
      // to resolve, which causes searchPromise to resolve, which is ultimately what causes
      // cancellablePromise to resolve.
      allSearches.map((promise) => promise.cancel());
    };

    return cancellablePromise;
  }

  /**
   * @public
   * @status public
   *
   * Performs a replace across all the specified files in the project on disk.
   * Open text buffers receive the disk edits and retain nonoverlapping unsaved
   * changes. Different overlapping edits leave the buffer conflicted. Buffer-only matches
   * are not replaced, and unsaved changes are not written to disk.
   *
   * @param {RegExp} regex - A `RegExp` to search with.
   * @param {String} replacementText - to replace all matches of regex with.
   * @param {Array<String>} filePaths - An `Array` of file path strings to run the replace on.
   * @param {Function} iterator - A `Function` callback on each file with replacements:
   * @param {Object} iterator.options - with keys `filePath` and `replacements`.
   * @returns {Promise<void>}
   */
  async replace(regex, replacementText, filePaths, iterator) {
    const requestedPaths = [...new Set(filePaths)];
    if (requestedPaths.length === 0) return;

    const requestedPathSet = new Set(requestedPaths);
    const openBuffers = this.project
      .getBuffers()
      .filter((buffer) => requestedPathSet.has(buffer.getPath()))
      .map((buffer) => ({ buffer, file: buffer.file, path: buffer.getPath() }));
    await Promise.all(openBuffers.map(({ buffer }) => buffer.getFileWatchStartPromise()));
    const suspended = [];
    try {
      for (const { buffer } of openBuffers) {
        if (buffer.isDestroyed()) continue;
        suspended.push(buffer);
        await buffer.beginFileOperation();
      }
      await new Promise((resolve, reject) => {
        const flags = regex.global ? regex.flags : `${regex.flags}g`;
        const task = Task.once(
          require.resolve("./replace-handler"),
          requestedPaths,
          regex.source,
          flags,
          replacementText,
          openBuffers.map(({ path }) => path),
          () => resolve(),
        );
        const deliver = (callback) => {
          try {
            callback();
          } catch (error) {
            task.terminate();
            reject(error);
          }
        };
        task.on("replace:path-replaced", ({ filePath, replacements, fileChanges }) =>
          deliver(() => {
            for (const entry of openBuffers) {
              if (
                entry.path === filePath &&
                entry.buffer.file === entry.file &&
                entry.buffer.getPath() === filePath
              ) {
                entry.buffer.applyFileChanges(fileChanges);
              }
            }
            iterator({ filePath, replacements });
          }),
        );
        task.on("replace:file-error", (error) => deliver(() => iterator(null, error)));
      });
    } finally {
      await Promise.all(suspended.map((buffer) => buffer.endFileOperation()));
    }
  }

  async checkoutHeadRevision(editor) {
    if (editor.getPath()) {
      const checkoutHead = async () => {
        const repository = await this.project.repositoryForDirectory(
          new ProjectDirectory(editor.getDirectoryPath()),
        );
        if (repository) await repository.checkoutHeadForEditor(editor);
      };

      if (this.config.get("git.confirmCheckoutHeadRevision")) {
        const response = await this.applicationDelegate.confirm({
          message: "Confirm Checkout HEAD Revision",
          detail: `Are you sure you want to discard all changes to "${editor.getFileName()}" since the last Git commit?`,
          buttons: ["OK", "Cancel"],
        });
        if (response === 0) await checkoutHead();
      } else {
        await checkoutHead();
      }
    }
  }
};
