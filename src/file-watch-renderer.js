const crypto = require("node:crypto");
const { ipcRenderer } = require("electron");
const { Disposable } = require("@lumine-code/event-kit");
const FileWatchClient = require("./file-watch-client");

module.exports = function createFileWatchClient(applicationDelegate) {
  const session = applicationDelegate.getWindowLoadSettings().fileWatchSession;
  const clientId = crypto.randomUUID();
  return new FileWatchClient({
    request: async (request) => {
      const result = await ipcRenderer.invoke("lumine:file-watch", { session, clientId, request });
      if (result?.error) throw Object.assign(new Error(result.error.message), result.error);
      return result?.value;
    },
    onEvent: (callback) => {
      const listener = (_event, message) => {
        if (message.session === session && message.clientId === clientId) callback(message.event);
      };
      ipcRenderer.on("lumine:file-watch-event", listener);
      return new Disposable(() => ipcRenderer.removeListener("lumine:file-watch-event", listener));
    },
  });
};
