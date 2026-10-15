const HTCAPTION = 2;
const WM_PARENTNOTIFY = 0x0210;
const CHILD_MOUSE_DOWN_MESSAGES = new Set([
  0x0201, // WM_LBUTTONDOWN
  0x0204, // WM_RBUTTONDOWN
  0x0207, // WM_MBUTTONDOWN
]);
const CAPTION_MOUSE_DOWN_MESSAGES = [
  0x00a1, // WM_NCLBUTTONDOWN
  0x00a3, // WM_NCLBUTTONDBLCLK
  0x00a4, // WM_NCRBUTTONDOWN
  0x00a6, // WM_NCRBUTTONDBLCLK
  0x00a7, // WM_NCMBUTTONDOWN
  0x00a9, // WM_NCMBUTTONDBLCLK
];

// Draggable CSS regions do not deliver DOM mouse events. Chromium can receive
// their caption input on a child HWND and bypass the parent window's caption
// hooks. WM_PARENTNOTIFY still reaches the parent for those clicks, including
// double-clicks, and carries the position in native client pixels. The renderer
// checks whether that position belongs to a draggable region. None of these
// observers consumes input, so native dragging and double-click actions run.
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
  if (!browserWindow.isWindowMessageHooked(WM_PARENTNOTIFY)) {
    browserWindow.hookWindowMessage(WM_PARENTNOTIFY, (wParam, lParam) => {
      if (!disposed && CHILD_MOUSE_DOWN_MESSAGES.has(wParam.readUInt16LE(0))) {
        onMouseDown({ x: lParam.readInt16LE(0), y: lParam.readInt16LE(2) });
      }
    });
    hookedMessages.push(WM_PARENTNOTIFY);
  }
  if (hookedMessages.length > 0) {
    browserWindow.once("closed", disposable.dispose);
  }
  return disposable;
};
