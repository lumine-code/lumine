const crypto = require("crypto");
const { Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const NativePathsDropProvider = require("./native-paths-drop-provider");
const {
  PROTOCOL_VERSION,
  MIME_PREFIX,
  inspect,
  mimeTypeForDescriptor,
  normalizeDescriptor,
  parseMimeType,
  read,
  write,
} = require("./workspace-drop-protocol");
const { splitForPoint, boundsForSplit } = require("./workspace-drop-geometry");

const COMMIT_EVENT = "core:workspace-drop-commit";
const ROLLBACK_EVENT = "core:workspace-drop-rollback";
const COMMIT_RESULT_EVENT = "core:workspace-drop-commit-result";
const SESSION_TTL_MS = 2 * 60 * 1000;
const REMOTE_COMMIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @public
 * @status extended
 *
 * Routes workspace drag-and-drop through one capture lifecycle. Providers own
 * source semantics; targets own surface-specific context and visuals.
 */
class WorkspaceDropManager {
  constructor({ workspace, applicationDelegate, windowService }) {
    this.workspace = workspace;
    this.applicationDelegate = applicationDelegate;
    this.windowService = windowService;
    this.providers = [];
    this.targets = [];
    this.sessions = new Map();
    this.remoteSessionWindows = new Map();
    this.pendingRemoteCommits = new Map();
    this.subscriptions = new CompositeDisposable();
    this.surfaces = new Map();
    this.mainSurface = null;
    this.nextOrder = 0;

    this.addProvider(new NativePathsDropProvider(this), { priority: -1000 });
  }

  initialize() {
    if (this.initialized) return;
    this.initialized = true;
    this.subscriptions.add(
      this.windowService.onDidReceive(COMMIT_EVENT, (message) => {
        void this.receiveSessionResult("commit", message).catch((error) => console.error(error));
      }),
      this.windowService.onDidReceive(ROLLBACK_EVENT, (message) => {
        void this.receiveSessionResult("rollback", message).catch((error) => console.error(error));
      }),
      this.windowService.onDidReceive(COMMIT_RESULT_EVENT, (message) => {
        this.receiveRemoteCommitResult(message);
      }),
    );
    if (this.workspace.element) this.rebind(this.workspace.element);
  }

  /** @private Bind the main presentation after its layout root is replaced. */
  rebind(element = this.workspace.element) {
    if (!element || this.mainSurface?.element === element) return;
    if (this.mainSurface) this.releaseSurface(this.mainSurface);
    this.mainSurface = this.attachPresentation(element);
  }
  /** @private Attach a physical document without duplicating providers or sessions. */
  attachPresentation(element) {
    const existing = this.surfaces.get(element);
    if (existing) return existing;
    const Surface = require("./workspace-drop-surface");
    const surface = new Surface(this, element);
    this.surfaces.set(element, surface);
    return surface;
  }
  /** @private Retire one document's listeners and preview. */
  releaseSurface(surface) {
    if (this.surfaces.get(surface.element) !== surface) return;
    this.surfaces.delete(surface.element);
    surface.destroy();
  }
  surfaceForEvent(event) {
    return (
      [...this.surfaces.values()].find(
        (surface) => surface.element.ownerDocument === event.target?.ownerDocument,
      ) ?? this.mainSurface
    );
  }
  handleDragEnter(event) {
    return this.surfaceForEvent(event)?.handleDragEnter(event);
  }
  handleDragOver(event) {
    return this.surfaceForEvent(event)?.handleDragOver(event);
  }
  handleDragLeave(event) {
    return this.surfaceForEvent(event)?.handleDragLeave(event);
  }
  handleDrop(event) {
    return this.surfaceForEvent(event)?.handleDrop(event);
  }
  clearActiveClaim() {
    for (const surface of this.surfaces.values()) surface.clearActiveClaim();
  }
  get activeClaim() {
    return this.mainSurface?.activeClaim;
  }
  get overlay() {
    return this.mainSurface?.overlay;
  }
  get element() {
    return this.mainSurface?.element;
  }

  destroy() {
    for (const surface of this.surfaces.values()) surface.destroy();
    this.surfaces.clear();
    this.mainSurface = null;
    this.subscriptions.dispose();
    this.targets = [];
    this.providers = [];
    for (const [token, session] of this.sessions) {
      clearTimeout(session.timeout);
      void Promise.resolve()
        .then(() => session.rollback?.({ token, reason: "manager-destroyed" }))
        .catch(() => {});
    }
    this.sessions.clear();
    this.remoteSessionWindows.clear();
    for (const pending of this.pendingRemoteCommits.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(true);
    }
    this.pendingRemoteCommits.clear();
  }

  /**
   * @public
   * @status extended
   *
   * Register a provider for a serializable workspace drag kind.
   *
   * Providers are consulted by descending `priority`; ties preserve registration order. A provider exposes a synchronous `propose(context)` for protected drag events, then optional `prepareDrop(context)` and `perform(context, prepared)` methods for the drop itself.
   *
   * @param provider - An `Object` implementing `propose(context)` or `canHandle(context)`.
   * @param {Object} [options] - Registration options.
   * @param {Number} [options.priority=0] - Provider priority.
   * @returns {Disposable} A disposable that unregisters the provider.
   */
  addProvider(provider, { priority = 0 } = {}) {
    if (
      !provider ||
      (typeof provider.propose !== "function" && typeof provider.canHandle !== "function")
    ) {
      throw new TypeError("A workspace drop provider must implement propose() or canHandle()");
    }
    const entry = { provider, priority, order: this.nextOrder++ };
    this.providers.push(entry);
    this.providers.sort((a, b) => b.priority - a.priority || a.order - b.order);
    return new Disposable(() => {
      const index = this.providers.indexOf(entry);
      if (index >= 0) this.providers.splice(index, 1);
    });
  }

  /**
   * @public
   * @status extended
   *
   * Register a workspace drop surface and its visual/placement adapter.
   *
   * The deepest registered element in the event path wins. The adapter can provide `getPane`, `getContext`, `getIndex`, `canDrop`, and drag lifecycle callbacks.
   *
   * @param element - The target `Element`.
   * @param adapter - An adapter describing the target surface.
   * @param {Object} [options] - Registration options.
   * @param {Number} [options.priority=0] - Priority among targets at the same depth.
   * @returns {Disposable} A disposable that unregisters the target.
   */
  addTarget(element, adapter = {}, { priority = 0 } = {}) {
    if (!element?.addEventListener)
      throw new TypeError("A workspace drop target must be an Element");
    const entry = { element, adapter, priority, order: this.nextOrder++ };
    this.targets.push(entry);
    return new Disposable(() => {
      const index = this.targets.indexOf(entry);
      if (index >= 0) this.targets.splice(index, 1);
      for (const surface of this.surfaces.values())
        if (surface.activeClaim?.target === entry) surface.clearActiveClaim();
    });
  }

  /**
   * @public
   * @status extended
   *
   * Create an exact, expiring source session for a move between windows.
   *
   * @param value - The source value retained only in its owning window.
   * @param {Object} [callbacks] - Settlement callbacks.
   * @param {Function} [callbacks.commit] - Called after a target accepts the move; return or resolve to `false` to reject it.
   * @param {Function} [callbacks.rollback] - Called when the move is abandoned or rejected.
   * @returns {Object} An object containing the serializable session `token`.
   */
  createSession(value, { commit, rollback } = {}) {
    const token = crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex");
    const timeout = setTimeout(
      () => void this.expireSession(token).catch(() => {}),
      SESSION_TTL_MS,
    );
    timeout.unref?.();
    this.sessions.set(token, { value, commit, rollback, timeout });
    return { token };
  }

  /**
   * @public
   * @status extended
   *
   * Return the exact local value retained for a drag session token.
   *
   * @param token - A session token.
   * @returns {*} the retained value, or `undefined` outside its source window.
   */
  getSession(token) {
    token = this.sessionToken(token);
    return this.sessions.get(token)?.value;
  }

  /**
   * @public
   * @status extended
   *
   * Commit a local or cross-window drag session.
   *
   * @param token - A session token.
   * @param result - Structured-cloneable result details. Cross-window callers include `sourceWindowId`.
   * @returns {Promise} resolving to whether the source accepted the move.
   */
  async commit(token, result = {}) {
    return this.settleSession("commit", token, result);
  }

  /**
   * @public
   * @status extended
   *
   * Roll back a local or cross-window drag session.
   *
   * @param token - A session token.
   * @param reason - A serializable reason for abandoning the move.
   * @param {Object} [options] - Cross-window routing when no drag descriptor was read locally.
   * @param {Number} [options.sourceWindowId] - The source window of a programmatic transfer.
   * @returns {Promise} resolving to whether the rollback was delivered.
   */
  async rollback(token, reason, { sourceWindowId } = {}) {
    return this.settleSession("rollback", token, { reason, sourceWindowId });
  }

  async settleSession(action, token, result) {
    token = this.sessionToken(token);
    if (!token) return false;
    const session = this.sessions.get(token);
    if (session) {
      this.sessions.delete(token);
      this.remoteSessionWindows.delete(token);
      clearTimeout(session.timeout);
      const callbackResult = await session[action]?.(result, session.value);
      return callbackResult !== false;
    }

    const sourceWindowId = result?.sourceWindowId ?? this.remoteSessionWindows.get(token);
    if (sourceWindowId == null) return false;
    const eventName = action === "commit" ? COMMIT_EVENT : ROLLBACK_EVENT;
    if (action === "rollback") {
      await this.windowService.broadcast(eventName, { sourceWindowId, token, result });
      this.remoteSessionWindows.delete(token);
      return true;
    }

    const requestId = crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex");
    const targetWindowId = this.windowService.getId();
    let pending;
    const response = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pendingRemoteCommits.get(requestId) !== pending) return;
        this.pendingRemoteCommits.delete(requestId);
        // Once a commit has been sent, retaining the destination item is safer
        // than deleting the only surviving copy if the acknowledgement is lost.
        resolve(true);
      }, REMOTE_COMMIT_TIMEOUT_MS);
      timeout.unref?.();
      pending = { token, action, resolve, timeout };
      this.pendingRemoteCommits.set(requestId, pending);
    });

    try {
      await this.windowService.broadcast(eventName, {
        sourceWindowId,
        targetWindowId,
        requestId,
        token,
        result,
      });
      return await response;
    } catch (error) {
      if (this.pendingRemoteCommits.get(requestId) === pending) {
        this.pendingRemoteCommits.delete(requestId);
        clearTimeout(pending.timeout);
      }
      throw error;
    } finally {
      this.remoteSessionWindows.delete(token);
    }
  }

  async receiveSessionResult(action, message) {
    if (message?.sourceWindowId !== this.windowService.getId()) return;
    const session = this.sessions.get(message.token);
    let accepted = false;
    let errorMessage = "The source drag session is no longer available";
    if (session) {
      this.sessions.delete(message.token);
      clearTimeout(session.timeout);
      try {
        accepted = (await session[action]?.(message.result, session.value)) !== false;
        if (accepted) errorMessage = null;
        else errorMessage = `The source rejected the ${action}`;
      } catch (error) {
        errorMessage = error?.message || `The source failed to ${action}`;
      }
    }

    if (action === "commit" && message.requestId && message.targetWindowId != null) {
      await this.windowService.broadcast(COMMIT_RESULT_EVENT, {
        targetWindowId: message.targetWindowId,
        requestId: message.requestId,
        token: message.token,
        accepted,
        error: errorMessage,
      });
    }
    return accepted;
  }

  receiveRemoteCommitResult(message) {
    if (message?.targetWindowId !== this.windowService.getId()) return;
    const pending = this.pendingRemoteCommits.get(message.requestId);
    if (!pending || pending.token !== message.token || pending.action !== "commit") return;
    this.pendingRemoteCommits.delete(message.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(message.accepted === true);
  }

  sessionToken(tokenOrSession) {
    return typeof tokenOrSession === "object" ? tokenOrSession?.token : tokenOrSession;
  }

  async expireSession(token) {
    const session = this.sessions.get(token);
    if (!session) return;
    this.sessions.delete(token);
    await session.rollback?.({ token, reason: "expired" }, session.value);
  }

  /**
   * @public
   * @status extended
   *
   * Write one versioned Lumine descriptor to a `DataTransfer`.
   *
   * @param dataTransfer - The drag's `DataTransfer`.
   * @param descriptor - A descriptor containing `kind`, `items`, source metadata, effect, and allowed locations.
   * @returns {Object} the normalized descriptor written to the transfer.
   */
  write(dataTransfer, descriptor) {
    return write(dataTransfer, descriptor);
  }

  /**
   * @public
   * @status extended
   *
   * Inspect a drag offer using only types visible in protected drag mode.
   *
   * @param dataTransfer - The drag's `DataTransfer`.
   * @returns {Object|null} an offer object, or `null` when the drag is unsupported.
   */
  inspect(dataTransfer) {
    return inspect(dataTransfer);
  }

  /**
   * @public
   * @status extended
   *
   * Read and validate a complete Lumine descriptor during `drop`.
   *
   * @param dataTransfer - The drop's readable `DataTransfer`.
   * @returns {Object|null} a normalized descriptor, or `null` when it is malformed or unavailable.
   */
  read(dataTransfer) {
    const descriptor = read(dataTransfer);
    if (
      descriptor?.token &&
      descriptor.source?.windowId != null &&
      descriptor.source.windowId !== this.windowService.getId()
    ) {
      this.remoteSessionWindows.set(descriptor.token, descriptor.source.windowId);
    }
    return descriptor;
  }

  normalizeDescriptor(descriptor) {
    return normalizeDescriptor(descriptor);
  }

  mimeTypeForDescriptor(descriptor) {
    return mimeTypeForDescriptor(descriptor);
  }

  parseMimeType(type) {
    return parseMimeType(type);
  }
}

module.exports = WorkspaceDropManager;
module.exports.PROTOCOL_VERSION = PROTOCOL_VERSION;
module.exports.MIME_PREFIX = MIME_PREFIX;
module.exports.splitForPoint = splitForPoint;
module.exports.boundsForSplit = boundsForSplit;
