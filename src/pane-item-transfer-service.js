const { defaultLocationForItem, allowedLocationsForItem } = require("./pane-item-locations");
const { normalizeDescriptor } = require("./workspace-drop-protocol");
const { CompositeDisposable, Disposable } = require("@lumine-code/event-kit");
const { PaneItemOperationError, assertItemLocation } = require("./pane-item-contract");
const {
  awaitLifecycleCleanup,
  captureLifecycleError,
  throwLifecycleErrors,
} = require("./package-lifecycle-errors");

function cancelledError() {
  return Object.assign(new Error("The pane item transfer was cancelled"), { code: "ABORT_ERR" });
}

function itemURI(item) {
  return item.getURI?.() ?? (typeof item.getText === "function" ? "" : null);
}

/**
 * @public
 * @status extended
 *
 * Moves exact pane items locally and stages their content before committing a
 * move between windows. Scopes tie transfers to their caller's lifecycle.
 */
class PaneItemTransferService {
  constructor({ workspace, workspaceDrops, windowService, applicationDelegate }) {
    this.workspace = workspace;
    this.workspaceDrops = workspaceDrops;
    this.windowService = windowService;
    this.applicationDelegate = applicationDelegate;
    this.scopes = new Set();
    this.operations = new Set();
  }

  /**
   * @public
   * @status extended
   *
   * Own a group of source sessions and destination operations.
   *
   * @returns {PaneItemTransferScope} Dispose the scope when its caller unloads.
   */
  createScope() {
    if (this.destroyed) throw cancelledError();
    const scope = new PaneItemTransferScope(this);
    this.scopes.add(scope);
    return scope;
  }

  cancelAll() {
    for (const operation of this.operations) operation.controller.abort();
    for (const scope of [...this.scopes]) scope.dispose();
  }

  assertLocalItem(item, sourcePane) {
    if (this.destroyed || !this.workspace.isAlive()) throw cancelledError();
    if (
      !sourcePane ||
      sourcePane.isDestroyed() ||
      item?.isDestroyed?.() ||
      item?.destroyed === true ||
      this.workspace.paneForItem(item) !== sourcePane
    ) {
      throw new PaneItemOperationError(
        "ITEM_UNAVAILABLE",
        "The source pane item is no longer available.",
      );
    }
  }

  prepareDestination(item, sourcePane, options) {
    const { targetPane, splitDirection } = options;
    if (targetPane && splitDirection) {
      throw new PaneItemOperationError(
        "INVALID_DESTINATION",
        "Choose a destination pane or a split direction.",
      );
    }
    if (splitDirection && !["up", "down", "left", "right"].includes(splitDirection)) {
      throw new PaneItemOperationError(
        "INVALID_DIRECTION",
        "The pane direction must be up, down, left or right.",
      );
    }
    const anchor = targetPane || (splitDirection ? sourcePane : null);
    if (!anchor || anchor.isDestroyed() || !this.workspace.getPanes().includes(anchor)) {
      throw new PaneItemOperationError(
        "PANE_UNAVAILABLE",
        "The destination pane is no longer available.",
      );
    }
    assertItemLocation(item, anchor.getContainer().getLocation());
    return anchor;
  }

  movePaneItem(item, options = {}) {
    const sourcePane = options.sourcePane || this.workspace.paneForItem(item);
    this.assertLocalItem(item, sourcePane);
    const anchor = this.prepareDestination(item, sourcePane, options);
    const sourceWindow = sourcePane.getContainer().getWindow();
    const targetWindow = anchor.getContainer().getWindow();
    if (sourceWindow && targetWindow && sourceWindow !== targetWindow) {
      if (!targetWindow.isMain() && anchor.getContainer().getLocation() !== "center")
        throw new PaneItemOperationError("DOCK_WINDOW", "Dock items belong to the main window.");
      return this.workspace.runWindowOperation([sourceWindow, targetWindow], () =>
        this.moveBetweenPresentations(
          item,
          sourcePane,
          anchor,
          { ...options },
          { sourceWindow, targetWindow },
        ),
      );
    }
    return this.commitLocalMove(item, sourcePane, anchor, options);
  }

  commitLocalMove(item, sourcePane, anchor, options, privileged = false) {
    const commit = () =>
      sourcePane.transactActiveState(() => {
        const pane = options.splitDirection
          ? anchor[
              `split${options.splitDirection[0].toUpperCase()}${options.splitDirection.slice(1)}`
            ]({ activate: false })
          : anchor;
        if (pane === sourcePane) {
          if (Number.isInteger(options.index)) sourcePane.moveItem(item, options.index);
        } else {
          sourcePane.moveItemToPane(item, pane, options.index, {
            preserveSourcePane:
              options.preserveSourcePane ||
              (!!options.splitDirection && sourcePane.getContainer().getLocation() === "center"),
          });
        }
        if (sourcePane.getPendingItem() === item) sourcePane.clearPendingItem();
        item.terminatePendingState?.();
        pane.activateItem(item, { activatePane: options.activatePane !== false });
        return { pane, item };
      });
    return privileged ? this.workspace.runWindowMutation(commit) : commit();
  }

  async moveBetweenPresentations(item, source, target, options, context) {
    const sourceIndex = source.getItems().indexOf(item);
    const sourceActiveItem = source.getActiveItem();
    const targetActiveItem = target.getActiveItem();
    this.workspace.viewRegistry.getView(item);
    const state = await this.workspace.viewRegistry.preparePaneItemWindowChange(item, context);
    let moved = false;
    let result;
    const failures = [];
    try {
      this.assertLocalItem(item, source);
      this.prepareDestination(item, source, options);
      if (
        context.sourceWindow.isDestroyed() ||
        context.targetWindow.isDestroyed() ||
        context.targetWindow.windowService.closed ||
        source.getContainer().getWindow() !== context.sourceWindow ||
        target.getContainer().getWindow() !== context.targetWindow
      )
        throw cancelledError();
      result = this.commitLocalMove(
        item,
        source,
        target,
        {
          ...options,
          preserveSourcePane: true,
        },
        true,
      );
      moved = true;
      await state.didChange(context);
      if (context.targetWindow.windowService.closed) throw cancelledError();
      if (
        source.isAlive() &&
        source.getItems().length === 0 &&
        source.getContainer().shouldDestroyEmptyPanes()
      )
        this.workspace.runWindowMutation(() => source.destroy());
    } catch (error) {
      failures.push(error);
      if (moved && source.isAlive() && target.getItems().includes(item)) {
        captureLifecycleError(failures, () =>
          this.workspace.runWindowMutation(() =>
            source.transactActiveState(() => {
              target.moveItemToPane(item, source, sourceIndex, { preserveSourcePane: true });
              if (sourceActiveItem && source.getItems().includes(sourceActiveItem))
                source.activateItem(sourceActiveItem);
              if (targetActiveItem && target.getItems().includes(targetActiveItem))
                target.activateItem(targetActiveItem, { activatePane: false });
            }),
          ),
        );
        await awaitLifecycleCleanup(failures, () =>
          state.didChange({
            sourceWindow: context.targetWindow,
            targetWindow: context.sourceWindow,
            rollback: true,
          }),
        );
      } else if (!moved) await awaitLifecycleCleanup(failures, () => state.cancel());
    } finally {
      captureLifecycleError(failures, () => {
        if (typeof state?.dispose === "function") state.dispose();
      });
    }
    throwLifecycleErrors(failures, "Unable to move the presentation and release its view state.");
    return result;
  }

  hasIndependentCopyView(copy, source) {
    const root = this.workspace.viewRegistry.getView(copy);
    if (!root || root.nodeType !== 1 || !root.ownerDocument || root.isConnected || root.parentNode)
      return false;
    const items = new Set([source, ...this.workspace.getPaneItems()]);
    for (const item of items) {
      if (item === copy) continue;
      const liveRoot = this.workspace.viewRegistry.getView(item);
      if (root === liveRoot || root.contains(liveRoot) || liveRoot?.contains(root)) return false;
    }
    return true;
  }

  async disposeUnpresentedCopy(copy, source) {
    if (
      !copy ||
      typeof copy !== "object" ||
      copy === source ||
      copy.isDestroyed?.() ||
      copy.destroyed === true ||
      this.workspace.paneForItem(copy)
    )
      return;
    if (this.hasIndependentCopyView(copy, source)) await copy.destroy?.();
  }

  async copyPaneItem(item, options = {}) {
    if (
      item &&
      typeof item === "object" &&
      (typeof item.copy !== "function" || item.canCopy?.() === false)
    )
      return null;
    options = { ...options };
    const sourcePane = options.sourcePane || this.workspace.paneForItem(item);
    this.assertLocalItem(item, sourcePane);
    const anchor = this.prepareDestination(item, sourcePane, options);
    const controller = new AbortController();
    const operation = { controller };
    this.operations.add(operation);
    const subscriptions = new CompositeDisposable();
    const abort = () => controller.abort();
    const observe = (object, name, callback = abort) => {
      if (typeof object[name] === "function") subscriptions.add(object[name](callback));
    };
    observe(item, "onDidDestroy");
    observe(item, "onDidChangeURI");
    observe(item, "onDidChangePath");
    observe(sourcePane, "onWillDestroy");
    observe(sourcePane, "onDidRemoveItem", ({ item: removed }) => {
      if (removed === item) abort();
    });
    if (anchor !== sourcePane) observe(anchor, "onWillDestroy");
    if (options.signal) {
      if (options.signal.aborted) abort();
      options.signal.addEventListener("abort", abort, { once: true });
      subscriptions.add(new Disposable(() => options.signal.removeEventListener("abort", abort)));
    }
    const uri = itemURI(item);
    const revision = item.getPaneItemRevision?.();
    const copyMethod = item.copy;
    let contextUnchanged = true;
    observe(this.workspace, "onDidChangeActivePane", () => {
      contextUnchanged = false;
    });
    observe(this.workspace, "onDidChangeActivePaneItem", () => {
      contextUnchanged = false;
    });
    const origin = sourcePane.element;
    const document =
      origin?.ownerDocument ??
      sourcePane.getContainer().getWindow()?.getDocument() ??
      globalThis.document;
    let focusOrigin = document.activeElement;
    const focusChanged = (event) => {
      if (focusOrigin === document.body && origin?.contains(event.target))
        focusOrigin = event.target;
      else if (event.target !== focusOrigin) contextUnchanged = false;
    };
    document.addEventListener("focusin", focusChanged, true);
    subscriptions.add(
      new Disposable(() => document.removeEventListener("focusin", focusChanged, true)),
    );
    let copy;
    let committed = false;
    try {
      if (controller.signal.aborted) throw cancelledError();
      const pendingCopy = Promise.resolve(copyMethod.call(item, { signal: controller.signal }));
      copy = await new Promise((resolve, reject) => {
        const cancel = () => reject(cancelledError());
        if (controller.signal.aborted) cancel();
        else controller.signal.addEventListener("abort", cancel, { once: true });
        pendingCopy.then(
          (result) => {
            controller.signal.removeEventListener("abort", cancel);
            if (controller.signal.aborted) {
              // A provider may finish after cancellation despite receiving a signal.
              // Never dispose a returned source, mounted item or shared view root.
              void this.disposeUnpresentedCopy(result, item).catch((error) => console.error(error));
              reject(cancelledError());
            } else resolve(result);
          },
          (error) => {
            controller.signal.removeEventListener("abort", cancel);
            reject(error);
          },
        );
      });
      if (
        controller.signal.aborted ||
        itemURI(item) !== uri ||
        item.copy !== copyMethod ||
        item.getPaneItemRevision?.() !== revision
      )
        throw cancelledError();
      this.assertLocalItem(item, sourcePane);
      this.prepareDestination(item, sourcePane, options);
      if (
        !copy ||
        typeof copy !== "object" ||
        copy === item ||
        copy.isDestroyed?.() ||
        copy.destroyed === true ||
        this.workspace.paneForItem(copy)
      ) {
        throw new PaneItemOperationError(
          "INVALID_COPY",
          "copy({signal}) must return a fresh, live pane item.",
        );
      }
      assertItemLocation(copy, anchor.getContainer().getLocation());
      if (!this.hasIndependentCopyView(copy, item)) {
        throw new PaneItemOperationError(
          "INVALID_COPY_VIEW",
          "A copied pane item must have its own detached view root.",
        );
      }
      if (controller.signal.aborted) throw cancelledError();
      return sourcePane.transactActiveState(() => {
        const pane = options.splitDirection
          ? anchor[
              `split${options.splitDirection[0].toUpperCase()}${options.splitDirection.slice(1)}`
            ]({ items: [copy], activate: false })
          : anchor;
        if (!options.splitDirection) pane.addItem(copy, { index: options.index, copied: true });
        // Promotion can abort a provider's pending navigation. The copy has
        // committed, so its source observers must no longer cancel this work.
        subscriptions.dispose();
        if (sourcePane.getPendingItem() === item) sourcePane.clearPendingItem();
        item.terminatePendingState?.();
        copy.terminatePendingState?.();
        if (contextUnchanged || this.workspace.getActivePane() !== pane) {
          pane.activateItem(copy, {
            activatePane: contextUnchanged && options.activatePane !== false,
          });
        }
        committed = true;
        return { pane, item: copy };
      });
    } finally {
      subscriptions.dispose();
      this.operations.delete(operation);
      if (!committed) await this.disposeUnpresentedCopy(copy, item);
    }
  }

  destroy() {
    this.destroyed = true;
    this.cancelAll();
  }

  async acceptInitialTransfer(descriptor) {
    const scope = this.createScope();
    try {
      const location = descriptor.defaultLocation || descriptor.allowedLocations?.[0] || "center";
      const container = this.workspace
        .getPaneContainers()
        .find((candidate) => candidate.getLocation() === location);
      const pane = container?.getActivePane();
      const prepared = scope.prepareDrop(descriptor, pane);
      if (!pane || !prepared) throw new Error("The new window cannot accept this pane item");
      return await scope.performDrop(
        { pane, surface: "new-window", resolvePane: () => pane },
        prepared,
      );
    } catch (error) {
      await this.workspaceDrops.rollback(descriptor.token, error.message, {
        sourceWindowId: descriptor.source?.windowId,
      });
      throw error;
    } finally {
      scope.dispose();
    }
  }
}

/**
 * @public
 * @status extended
 *
 * A disposable group of transfers owned by a package or core operation.
 */
class PaneItemTransferScope {
  constructor(service) {
    this.service = service;
    this.sessions = new Map();
    this.disposed = false;
  }

  assertAvailable() {
    if (this.disposed || this.service.destroyed) throw cancelledError();
  }

  /**
   * @public
   * @status extended
   *
   * Capture a pane item and retain its exact source identity until settlement.
   *
   * @param pane - The pane containing the item.
   * @param item - The exact item to move.
   * @returns {Object} A serializable workspace drag descriptor.
   */
  createTransfer(pane, item) {
    this.assertAvailable();
    if (this.service.workspace.paneForItem(item) !== pane) {
      throw new Error("The pane item is no longer available");
    }
    const uri = itemURI(item);
    const text = typeof item.getText === "function" ? item.getText() : undefined;
    const fileState = item.getFileState?.() ?? "unmodified";
    const textEditorState = item.serializeViewState?.();
    const record = { scope: this, pane, item, uri, text, fileState };
    record.completion = new Promise((resolve) => {
      record.settle = resolve;
    });
    const { token } = this.service.workspaceDrops.createSession(record, {
      commit: () => this.commitSource(record),
      rollback: () => this.finish(record, false),
    });
    record.token = token;
    this.sessions.set(token, record);
    return normalizeDescriptor({
      kind: "pane-item",
      token,
      effect: "move",
      defaultLocation: defaultLocationForItem(item),
      allowedLocations: allowedLocationsForItem(item),
      source: {
        windowId: this.service.windowService.getId(),
        paneId: pane.id,
        onlyItem: pane.getItems().length === 1,
      },
      items: [
        {
          type: "pane-item",
          uri,
          fileState,
          ...(fileState !== "unmodified" && text !== undefined ? { modifiedText: text } : {}),
          ...(textEditorState == null ? {} : { textEditorState }),
        },
      ],
    });
  }

  sourceIsCurrent(record, { checkContent = true } = {}) {
    return (
      !this.disposed &&
      !this.service.destroyed &&
      this.sessions.get(record.token) === record &&
      this.service.workspace.paneForItem(record.item) != null &&
      itemURI(record.item) === record.uri &&
      (!checkContent ||
        ((record.text === undefined || record.item.getText() === record.text) &&
          (record.item.getFileState?.() ?? "unmodified") === record.fileState))
    );
  }

  async commitSource(record) {
    try {
      if (!this.sourceIsCurrent(record)) return this.finish(record, false);
      const pane = this.service.workspace.paneForItem(record.item);
      const accepted = await pane.destroyItem(record.item, true, {
        canDestroy: () => this.sourceIsCurrent(record),
      });
      return this.finish(record, accepted === true);
    } catch (error) {
      this.finish(record, false);
      throw error;
    }
  }

  finish(record, accepted) {
    this.sessions.delete(record.token);
    record.settle(accepted);
    return accepted;
  }

  /**
   * @public
   * @status extended
   *
   * Abandon a retained source session without destroying its item.
   */
  release(token, reason = "transfer abandoned") {
    const record = this.sessions.get(token);
    if (!record) return false;
    this.finish(record, false);
    void this.service.workspaceDrops.rollback(token, reason).catch((error) => console.error(error));
    return true;
  }

  /**
   * @public
   * @status extended
   *
   * Validate a complete descriptor before resolving or creating a destination.
   *
   * @returns {Object|null} Prepared transfer state, or null for an unsupported payload.
   */
  prepareDrop(descriptor, pane) {
    this.assertAvailable();
    if (
      descriptor?.kind !== "pane-item" ||
      typeof descriptor.token !== "string" ||
      !descriptor.token ||
      !Number.isInteger(descriptor.source?.windowId) ||
      !Array.isArray(descriptor.items) ||
      descriptor.items.length !== 1 ||
      descriptor.items[0]?.type !== "pane-item"
    ) {
      return null;
    }
    const sameWindow = descriptor.source.windowId === this.service.windowService.getId();
    const session = sameWindow ? this.service.workspaceDrops.getSession(descriptor.token) : null;
    const transferItem = descriptor.items[0];
    if (
      sameWindow &&
      (!session?.item || !session.scope.sourceIsCurrent(session, { checkContent: false }))
    )
      return null;
    if (!sameWindow && typeof transferItem.uri !== "string") return null;
    if (
      !sameWindow &&
      transferItem.fileState !== "unmodified" &&
      transferItem.fileState != null &&
      typeof transferItem.modifiedText !== "string"
    ) {
      return null;
    }
    return {
      descriptor,
      transferItem,
      sourceWindowId: descriptor.source.windowId,
      sameWindow,
      session,
      allowSplit: !(
        descriptor.source.onlyItem &&
        sameWindow &&
        descriptor.source.paneId === pane?.id
      ),
    };
  }

  /**
   * @public
   * @status extended
   *
   * Complete a prepared drop, staging remote content before source commit.
   *
   * @returns {Promise<Object>} The destination pane and item.
   */
  async performDrop(context, prepared) {
    this.assertAvailable();
    try {
      if (prepared.sameWindow) return this.moveLocalItem(context, prepared);
      return await this.openRemoteItem(context, prepared);
    } catch (error) {
      await this.service.workspaceDrops.rollback(prepared.descriptor.token, error.message, {
        sourceWindowId: prepared.sourceWindowId,
      });
      throw error;
    }
  }

  assertLocation(pane, descriptor) {
    if (!pane || pane.isDestroyed()) throw new Error("The destination pane is no longer available");
    const location = pane.getContainer()?.getLocation() || "center";
    if (!descriptor.allowedLocations?.includes(location)) {
      throw new Error(`This pane item cannot be moved to the ${location} dock`);
    }
  }

  moveLocalItem(context, prepared) {
    const { descriptor, session } = prepared;
    if (!session.scope.sourceIsCurrent(session, { checkContent: false }))
      throw new Error("The dragged pane item is no longer available");
    const { item } = session;
    const sourcePane = this.service.workspace.paneForItem(item);
    if (context.surface === "pane" && sourcePane === context.pane && !context.candidateSplit) {
      session.scope.release(descriptor.token, "item dropped on its current pane");
      return { pane: sourcePane, item };
    }
    return sourcePane.transactActiveState(() => {
      const targetPane = context.resolvePane({ allowSplit: prepared.allowSplit });
      this.assertLocation(targetPane, descriptor);
      this.moveItem(sourcePane, targetPane, item, context.index);
      targetPane.activateItem(item, { activatePane: true });
      session.scope.release(descriptor.token, "item moved within its source window");
      return { pane: targetPane, item };
    });
  }

  assertNoCollision(uri, items) {
    if (!uri) return;
    if (
      items.some(
        (item) =>
          itemURI(item) === uri &&
          item.getFileState?.() !== "unmodified" &&
          item.getFileState?.() != null,
      )
    ) {
      throw new Error("The target window already has unsaved changes for this file");
    }
  }

  async openRemoteItem(context, prepared) {
    const { workspace, workspaceDrops, windowService } = this.service;
    const { descriptor, sourceWindowId, transferItem } = prepared;
    const itemsBeforeOpen = new Set(workspace.getPaneItems());
    this.assertNoCollision(transferItem.uri, [...itemsBeforeOpen]);
    // Reopening an existing item emits opener hooks before its Promise resolves.
    // Retain the destination's view state before those hooks can change it.
    const viewStatesBeforeOpen = new Map(
      [...itemsBeforeOpen]
        .filter((candidate) => typeof candidate.serializeViewState === "function")
        .map((candidate) => [candidate, candidate.serializeViewState()]),
    );
    const targetPane = context.resolvePane({ allowSplit: prepared.allowSplit });
    this.assertLocation(targetPane, descriptor);
    const item = await workspace.open(transferItem.uri, {
      pane: targetPane,
      activateItem: false,
      activatePane: false,
      pending: false,
      transferred: true,
    });
    if (!item) throw new Error("The target window could not open the dragged pane item");
    const openedPane = workspace.paneForItem(item);
    if (!openedPane) throw new Error("The opened pane item has no owning pane");
    const existedBeforeOpen = itemsBeforeOpen.has(item);
    const sharedBufferItem =
      !existedBeforeOpen && typeof item.getBuffer === "function"
        ? [...itemsBeforeOpen].find((candidate) => candidate.getBuffer?.() === item.getBuffer())
        : null;
    const original = {
      existedBeforeOpen,
      pane: openedPane,
      index: openedPane.getItems().indexOf(item),
      activeItem: openedPane.getActiveItem(),
      text:
        (existedBeforeOpen || sharedBufferItem) && typeof item.getText === "function"
          ? item.getText()
          : undefined,
      viewState: existedBeforeOpen ? viewStatesBeforeOpen.get(item) : undefined,
      sharedViewStates:
        typeof item.getBuffer === "function"
          ? [...itemsBeforeOpen]
              .filter(
                (candidate) =>
                  candidate !== item &&
                  candidate.getBuffer?.() === item.getBuffer() &&
                  typeof candidate.serializeViewState === "function",
              )
              .map((candidate) => ({ item: candidate, state: viewStatesBeforeOpen.get(candidate) }))
          : [],
    };
    let committed = false;
    let stagedText = item.getText?.();
    try {
      this.assertAvailable();
      this.assertLocation(targetPane, descriptor);
      this.assertNoCollision(transferItem.uri, workspace.getPaneItems());
      if (Object.hasOwn(transferItem, "modifiedText") && typeof item.setText !== "function") {
        throw new Error("The target item cannot restore the transferred content");
      }
      if (transferItem.textEditorState && typeof item.restoreViewState !== "function") {
        throw new Error("The target item cannot restore the transferred view state");
      }
      this.moveItem(openedPane, targetPane, item, context.index);
      if (Object.hasOwn(transferItem, "modifiedText")) {
        if (original.text !== undefined) {
          original.buffer = item.getBuffer?.();
          original.checkpoint = original.buffer?.createCheckpoint();
        }
        item.setText(transferItem.modifiedText);
      }
      if (transferItem.textEditorState) item.restoreViewState(transferItem.textEditorState);
      stagedText = item.getText?.();
      original.stagedViewState = item.serializeViewState?.();
      for (const entry of original.sharedViewStates) entry.staged = entry.item.serializeViewState();
      this.assertAvailable();
      this.assertLocation(targetPane, descriptor);
      if (workspace.paneForItem(item) !== targetPane || item.isDestroyed?.()) {
        throw new Error("The staged pane item is no longer available");
      }
      // After sending commit, cancellation must retain the staged destination
      // until acknowledgement: the source may already have removed its copy.
      committed = await workspaceDrops.commit(descriptor.token, { sourceWindowId });
      if (!committed) throw new Error("The source window rejected the pane item transfer");
    } catch (error) {
      if (!committed) await this.restoreRemoteItem(item, original, stagedText);
      throw error;
    }
    if (!this.disposed && !this.service.destroyed) {
      try {
        targetPane.activateItem(item, { activatePane: true });
        await windowService.focus();
      } catch (error) {
        // A committed item is the surviving copy even if focus fails.
        console.error(error);
      }
    }
    return { pane: targetPane, item };
  }

  async restoreRemoteItem(item, original, stagedText) {
    const { workspace } = this.service;
    const currentPane = workspace.paneForItem(item);
    if (!original.existedBeforeOpen) {
      // Edits made after staging belong to the target user, even on failure.
      if (stagedText === undefined || item.getText?.() === stagedText) {
        if (original.text !== undefined) this.restoreText(item, original);
        await currentPane?.destroyItem(item, true);
      }
      return;
    }
    if (currentPane && currentPane !== original.pane && !original.pane.isDestroyed()) {
      currentPane.moveItemToPane(item, original.pane, original.index);
    } else if (currentPane === original.pane) {
      original.pane.moveItem(item, original.index);
    }
    if (
      original.text !== undefined &&
      (stagedText === undefined || item.getText() === stagedText)
    ) {
      this.restoreText(item, original);
    }
    if (original.activeItem && original.pane.getItems().includes(original.activeItem)) {
      original.pane.activateItem(original.activeItem);
    }
  }

  restoreText(item, original) {
    // Compare before restoring text: replacing a shared buffer itself moves
    // selection markers in every editor that displays it.
    const snapshots = new Map(original.sharedViewStates.map((entry) => [entry.item, entry]));
    if (original.viewState) {
      snapshots.set(item, { state: original.viewState, staged: original.stagedViewState });
    }
    const sharedItems = original.buffer
      ? this.service.workspace
          .getPaneItems()
          .filter((candidate) => candidate.getBuffer?.() === original.buffer)
      : [item];
    const viewStates = sharedItems.flatMap((candidate) => {
      if (candidate.isDestroyed?.() || typeof candidate.serializeViewState !== "function")
        return [];
      const current = candidate.serializeViewState();
      const captured = snapshots.get(candidate);
      let state = current;
      if (captured) {
        if (!captured.staged) {
          state = captured.state;
        } else {
          state = { ...current };
          // Layout can add or normalize the anchor while the cursor stays put.
          // Compare the user's selection and logical viewport independently.
          if (JSON.stringify(current.selections) === JSON.stringify(captured.staged.selections)) {
            state.selections = captured.state.selections;
          }
          if (current.scrollTopRow === captured.staged.scrollTopRow) {
            state.scrollTopRow = captured.state.scrollTopRow;
            if (captured.state.scrollAnchor) state.scrollAnchor = captured.state.scrollAnchor;
            else delete state.scrollAnchor;
          }
          if (current.scrollLeftColumn === captured.staged.scrollLeftColumn) {
            state.scrollLeftColumn = captured.state.scrollLeftColumn;
          }
        }
      }
      return [{ item: candidate, state }];
    });
    if (original.checkpoint == null || !original.buffer.revertToCheckpoint(original.checkpoint)) {
      item.setText(original.text);
    }
    for (const entry of viewStates) entry.item.restoreViewState(entry.state);
  }

  moveItem(sourcePane, targetPane, item, index) {
    const sourceIndex = sourcePane.getItems().indexOf(item);
    if (sourceIndex < 0) throw new Error("The dragged pane item is no longer available");
    let targetIndex = Number.isInteger(index)
      ? index
      : Math.max(0, targetPane.getActiveItemIndex() + 1);
    if (sourcePane === targetPane) {
      if (sourceIndex < targetIndex) targetIndex--;
      targetIndex = Math.max(0, Math.min(targetIndex, targetPane.getItems().length - 1));
      if (sourceIndex !== targetIndex) targetPane.moveItem(item, targetIndex);
    } else {
      targetIndex = Math.max(0, Math.min(targetIndex, targetPane.getItems().length));
      this.service.movePaneItem(item, {
        sourcePane,
        targetPane,
        index: targetIndex,
        activatePane: false,
      });
    }
  }

  /**
   * @public
   * @status extended
   *
   * Move an item into a freshly opened window using the same staged transfer.
   * The source remains intact until the destination acknowledges its content.
   *
   * @returns {Promise<Object>} The destination window id after source commit.
   */
  async openInNewWindow(pane, item) {
    const descriptor = this.createTransfer(pane, item);
    const record = this.sessions.get(descriptor.token);
    try {
      if (typeof descriptor.items[0].uri !== "string") {
        throw new Error("This pane item cannot be moved to a new window");
      }
      const windowId = await this.service.applicationDelegate.invokeApp(
        "openPaneItemInNewWindow",
        descriptor,
      );
      if (!(await record.completion)) {
        this.assertAvailable();
        throw new Error("The new window did not accept the pane item transfer");
      }
      return { windowId };
    } catch (error) {
      this.release(descriptor.token, error.message);
      throw error;
    }
  }

  /**
   * @public
   * @status extended
   *
   * Cancel outstanding source sessions and prevent destination work from committing.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const token of [...this.sessions.keys()]) this.release(token, "transfer scope disposed");
    this.service.scopes.delete(this);
  }
}

module.exports = PaneItemTransferService;
