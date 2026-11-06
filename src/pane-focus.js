const { Disposable } = require("@lumine-code/event-kit");

// A pane can move between presentation documents before its old host disposes.
// Only the tracker that most recently claimed it may remove its focus class.
const owners = new WeakMap();

module.exports = function trackPaneFocus(window, document, nativeFocusSource) {
  const owner = {};
  let panes = new Set();
  let disposed = false;
  let pending = false;
  let pendingNative = false;

  const release = (pane) => {
    if (owners.get(pane) !== owner) return;
    owners.delete(pane);
    pane.classList.remove("is-focused");
  };
  const sync = () => {
    if (disposed) return;
    const next = new Set();
    const focused = typeof document.hasFocus !== "function" || document.hasFocus();
    if (focused && document.activeElement?.ownerDocument === document) {
      for (let element = document.activeElement; element; element = element.parentElement) {
        if (element.localName === "lumine-pane" && element.isConnected) next.add(element);
      }
    }
    for (const pane of panes) if (!next.has(pane)) release(pane);
    for (const pane of next) {
      if (owners.get(pane) === owner) continue;
      owners.set(pane, owner);
      pane.classList.add("is-focused");
    }
    panes = next;
  };
  const deferSync = () => {
    if (pending || disposed) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      sync();
    });
  };
  const windowChanged = () => {
    sync();
    deferSync();
  };
  const syncNative = () => {
    if (disposed) return;
    if (typeof document.hasFocus === "function")
      document.body.classList.toggle("is-blurred", !document.hasFocus());
    sync();
  };
  const nativeChanged = () => {
    // An iframe can already have blurred its parent Window, so leaving that
    // native window need not produce another DOM blur event.
    syncNative();
    if (pendingNative) return;
    pendingNative = true;
    queueMicrotask(() => {
      pendingNative = false;
      syncNative();
    });
  };
  document.addEventListener("focusin", sync, true);
  document.addEventListener("focusout", deferSync, true);
  window.addEventListener("focus", windowChanged);
  window.addEventListener("blur", windowChanged);
  const nativeFocus = nativeFocusSource?.onDidFocus(nativeChanged);
  const nativeBlur = nativeFocusSource?.onDidBlur(nativeChanged);
  let observer;
  if (document.nodeType === 9 && typeof window.MutationObserver === "function") {
    observer = new window.MutationObserver(sync);
    observer.observe(document, { childList: true, subtree: true });
  }
  sync();

  return new Disposable(() => {
    disposed = true;
    document.removeEventListener("focusin", sync, true);
    document.removeEventListener("focusout", deferSync, true);
    window.removeEventListener("focus", windowChanged);
    window.removeEventListener("blur", windowChanged);
    nativeFocus?.dispose();
    nativeBlur?.dispose();
    observer?.disconnect();
    for (const pane of panes) release(pane);
    panes.clear();
  });
};
