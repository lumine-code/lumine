const { Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const { nativeSummary } = require("./workspace-drop-protocol");
const { SPLITS, splitForPoint, boundsForSplit } = require("./workspace-drop-geometry");
function paneForElement(element) {
  return element?.closest?.("lumine-pane")?.getModel?.() ?? null;
}
// A physical document owns its drag preview and capture listeners. Source
// sessions, provider contracts and commit acknowledgements stay in the workspace.
module.exports = class WorkspaceDropSurface {
  constructor(manager, element) {
    this.manager = manager;
    this.domSubscriptions = new CompositeDisposable();
    this.activeClaim = null;
    this.leaveFrame = null;

    this.element = element;
    const document = this.element.ownerDocument;
    const window = document.defaultView;
    this.window = window;
    this.overlay = document.createElement("div");
    this.overlay.className = "workspace-drop-overlay";
    this.overlay.setAttribute("popover", "manual");
    this.overlay.setAttribute("aria-hidden", "true");
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
    this.disposed = true;
    this.clearActiveClaim();
    this.domSubscriptions.dispose();
    this.overlay?.remove();
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
      this.leaveFrame = this.window.requestAnimationFrame(() => {
        this.leaveFrame = null;
        this.clearActiveClaim();
      });
    } else {
      this.clearActiveClaim();
    }
  }

  claimDrag(event, phase) {
    const offer = this.manager.inspect(event.dataTransfer);
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
    const offer = this.manager.inspect(event.dataTransfer);
    if (!offer) return;
    // Descriptor data and native File objects must be snapshotted synchronously.
    const descriptor = this.manager.read(event.dataTransfer);
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
      if (this.disposed || context.pane.isDestroyed())
        throw Object.assign(new Error("The destination editor window has closed."), {
          code: "ABORT_ERR",
        });
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
          await this.manager.rollback(descriptor.token, error.message);
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
      for (const { provider } of this.manager.providers) {
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
    const candidates = this.manager.targets
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
      offer.source.windowId === this.manager.windowService.getId() &&
      offer.source.paneId === pane.id;
    if (target.builtin && pane.getItems().length > 0 && !sourceIsOnlyItemHere) {
      candidateSplit = splitForPoint(rect, event.clientX, event.clientY);
    }
    let context = {
      manager: this.manager,
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
      context.createdPane = context.pane[method]({ activate: false });
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
    if (this.leaveFrame != null) this.window.cancelAnimationFrame(this.leaveFrame);
    this.leaveFrame = null;
  }

  updateOverlay(context, proposal) {
    if (
      proposal.showOverlay === false ||
      (!context.target.adapter?.showOverlay && !context.target.builtin)
    ) {
      return this.hideOverlay();
    }
    const split = proposal.allowSplit === false ? null : context.candidateSplit;
    const rect = context.dropElement.getBoundingClientRect();
    const bounds = boundsForSplit(rect, split);
    // Move a fixed-size, text-free rectangle instead of laying out and painting
    // a new box for every preview. Keep fractional pane bounds intact.
    const transform = `translate(${bounds.left}px, ${bounds.top}px) scale(${bounds.width}, ${bounds.height})`;
    if (this.overlay.style.transform !== transform) this.overlay.style.transform = transform;
    // The top layer keeps the preview above every pane item's own stacking
    // contexts and makes these viewport bounds independent of containment.
    if (this.overlay.isConnected && !this.overlay.matches(":popover-open")) {
      this.overlay.showPopover();
    }
    this.overlay.classList.add("visible");
  }

  hideOverlay() {
    this.overlay?.classList.remove("visible");
    if (this.overlay?.matches(":popover-open")) this.overlay.hidePopover();
  }

  setDropEffect(dataTransfer, effect) {
    if (!dataTransfer) return;
    dataTransfer.dropEffect = effect === "move" ? "move" : effect === "link" ? "link" : "copy";
  }

  rollbackCreatedPane(context) {
    const pane = context?.createdPane;
    if (pane?.isAlive?.() && pane.getItems().length === 0) pane.destroy();
  }
};
