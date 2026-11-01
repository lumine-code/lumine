const { Disposable, Emitter } = require("@lumine-code/event-kit");
const { beginLayoutResize } = require("./layout-resize");

// Tracks whether the user is dragging something that resizes editors right now
// — a pane divider, a dock handle, a package's own resize grip.
//
// It also owns a general resize session, so width-derived editor work follows
// the same settling policy as animated resizing. Only a pointer drag shields
// embedded surfaces against stealing the pointer before the gesture ends.
//
// The signal is global on purpose. One divider moves every editor on both sides
// of it, and the surfaces that run the gesture know nothing about which editors
// it will reach.

const emitter = new Emitter();
let activeDrags = 0;
const documentDrags = new WeakMap();
const DRAGGING_CLASS = "lumine-layout-dragging";

// The returned Disposable is what ends the drag, rather than a paired `end`
// call, because these gestures end down several paths: a mouseup, a mousemove
// that finds no button held any more, a handle disconnected mid-drag, a dock
// destroyed. More than one of those can run for the same drag, and a Disposable
// only fires once.
function beginLayoutDrag(document = globalThis.document) {
  const resize = beginLayoutResize();
  let state;
  if (document?.documentElement) {
    state = documentDrags.get(document);
    if (!state) {
      const element = document.documentElement;
      state = { count: 0, element, ownsClass: !element.classList.contains(DRAGGING_CLASS) };
      documentDrags.set(document, state);
      element.classList.add(DRAGGING_CLASS);
    }
    state.count++;
  }
  activeDrags++;
  return new Disposable(() => {
    if (state && --state.count === 0) {
      if (state.ownsClass) state.element.classList.remove(DRAGGING_CLASS);
      documentDrags.delete(document);
    }
    activeDrags--;
    try {
      resize.dispose();
    } finally {
      if (activeDrags === 0) emitter.emit("did-end");
    }
  });
}

function onDidLoseLayoutFocus(document, callback) {
  const window = document.defaultView;
  let disposed = false;
  const blurred = () => {
    // Moving focus to a child frame blurs the parent Window without leaving
    // its document. Wait until the browser's focus transition has settled.
    queueMicrotask(() => {
      if (!disposed && !document.hasFocus()) callback();
    });
  };
  window.addEventListener("blur", blurred);
  return new Disposable(() => {
    disposed = true;
    window.removeEventListener("blur", blurred);
  });
}

function isLayoutDragActive() {
  return activeDrags > 0;
}

// Reports the end of pointer gestures independently of overlapping animations.
// Width-derived work uses layout-resize's end signal instead.
function onDidEndLayoutDrag(callback) {
  return emitter.on("did-end", callback);
}

module.exports = {
  beginLayoutDrag,
  isLayoutDragActive,
  onDidEndLayoutDrag,
  onDidLoseLayoutFocus,
};
