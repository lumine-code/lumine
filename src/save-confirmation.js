const { CompositeDisposable } = require("@lumine-code/event-kit");
const { SaveCancelledError } = require("./save-errors");
const path = require("node:path");

function sameSavePath(first, second) {
  if (first == null || second == null) return first === second;
  const normalize = (value) => {
    const normalized = path.resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(first) === normalize(second);
}

function confirmSave(buffer, confirmation, operation, requestedWindow) {
  const { notifications, workspace } = globalThis.lumine;
  const window = requestedWindow ?? workspace.getFocusedWindow() ?? workspace.getMainWindow();
  return new Promise((resolve, reject) => {
    const subscriptions = new CompositeDisposable();
    let notification;
    let settled = false;
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      subscriptions.dispose();
      notification?.dismiss();
      if (decision) resolve(decision);
      else reject(new SaveCancelledError("Save cancelled"));
    };
    operation.cancelPrompt = () => finish(null);
    subscriptions.add(
      buffer.onDidDestroy(operation.cancel),
      buffer.onDidChangePath(operation.cancel),
      notifications.onDidClearNotifications(operation.cancel),
      window.onWillDestroy(operation.cancel),
    );
    try {
      if (operation.cancelled || buffer.isDestroyed() || window.isDestroyed()) {
        finish(null);
        return;
      }
      notification = notifications.addWarning(confirmation.message, {
        ...(confirmation.detail == null ? {} : { detail: confirmation.detail }),
        window,
        dismissable: true,
        buttons: [
          { text: "Yes, always", className: "btn-primary", onDidClick: () => finish("always") },
          { text: "Yes", onDidClick: () => finish("once") },
          { text: "No", onDidClick: operation.cancel },
        ],
      });
      if (settled) notification.dismiss();
      else if (notification.isDismissed()) operation.cancel();
      else subscriptions.add(notification.onDidDismiss(operation.cancel));
    } catch (error) {
      subscriptions.dispose();
      settled = true;
      notification?.dismiss();
      reject(error);
    }
  });
}

module.exports = { confirmSave, sameSavePath };
