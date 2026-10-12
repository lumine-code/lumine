// This presentation bootstrap runs in the auxiliary DOM realm. It creates no
// environment, services, document models or package runtime.
window.luminePresentation = Object.freeze({
  postMessage(target, message, origin, ports) {
    // postMessage uses the incumbent realm as event.source. A callback created
    // in the shared main runtime would otherwise appear to come from opener,
    // and a sandboxed frame must continue to authenticate its actual parent.
    target.postMessage(message, origin, ports);
  },
});
