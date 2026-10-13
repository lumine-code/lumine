const { Disposable, Emitter } = require("@lumine-code/event-kit");

// Tracks whether the user is dragging something that resizes editors right now
// — a pane divider, a dock handle, a package's own resize grip.
//
// Such a gesture moves editor widths once per animation frame for as long as the
// button is held. Anything whose layout is derived from that width — soft wrap
// above all — has to tell it apart from a one-shot change (a dock toggle, a pane
// split, a package resizing the client container), because they want opposite
// treatment: during a drag every reflow is abandoned by the next frame and is
// pure cost, while a one-shot change is already the final width and must land on
// the frame it happens.
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
    if (activeDrags === 0) emitter.emit("did-end");
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

// Fires when the last live drag ends, so work deferred for its duration can
// settle at the final width instead of waiting out a timeout the gesture has
// already answered.
function onDidEndLayoutDrag(callback) {
  return emitter.on("did-end", callback);
}

module.exports = {
  beginLayoutDrag,
  isLayoutDragActive,
  onDidEndLayoutDrag,
  onDidLoseLayoutFocus,
};
