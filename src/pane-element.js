const path = require("path");
const { CompositeDisposable } = require("@lumine-code/event-kit");
const { classFactory } = require("./realm-custom-element");

function initializePaneElement() {
  this.attached = false;
  this.subscriptions = new CompositeDisposable();
  this.inlineDisplayStyles = new WeakMap();
  this.subscribeToDOMEvents();
  this.itemViews = this.ownerDocument.createElement("div");
}

class PaneElement extends HTMLElement {
  constructor() {
    super();
    initializePaneElement.call(this);
  }

  connectedCallback() {
    this.initializeContent();
    this.attached = true;
    // Splitting a pane replaces it with an axis containing it, so a pane
    // element is detached and reattached mid-operation. `activeItemChanged`
    // hides the outgoing view unconditionally but only shows the incoming one
    // while attached, so an item that changed during that window has to be
    // shown here -- otherwise the pane comes back blank.
    if (this.visibleItemView) {
      this.showItemView(this.visibleItemView);
    }
    if (this.model.isFocused()) {
      // Collapsing an axis reparents the pane it leaves behind, so this runs
      // for the surviving pane every time a split is closed.
      this.focusActiveView();
    }
  }

  disconnectedCallback() {
    this.attached = false;
  }

  initializeContent() {
    // `observeActive()` runs during initialization, before this element is
    // connected. Preserve the class it applies so a restored active pane does
    // not lose its focused-tab styling when it enters the DOM.
    this.classList.add("pane");
    this.setAttribute("tabindex", -1);
    this.appendChild(this.itemViews);
    this.itemViews.setAttribute("class", "item-views");
  }

  subscribeToDOMEvents() {
    const handleFocus = (event) => {
      if (!(this.isActivating || this.model.isDestroyed() || this.contains(event.relatedTarget))) {
        this.model.focus();
      }
      if (event.target !== this) return;
      const view = this.getActiveView();
      if (view) {
        view.focus();
        event.stopPropagation();
      }
    };
    const handleBlur = (event) => {
      // A blur with no successor (relatedTarget null, focus fell to `body`)
      // is not the user leaving this pane. Chromium fires one while it
      // unfocuses a subtree that is about to be detached -- the blur arrives
      // before the detach, so the tree still looks connected -- and that is
      // exactly what collapsing an axis does to the surviving pane.
      // `connectedCallback` restores focus from the model's `focused` claim
      // after that reparent, so only a blur that says which element took focus
      // may clear the claim it restores from.
      if (event.relatedTarget && !this.contains(event.relatedTarget)) {
        this.model.blur();
      }
    };
    this.addEventListener("focus", handleFocus, { capture: true });
    this.addEventListener("blur", handleBlur, { capture: true });
  }

  initialize(model, { views, applicationDelegate }) {
    this.model = model;
    this.views = views;
    this.applicationDelegate = applicationDelegate;
    if (this.views == null) {
      throw new Error("Must pass a views parameter when initializing PaneElements");
    }
    if (this.applicationDelegate == null) {
      throw new Error("Must pass an applicationDelegate parameter when initializing PaneElements");
    }
    this.subscriptions.add(this.model.onDidActivate(this.activated.bind(this)));
    this.subscriptions.add(this.model.observeActive(this.activeStatusChanged.bind(this)));
    this.subscriptions.add(this.model.observeActiveItem(this.activeItemChanged.bind(this)));
    this.subscriptions.add(this.model.onDidRemoveItem(this.itemRemoved.bind(this)));
    this.subscriptions.add(this.model.onDidDestroy(this.paneDestroyed.bind(this)));
    this.subscriptions.add(this.model.observeFlexScale(this.flexScaleChanged.bind(this)));
    return this;
  }

  getModel() {
    return this.model;
  }

  // Focus the active item's view, falling back to this element for a pane with
  // nothing to show. Focusing this element instead only reaches the item
  // through `handleFocus`, and a `focus()` call fires no event at all while the
  // window is not the focused one -- which is exactly the state a native menu
  // leaves the renderer in. So `Close Pane` from a menu used to park focus on
  // the bare pane element: the surviving pane was active, drew no cursor and
  // took no keystrokes.
  //
  // The fallback also has to catch a view that merely ignores `focus()` -- an
  // item whose root is a plain unfocusable element. Closing a split reparents
  // this pane, which silently drops focus on `body`, and a no-op `view.focus()`
  // would leave it there: no element in the workspace focused, no keymap
  // context beyond `body`. The pane element itself (tabindex -1) is what keeps
  // keystrokes in this pane, so take it whenever the view did not take focus.
  focusActiveView() {
    const view = this.getActiveView();
    if (view) {
      view.focus();
      if (this.hasFocus()) return;
    }
    this.focus();
  }

  activated() {
    this.isActivating = true;
    if (!this.hasFocus()) {
      // Don't steal focus from children.
      this.focusActiveView();
    }
    this.isActivating = false;
  }

  activeStatusChanged(active) {
    if (active) {
      this.classList.add("active");
    } else {
      this.classList.remove("active");
    }
  }

  activeItemChanged(item) {
    delete this.dataset.activeItemName;
    delete this.dataset.activeItemPath;
    if (this.changePathDisposable != null) {
      this.changePathDisposable.dispose();
    }
    if (item == null) {
      return;
    }
    const hasFocus = this.hasFocus();
    const itemView = this.views.getView(item);
    const itemPath = typeof item.getPath === "function" ? item.getPath() : null;
    if (itemPath) {
      this.dataset.activeItemName = path.basename(itemPath);
      this.dataset.activeItemPath = itemPath;
      if (item.onDidChangePath != null) {
        this.changePathDisposable = item.onDidChangePath(() => {
          const itemPath = item.getPath();
          this.dataset.activeItemName = path.basename(itemPath);
          this.dataset.activeItemPath = itemPath;
        });
      }
    }

    if (!this.itemViews.contains(itemView)) {
      this.itemViews.appendChild(itemView);
    }
    // Exactly one view is ever shown, so hiding the one that was showing beats
    // walking every view the pane has accumulated — that walk turns switching
    // tabs into work proportional to how many items have been opened.
    if (this.visibleItemView && this.visibleItemView !== itemView) {
      this.hideItemView(this.visibleItemView);
    }
    this.visibleItemView = itemView;
    if (this.attached) {
      this.showItemView(itemView);
    }
    if (hasFocus) {
      itemView.focus();
    }
  }

  showItemView(itemView) {
    const inlineDisplayStyle = this.inlineDisplayStyles.get(itemView);
    if (inlineDisplayStyle != null) {
      itemView.style.display = inlineDisplayStyle;
    } else {
      itemView.style.display = "";
    }
  }

  hideItemView(itemView) {
    const inlineDisplayStyle = itemView.style.display;
    if (inlineDisplayStyle !== "none") {
      if (inlineDisplayStyle != null) {
        this.inlineDisplayStyles.set(itemView, inlineDisplayStyle);
      }
      itemView.style.display = "none";
    }
  }

  itemRemoved({ item, index: _index, destroyed: _destroyed }) {
    const viewToRemove = this.views.getView(item);
    if (viewToRemove) {
      const hadFocus = viewToRemove.contains(this.ownerDocument.activeElement);
      if (this.visibleItemView === viewToRemove) this.visibleItemView = null;
      viewToRemove.remove();
      // Removing the focused element drops focus on `body` without firing any
      // blur event, so nothing downstream can notice. This is how destroying
      // the last item used to unfocus the workspace: `activeItemChanged(null)`
      // has no view to hand focus to, and nothing else ran. Hand it back to
      // this pane -- the next active view when one exists, the pane element
      // itself for a pane that is now empty. A caller that moves focus after
      // the removal (moving an item activates the destination pane) still wins:
      // it runs after this does.
      if (hadFocus && !this.model.isDestroyed()) this.focusActiveView();
    }
  }

  paneDestroyed() {
    this.subscriptions.dispose();
    if (this.changePathDisposable != null) {
      this.changePathDisposable.dispose();
    }
  }

  flexScaleChanged(flexScale) {
    this.style.flexGrow = flexScale;
  }

  getActiveView() {
    return this.views.getView(this.model.getActiveItem());
  }

  hasFocus() {
    const activeElement = this.ownerDocument.activeElement;
    return this === activeElement || this.contains(activeElement);
  }
}

function createPaneElement(document = globalThis.document) {
  return document.createElement("lumine-pane");
}

module.exports = {
  createPaneElement,
  elementDefinition: {
    name: "lumine-pane",
    factory: classFactory(PaneElement, initializePaneElement),
  },
};
