const { Disposable, Emitter } = require("@lumine-code/event-kit");

// A continuous geometry change can come from a pointer gesture or an
// animation. Width-derived editor work follows the same settling policy for
// both; pointer shielding belongs only to the gesture owner in layout-drag.
const emitter = new Emitter();
let activeResizes = 0;

function beginLayoutResize() {
  activeResizes++;
  return new Disposable(() => {
    activeResizes--;
    if (activeResizes === 0) emitter.emit("did-end");
  });
}

function isLayoutResizeActive() {
  return activeResizes > 0;
}

function onDidEndLayoutResize(callback) {
  return emitter.on("did-end", callback);
}

module.exports = { beginLayoutResize, isLayoutResizeActive, onDidEndLayoutResize };
