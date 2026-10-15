const HTCAPTION = 2;
const CAPTION_MOUSE_DOWN_MESSAGES = [
  0x00a1, // WM_NCLBUTTONDOWN
  0x00a3, // WM_NCLBUTTONDBLCLK
  0x00a4, // WM_NCRBUTTONDOWN
  0x00a6, // WM_NCRBUTTONDBLCLK
  0x00a7, // WM_NCMBUTTONDOWN
  0x00a9, // WM_NCMBUTTONDBLCLK
];

// Draggable CSS regions do not deliver DOM mouse events. Observe Windows'
// caption messages without consuming them, so native dragging and double-click
// actions still run. A double-click replaces the second button-down message.
module.exports = function attachNativeWindowInput(
  browserWindow,
  onMouseDown,
  { platform = process.platform } = {},
) {
  let disposed = false;
  const hookedMessages = [];
  const disposable = {
    dispose() {
      if (disposed) return;
      disposed = true;
      browserWindow?.removeListener?.("closed", disposable.dispose);
      if (!browserWindow?.isDestroyed?.()) {
        for (const message of hookedMessages) {
          browserWindow.unhookWindowMessage(message);
        }
      }
      hookedMessages.length = 0;
    },
  };

  if (
    platform !== "win32" ||
    browserWindow?.isDestroyed?.() ||
    typeof browserWindow?.hookWindowMessage !== "function" ||
    typeof browserWindow?.unhookWindowMessage !== "function" ||
    typeof browserWindow?.isWindowMessageHooked !== "function"
  ) {
    return disposable;
  }

  const notify = (wParam) => {
    if (!disposed && wParam.readUInt32LE(0) === HTCAPTION) {
      onMouseDown();
    }
  };
  for (const message of CAPTION_MOUSE_DOWN_MESSAGES) {
    // Electron keeps one callback per message. Leave another owner's hook alone.
    if (browserWindow.isWindowMessageHooked(message)) continue;
    browserWindow.hookWindowMessage(message, notify);
    hookedMessages.push(message);
  }
  if (hookedMessages.length > 0) {
    browserWindow.once("closed", disposable.dispose);
  }
  return disposable;
};
