const { Emitter, CompositeDisposable } = require("event-kit");

// Keeps the window's modal breadcrumb trail and renders it as a strip anchored
// above the modal card. A modal joins the flow by announcing itself —
// `panel.show({crumb: "Label"})` — and whatever modal is visible at that
// moment becomes the previous trail entry, adopted as the root when the trail
// is empty.
//
// The keeper never owns a panel: it hides and shows panels through their own
// methods and otherwise just follows their visibility. That single invariant —
// the trail is alive only while its top panel is visible — tears the trail
// down on Escape, focus loss, confirm, destroy, or another modal taking over,
// without any cooperation from the panel's owner. Every keeper-driven hide is
// marked on the panel (`flowTransition`) so owners that treat an unrequested
// hide as a cancel can tell a step change apart from a dismissal.
module.exports = class ModalFlow {
  constructor(workspace) {
    this.workspace = workspace;
    this.emitter = new Emitter();
    this.stack = [];
    this.transitioning = false;
    this.subscriptions = null;
    this.strip = null;
    this.positionStrip = this.positionStrip.bind(this);
  }

  // A modal panel asked to be displayed as a flow step. Called by Panel::show
  // when it is given a crumb; `label` is already resolved against the panel's
  // declared crumb.
  showStep(panel, label) {
    if (this.transitioning) {
      // A step opened from inside another transition: the bookkeeping can no
      // longer be trusted, so degrade to a fresh single-entry trail. The panel
      // container hides whatever else is visible, with regular cancel
      // semantics — that modal really is being taken over.
      this.stack = [{ panel, label: this.labelFor(panel, label) }];
      panel.show();
      this.ensureSubscriptions();
      this.didChange();
      return;
    }

    const visible = this.visibleModalPanel();

    // Trail out of sync with reality (its top is not what is on screen):
    // never chain onto the wrong parent — start over.
    if (this.stack.length > 0 && this.stack[this.stack.length - 1].panel !== visible) {
      this.clear();
    }

    // Adopt the modal that is currently on screen as the trail root.
    if (this.stack.length === 0 && visible && visible !== panel) {
      this.stack.push({ panel: visible, label: this.labelFor(visible) });
    }

    const top = this.stack[this.stack.length - 1];
    if (top && top.panel === panel) {
      // Already the current step; nothing to chain.
      panel.show();
      this.didChange();
      return;
    }

    this.transitioning = true;
    try {
      if (top && top.panel.isVisible()) {
        top.panel.flowTransition = true;
        try {
          top.panel.hide();
        } finally {
          top.panel.flowTransition = false;
        }
      }
      this.stack.push({ panel, label: this.labelFor(panel, label) });
      panel.show();
      // Only a switch between two panels settles the appear animation; a step
      // that opens with nothing on screen is a fresh appearance and keeps it.
      if (top) this.settleAnimations(panel);
    } finally {
      this.transitioning = false;
    }
    this.ensureSubscriptions();
    this.didChange();
  }

  // Back one step: hide the top as a flow transition and re-show the previous
  // panel. Returns whether a step was popped.
  pop() {
    return this.popTo(this.stack.length - 2);
  }

  // Jump back to the step at `index` (crumb click). Returns whether anything
  // changed.
  popTo(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.stack.length - 1) {
      return false;
    }
    this.transitioning = true;
    try {
      const { panel } = this.stack[this.stack.length - 1];
      if (panel.isVisible()) {
        panel.flowTransition = true;
        try {
          panel.hide();
        } finally {
          panel.flowTransition = false;
        }
      }
      this.stack.length = index + 1;
      const previous = this.stack[this.stack.length - 1].panel;
      previous.show();
      this.settleAnimations(previous);
    } finally {
      this.transitioning = false;
    }
    this.didChange();
    return true;
  }

  // Trail labels, root first.
  getTrail() {
    return this.stack.map(({ label }) => label);
  }

  onDidChangeTrail(callback) {
    return this.emitter.on("did-change-trail", callback);
  }

  // The one lifecycle rule: outside a keeper-driven transition, the trail is
  // alive only while its top panel is visible. Everything else — parents —
  // is hidden already, so clearing is the whole cleanup.
  checkTrail() {
    if (this.transitioning || this.stack.length === 0) return;
    if (!this.stack[this.stack.length - 1].panel.isVisible()) this.clear();
  }

  // A destroyed panel anywhere in the stack invalidates the trail: a hidden
  // parent emits no visibility event on destroy, and popping back to it would
  // show a dead panel.
  panelDestroyed(panel) {
    if (this.stack.some((entry) => entry.panel === panel)) this.clear();
  }

  clear() {
    if (this.stack.length === 0) return;
    this.stack = [];
    if (this.subscriptions) {
      this.subscriptions.dispose();
      this.subscriptions = null;
    }
    this.didChange();
  }

  // A step change swaps one panel for another while the modal surface
  // visually persists, so the theme's appear animation must not replay — the
  // display flip restarts it from zero and the switch reads as a flicker.
  // Finishing the freshly restarted animations jumps the panel straight to
  // its settled state. Only animations targeting the panel element itself are
  // finished — that includes its ::before/::after chrome, whose animations
  // report the origin element as their target — while animations inside the
  // content (loading spinners) keep running. Plain show()/hide() outside the
  // flow never comes through here, so opening and closing keep the theme's
  // animation.
  settleAnimations(panel) {
    const element = panel.getElement();
    if (typeof element.getAnimations !== "function") return;
    for (const animation of element.getAnimations({ subtree: true })) {
      if (animation.effect?.target !== element) continue;
      try {
        animation.finish();
      } catch {
        // Infinite animations cannot be finished; leave them be.
      }
    }
  }

  labelFor(panel, label) {
    return label ?? panel.crumb ?? "Modal";
  }

  visibleModalPanel() {
    return this.modalPanels().find((panel) => panel.isVisible()) ?? null;
  }

  modalPanels() {
    return this.workspace.panelContainers.modal.getPanels();
  }

  // Subscribed only while a trail exists; the container reference is read
  // fresh each time so the keeper survives a workspace reset.
  ensureSubscriptions() {
    if (this.subscriptions || this.stack.length === 0) return;
    this.subscriptions = new CompositeDisposable();
    const observe = (panel) => {
      // The trail can be cleared while the emitter carrying this callback is
      // still mid-dispatch; a cleared keeper must not resubscribe.
      if (!this.subscriptions) return;
      this.subscriptions.add(
        panel.onDidChangeVisible(() => this.checkTrail()),
        panel.onDidDestroy(() => this.panelDestroyed(panel)),
      );
    };
    for (const panel of this.modalPanels()) observe(panel);
    this.subscriptions.add(
      this.workspace.panelContainers.modal.onDidAddPanel(({ panel }) => observe(panel)),
    );
  }

  didChange() {
    this.renderStrip();
    this.emitter.emit("did-change-trail", this.getTrail());
  }

  /*
  Breadcrumb strip
  */

  renderStrip() {
    if (this.stack.length < 2) {
      if (this.strip) this.strip.style.display = "none";
      return;
    }
    const strip = this.getStrip();
    strip.textContent = "";
    this.stack.forEach(({ label }, index) => {
      const crumb = document.createElement("span");
      crumb.classList.add("modal-breadcrumb");
      crumb.textContent = label;
      crumb.title = label;
      if (index === this.stack.length - 1) {
        crumb.classList.add("current");
      } else {
        // preventDefault keeps the click from stealing focus off the modal —
        // a focus loss would cancel the dialog and destroy the very trail the
        // crumb navigates.
        crumb.addEventListener("mousedown", (event) => event.preventDefault());
        crumb.addEventListener("click", () => this.popTo(index));
      }
      strip.appendChild(crumb);
    });
    strip.style.display = "";
    this.positionStrip();
  }

  getStrip() {
    if (!this.strip) {
      this.strip = document.createElement("div");
      this.strip.classList.add("modal-breadcrumbs");
      this.strip.style.display = "none";
      window.addEventListener("resize", this.positionStrip);
    }
    if (!this.strip.isConnected) {
      this.workspace.getElement().appendChild(this.strip);
    }
    return this.strip;
  }

  // Anchored to the top edge of the modal card (the strip's own transform
  // lifts it above that edge). When a theme pins the card to the very top of
  // the window there is no room above, so clamp and let the strip overlap the
  // card's top padding rather than leave the viewport.
  positionStrip() {
    if (!this.strip || this.stack.length < 2) return;
    const element = this.stack[this.stack.length - 1].panel.getElement();
    const rect = element.getBoundingClientRect();
    this.strip.style.left = `${rect.left + rect.width / 2}px`;
    this.strip.style.maxWidth = `${rect.width}px`;
    this.strip.style.top = `${Math.max(rect.top, this.strip.offsetHeight)}px`;
  }
};
