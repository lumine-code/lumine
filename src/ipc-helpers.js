const Disposable = require("@lumine-code/event-kit").Disposable;
let ipcRenderer = null;
let ipcMain = null;
let BrowserWindow = null;

let nextResponseChannelId = 0;

function serializeError(error) {
  const result = { name: "Error", message: "Unknown IPC error" };
  try {
    result.message = String(error?.message ?? error);
  } catch {
    // A thrown object may have no string conversion or expose throwing getters.
  }
  for (const key of ["name", "stack", "code", "path"]) {
    try {
      const value = error?.[key];
      if (typeof value === "string" || typeof value === "number") result[key] = value;
    } catch {
      // Error metadata must never prevent the failure response from being sent.
    }
  }
  return result;
}

exports.on = function (emitter, eventName, callback) {
  emitter.on(eventName, callback);
  return new Disposable(() => emitter.removeListener(eventName, callback));
};

exports.call = function (channel, ...args) {
  if (!ipcRenderer) {
    ipcRenderer = require("electron").ipcRenderer;
    ipcRenderer.setMaxListeners(20);
  }

  const responseChannel = `ipc-helpers-response-${nextResponseChannelId++}`;

  return new Promise((resolve, reject) => {
    const onResponse = (event, response) => {
      if (response?.ok === true) {
        resolve(response.value);
      } else {
        reject(
          Object.assign(
            new Error(response?.error?.message || `IPC request '${channel}' failed`),
            response?.error,
          ),
        );
      }
    };
    ipcRenderer.once(responseChannel, onResponse);
    try {
      ipcRenderer.send(channel, responseChannel, ...args);
    } catch (error) {
      ipcRenderer.removeListener(responseChannel, onResponse);
      reject(error);
    }
  });
};

exports.respondTo = function (channel, callback) {
  if (!ipcMain) {
    const electron = require("electron");
    ipcMain = electron.ipcMain;
    BrowserWindow = electron.BrowserWindow;
  }

  return exports.on(ipcMain, channel, async (event, responseChannel, ...args) => {
    try {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const value = await callback(browserWindow, ...args);
      if (!event.sender.isDestroyed()) {
        event.sender.send(responseChannel, { ok: true, value });
      }
    } catch (error) {
      if (!event.sender.isDestroyed()) {
        try {
          event.sender.send(responseChannel, { ok: false, error: serializeError(error) });
        } catch (responseError) {
          console.error(`Failed to send IPC response '${channel}'`, responseError);
        }
      }
    }
  });
};
