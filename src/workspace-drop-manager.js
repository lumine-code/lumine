const crypto = require("crypto");
const { Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const NativePathsDropProvider = require("./native-paths-drop-provider");
const {
  PROTOCOL_VERSION,
  MIME_PREFIX,
  inspect,
  mimeTypeForDescriptor,
  nativeSummary,
  normalizeDescriptor,
  parseMimeType,
  read,
  write,
} = require("./workspace-drop-protocol");
const { SPLITS, splitForPoint, boundsForSplit } = require("./workspace-drop-geometry");

const COMMIT_EVENT = "core:workspace-drop-commit";
const ROLLBACK_EVENT = "core:workspace-drop-rollback";
const COMMIT_RESULT_EVENT = "core:workspace-drop-commit-result";
const SESSION_TTL_MS = 2 * 60 * 1000;
const REMOTE_COMMIT_TIMEOUT_MS = 5 * 60 * 1000;

function paneForElement(element) {
  const paneElement = element?.closest?.("lumine-pane");
  return paneElement?.getModel?.() || null;
}

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
    this.domSubscriptions = new CompositeDisposable();
    this.activeClaim = null;
    this.leaveFrame = null;
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

  rebind(element = this.workspace.element) {
    if (!element || this.element === element) return;
    this.clearActiveClaim();
    this.domSubscriptions.dispose();
    this.domSubscriptions = new CompositeDisposable();
    this.overlay?.remove();

    this.element = element;
    const document = this.element.ownerDocument;
    const window = document.defaultView;
    this.overlay = document.createElement("div");
    this.overlay.className = "workspace-drop-overlay";
    this.element.appendChild(this.overlay);

    const dragEnter = (event) => this.handleDragEnter(event);
    const dragOver = (event) => this.handleDragOver(event);
    const dragLeave = (event) => this.handleDragLeave(event);
    const drop = (event) => void this.handleDrop(event).catch((error) => console.error(error));
    const dragEnd = () => this.clearActiveClaim();
    const blur = () => this.clearActiveClaim();
    this.element.addEventListener("dragenter", dragEnter, true);
    this.element.addEventListener("dragover", dragOver, true);
    this.element.addEventListener("dragleave", dragLeave, true);
    this.element.addEventListener("drop", drop, true);
    window.addEventListener("dragend", dragEnd, true);
    window.addEventListener("blur", blur, true);
    const boundElement = this.element;
    this.domSubscriptions.add(
      new Disposable(() => {
        boundElement.removeEventListener("dragenter", dragEnter, true);
        boundElement.removeEventListener("dragover", dragOver, true);
        boundElement.removeEventListener("dragleave", dragLeave, true);
        boundElement.removeEventListener("drop", drop, true);
        window.removeEventListener("dragend", dragEnd, true);
        window.removeEventListener("blur", blur, true);
      }),
    );
  }

  destroy() {
    this.cancelPendingLeave();
    this.clearActiveClaim();
    this.domSubscriptions.dispose();
    this.subscriptions.dispose();
    this.overlay?.remove();
    this.overlay = null;
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
      if (this.activeClaim?.target === entry) this.clearActiveClaim();
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
   * @returns {Promise} resolving to whether the rollback was delivered.
   */
  async rollback(token, reason) {
    return this.settleSession("rollback", token, { reason });
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

  handleDragEnter(event) {
    this.cancelPendingLeave();
    this.claimDrag(event, "enter");
  }

  handleDragOver(event) {
    this.cancelPendingLeave();
    this.claimDrag(event, "over");
  }

  handleDragLeave(event) {
    if (!this.activeClaim) return;
    this.setDropEffect(event.dataTransfer, this.activeClaim.proposal.effect);
    if (this.activeClaim.target.element?.contains?.(event.relatedTarget)) return;
    if (event.relatedTarget == null) {
      this.cancelPendingLeave();
      this.leaveFrame = requestAnimationFrame(() => {
        this.leaveFrame = null;
        this.clearActiveClaim();
      });
    } else {
      this.clearActiveClaim();
    }
  }

  claimDrag(event, phase) {
    const offer = this.inspect(event.dataTransfer);
    if (!offer) return false;
    const native = nativeSummary(event.dataTransfer);
    const claim = this.findClaim(event, { offer, native });
    if (!claim) {
      this.clearActiveClaim();
      return false;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    this.setDropEffect(event.dataTransfer, claim.proposal.effect || offer.effect);
    this.transitionToClaim(claim);
    this.updateOverlay(claim.context, claim.proposal);
    const hook = phase === "enter" ? "onDragEnter" : "onDragOver";
    claim.target.adapter?.[hook]?.(claim.context);
    return true;
  }

  async handleDrop(event) {
    this.cancelPendingLeave();
    const offer = this.inspect(event.dataTransfer);
    if (!offer) return;
    // Descriptor data and native File objects must be snapshotted synchronously.
    const descriptor = this.read(event.dataTransfer);
    const native = nativeSummary(event.dataTransfer);
    const claim = this.findClaim(event, { offer, descriptor, native });
    if (!claim) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    this.setDropEffect(event.dataTransfer, claim.proposal.effect || offer.effect);
    this.transitionToClaim(claim);
    this.hideOverlay();

    const context = claim.context;
    context.descriptor = descriptor;
    context.dataTransfer = event.dataTransfer;
    try {
      let prepared;
      if (typeof claim.provider.prepareDrop === "function") {
        prepared = await claim.provider.prepareDrop(context);
      } else {
        prepared = descriptor;
      }
      if (prepared == null) throw new Error("The drop provider rejected the payload");
      if (prepared.allowSplit === false) context.candidateSplit = null;

      let result;
      if (typeof claim.provider.perform === "function") {
        result = await claim.provider.perform(context, prepared);
      } else {
        result = await claim.provider.drop({ ...context, prepared });
      }
      if (context.createdPane?.isAlive?.() && context.createdPane.getItems().length === 0) {
        context.createdPane.destroy();
      }
      claim.target.adapter?.onDropFinished?.({ ...context, result });
      this.clearActiveClaim();
      return result;
    } catch (error) {
      this.rollbackCreatedPane(context);
      if (descriptor?.token) {
        try {
          await this.rollback(descriptor.token, error.message);
        } catch (rollbackError) {
          console.error(rollbackError);
        }
      }
      try {
        claim.target.adapter?.onDropFinished?.({ ...context, error });
      } catch (cleanupError) {
        console.error(cleanupError);
      } finally {
        this.clearActiveClaim();
      }
      if (error.message !== "The drop provider rejected the payload") console.error(error);
    }
  }

  findClaim(event, payload) {
    for (const target of this.targetCandidates(event)) {
      const context = this.contextForTarget(event, target, payload);
      if (!context) continue;
      for (const { provider } of this.providers) {
        let proposal;
        if (typeof provider.propose === "function") proposal = provider.propose(context);
        else proposal = provider.canHandle(context.descriptor || context.offer, context);
        if (!proposal || typeof proposal.then === "function") continue;
        if (proposal === true) proposal = {};
        const locations =
          proposal.allowedLocations ||
          context.descriptor?.allowedLocations ||
          context.offer.allowedLocations;
        if (locations?.length && !locations.includes(context.location)) continue;
        if (target.adapter?.canDrop?.({ ...context, proposal, provider }) === false) continue;
        if (proposal.allowSplit === false) context.candidateSplit = null;
        return { target, provider, proposal, context };
      }
    }
    return null;
  }

  targetCandidates(event) {
    const path = event.composedPath?.() || this.eventPath(event.target);
    const candidates = this.targets
      .filter(
        (target) =>
          this.element.contains(target.element) &&
          (path.includes(target.element) || target.element.contains?.(event.target)),
      )
      .sort((a, b) => {
        const depth = path.indexOf(a.element) - path.indexOf(b.element);
        return depth || b.priority - a.priority || a.order - b.order;
      });
    const paneElement = path.find((element) => element?.matches?.("lumine-pane"));
    const paneFallbackAllowed =
      candidates.length === 0 || candidates.some((target) => target.adapter?.allowPaneFallback);
    if (paneElement && paneFallbackAllowed) {
      candidates.push({
        element: paneElement,
        adapter: { surface: "pane", showOverlay: true },
        priority: -Infinity,
        builtin: true,
      });
    }
    return candidates;
  }

  eventPath(element) {
    const path = [];
    for (let current = element; current; current = current.parentElement) path.push(current);
    return path;
  }

  contextForTarget(event, target, { offer, descriptor, native }) {
    let pane = target.adapter?.getPane?.(event) || paneForElement(target.element);
    if (!pane || pane.isDestroyed?.()) return null;
    const location = pane.getContainer?.()?.getLocation?.() || "center";
    const itemViews = pane.getElement().querySelector(":scope > .item-views");
    const dropElement = target.adapter?.dropElement || itemViews || target.element;
    const rect = dropElement.getBoundingClientRect();
    let candidateSplit = null;
    const sourceIsOnlyItemHere =
      offer.source?.onlyItem &&
      offer.source.windowId === this.windowService.getId() &&
      offer.source.paneId === pane.id;
    if (target.builtin && pane.getItems().length > 0 && !sourceIsOnlyItemHere) {
      candidateSplit = splitForPoint(rect, event.clientX, event.clientY);
    }
    let context = {
      manager: this,
      event,
      dataTransfer: event.dataTransfer,
      offer,
      descriptor,
      native,
      target,
      element: target.element,
      dropElement,
      pane,
      location,
      surface: target.adapter?.surface || "custom",
      index: pane.getActiveItemIndex() + 1,
      candidateSplit,
    };
    const additions =
      typeof target.adapter === "function"
        ? target.adapter(context)
        : target.adapter?.getContext?.(context);
    if (additions === false || additions === null) return null;
    if (additions) context = { ...context, ...additions };
    if (typeof target.adapter?.getIndex === "function") {
      context.index = target.adapter.getIndex(event, context);
    }
    context.resolvePane = ({ allowSplit = true, split = context.candidateSplit } = {}) => {
      if (context.resolvedPane) return context.resolvedPane;
      if (!allowSplit || !SPLITS.has(split)) return (context.resolvedPane = context.pane);
      const method = `split${split[0].toUpperCase()}${split.slice(1)}`;
      context.createdPane = context.pane[method]();
      return (context.resolvedPane = context.createdPane);
    };
    return context;
  }

  transitionToClaim(claim) {
    if (this.activeClaim?.target !== claim.target) {
      this.activeClaim?.target.adapter?.onDragLeave?.(this.activeClaim.context);
    }
    this.activeClaim = claim;
  }

  clearActiveClaim() {
    this.cancelPendingLeave();
    const claim = this.activeClaim;
    this.activeClaim = null;
    try {
      claim?.target.adapter?.onDragLeave?.(claim.context);
    } catch (error) {
      console.error(error);
    } finally {
      this.hideOverlay();
    }
  }

  cancelPendingLeave() {
    if (this.leaveFrame != null) cancelAnimationFrame(this.leaveFrame);
    this.leaveFrame = null;
  }

  updateOverlay(context, proposal) {
    if (!context.target.adapter?.showOverlay && !context.target.builtin) return this.hideOverlay();
    const split = proposal.allowSplit === false ? null : context.candidateSplit;
    const rect = context.dropElement.getBoundingClientRect();
    const bounds = boundsForSplit(rect, split);
    Object.assign(this.overlay.style, {
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    });
    this.overlay.classList.add("visible");
  }

  hideOverlay() {
    this.overlay?.classList.remove("visible");
  }

  setDropEffect(dataTransfer, effect) {
    if (!dataTransfer) return;
    dataTransfer.dropEffect = effect === "move" ? "move" : effect === "link" ? "link" : "copy";
  }

  rollbackCreatedPane(context) {
    const pane = context?.createdPane;
    if (pane?.isAlive?.() && pane.getItems().length === 0) pane.destroy();
  }
}

module.exports = WorkspaceDropManager;
module.exports.PROTOCOL_VERSION = PROTOCOL_VERSION;
module.exports.MIME_PREFIX = MIME_PREFIX;
module.exports.splitForPoint = splitForPoint;
module.exports.boundsForSplit = boundsForSplit;
