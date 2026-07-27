// Captured at load, before any spec runs: the spec harness replaces the global
// timers and `Date.now` with a fake clock that only moves when a spec calls
// `advanceClock`, so waiting on the live ones from inside a spec would never
// resolve and this would hang instead of timing out.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeNow = Date.now.bind(Date);

module.exports = async function focusTestWindow() {
  if (document.hasFocus()) return;

  const remote = require("@electron/remote");
  const currentWindow = remote.getCurrentWindow();
  const webContents = remote.getCurrentWebContents();
  const timeoutAt = nativeNow() + 10000;

  // BrowserWindow.focus() requests native-window focus, while
  // WebContents.focus() focuses the page itself. Both transitions are
  // asynchronous on CI hosts, so do not continue until the renderer confirms
  // that they have completed.
  while (!document.hasFocus()) {
    currentWindow.focus();
    webContents.focus();
    await new Promise((resolve) => nativeSetTimeout(resolve, 50));

    if (nativeNow() >= timeoutAt) {
      throw new Error("Timed out waiting for the spec window to receive focus");
    }
  }
};
