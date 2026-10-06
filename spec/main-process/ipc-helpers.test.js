const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { Disposable, Emitter } = require("@lumine-code/event-kit");

const helperSource = fs.readFileSync(path.join(__dirname, "../../src/ipc-helpers.js"), "utf8");
const delegateSource = fs.readFileSync(
  path.join(__dirname, "../../src/application-delegate.js"),
  "utf8",
);

function createTransport() {
  const ipcRenderer = new EventEmitter();
  const ipcMain = new EventEmitter();
  const browserWindow = {};
  const requests = [];
  const reportedErrors = [];
  const sender = {
    isDestroyed: () => false,
    send: (channel, response) => ipcRenderer.emit(channel, {}, structuredClone(response)),
  };
  const electron = {
    ipcRenderer,
    ipcMain,
    BrowserWindow: { fromWebContents: (contents) => (contents === sender ? browserWindow : null) },
  };
  ipcRenderer.send = (channel, responseChannel, ...args) => {
    requests.push({ channel, responseChannel });
    ipcMain.emit(channel, { sender }, responseChannel, ...args);
  };
  const context = {
    exports: {},
    console: { error: (...args) => reportedErrors.push(args) },
    require: (name) => {
      if (name === "electron") return electron;
      if (name === "@lumine-code/event-kit") return { Disposable };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(helperSource, context, { filename: "ipc-helpers.js" });
  return {
    helpers: context.exports,
    ipcRenderer,
    ipcMain,
    browserWindow,
    sender,
    requests,
    reportedErrors,
  };
}

function createDelegate({ helpers, ipcRenderer }) {
  const context = {
    module: { exports: {} },
    require: (name) => {
      if (name === "electron") return { ipcRenderer };
      if (name === "./ipc-helpers") return helpers;
      if (name === "@lumine-code/event-kit") return { Disposable, Emitter };
      if (name === "./get-window-load-settings") return () => ({});
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(delegateSource, context, { filename: "application-delegate.js" });
  return new context.module.exports();
}

describe("IPC request responses", () => {
  it("delivers settings read failures from the main process", () => {
    const transport = createTransport();
    const delegate = createDelegate(transport);
    const messages = [];
    const subscription = delegate.onDidFailToReadUserSettings((message) => messages.push(message));
    transport.ipcRenderer.emit("message", {}, "did-fail-to-read-user-settings", "cannot read");
    assert.deepEqual(messages, ["cannot read"]);
    subscription.dispose();
    transport.ipcRenderer.emit("message", {}, "did-fail-to-read-user-settings", "later failure");
    assert.deepEqual(messages, ["cannot read"]);
  });

  it("resumes settings notifications after concurrent updates reject", async () => {
    const transport = createTransport();
    const { helpers, ipcRenderer } = transport;
    const delegate = createDelegate(transport);
    const rejections = [];
    helpers.respondTo(
      "set-user-settings",
      () => new Promise((_resolve, reject) => rejections.push(reject)),
    );
    let notifications = 0;
    delegate.onDidChangeUserSettings(() => notifications++);
    const first = delegate.setUserSettings({ first: true });
    const second = delegate.setUserSettings({ second: true });
    assert.equal(delegate.pendingSettingsUpdateCount, 2);
    ipcRenderer.emit("message", {}, "did-change-user-settings", {});
    assert.equal(notifications, 0);
    rejections[0](new Error("first write failed"));
    await assert.rejects(first, { message: "first write failed" });
    assert.equal(delegate.pendingSettingsUpdateCount, 1);
    rejections[1](new Error("second write failed"));
    await assert.rejects(second, { message: "second write failed" });
    assert.equal(delegate.pendingSettingsUpdateCount, 0);
    ipcRenderer.emit("message", {}, "did-change-user-settings", {});
    assert.equal(notifications, 1);
  });

  it("preserves successful values, including domain error envelopes and typed arrays", async () => {
    const { helpers, ipcRenderer, browserWindow, requests } = createTransport();
    helpers.respondTo("probe", (window, value) => {
      assert.strictEqual(window, browserWindow);
      return value;
    });
    for (const value of [
      undefined,
      null,
      { ok: false, error: "domain error" },
      new Uint8Array([1, 2]),
    ]) {
      assert.deepEqual(await helpers.call("probe", value), value);
      assert.equal(ipcRenderer.listenerCount(requests.at(-1).responseChannel), 0);
    }
  });

  for (const asynchronous of [false, true]) {
    it(`rejects a ${asynchronous ? "rejected Promise" : "synchronous throw"} and releases its listener`, async () => {
      const { helpers, ipcRenderer, requests } = createTransport();
      const error = Object.assign(new TypeError("cannot save"), {
        code: "EACCES",
        path: "/config",
      });
      helpers.respondTo("probe", () => {
        if (asynchronous) return Promise.reject(error);
        throw error;
      });
      await assert.rejects(helpers.call("probe"), (received) => {
        assert.equal(received.name, "TypeError");
        assert.equal(received.message, error.message);
        assert.equal(received.code, error.code);
        assert.equal(received.path, error.path);
        assert.equal(received.stack, error.stack);
        return true;
      });
      assert.equal(ipcRenderer.listenerCount(requests[0].responseChannel), 0);
    });
  }

  it("normalizes thrown values and excludes metadata that cannot cross IPC", async () => {
    const { helpers } = createTransport();
    helpers.respondTo("primitive", () => {
      throw "cannot save";
    });
    helpers.respondTo("metadata", () => {
      throw Object.assign(new Error("cannot clone metadata"), { code: () => {} });
    });
    await assert.rejects(helpers.call("primitive"), { name: "Error", message: "cannot save" });
    await assert.rejects(helpers.call("metadata"), { message: "cannot clone metadata" });
  });

  it("rejects thrown objects whose string conversion or metadata getters fail", async () => {
    const { helpers } = createTransport();
    helpers.respondTo("no-prototype", () => {
      throw Object.create(null);
    });
    helpers.respondTo("getters", () => {
      throw Object.defineProperties(
        {},
        {
          message: {
            get: () => {
              throw new Error("broken message");
            },
          },
          code: {
            get: () => {
              throw new Error("broken code");
            },
          },
        },
      );
    });
    for (const channel of ["no-prototype", "getters"]) {
      await assert.rejects(helpers.call(channel), { name: "Error", message: "Unknown IPC error" });
    }
  });

  it("rejects a response that cannot be serialized instead of leaving the caller waiting", async () => {
    const { helpers, ipcRenderer, requests } = createTransport();
    helpers.respondTo("probe", () => ({ uncloneable: () => {} }));
    await assert.rejects(helpers.call("probe"), { name: "DataCloneError" });
    assert.equal(ipcRenderer.listenerCount(requests[0].responseChannel), 0);
  });

  it("releases the response listener when sending the request fails", async () => {
    const { helpers, ipcRenderer } = createTransport();
    const error = new Error("transport unavailable");
    let responseChannel;
    ipcRenderer.send = (_channel, response) => {
      responseChannel = response;
      throw error;
    };
    await assert.rejects(helpers.call("probe"), (received) => received === error);
    assert.equal(ipcRenderer.listenerCount(responseChannel), 0);
  });

  it("routes concurrent responses to their own requests", async () => {
    const { helpers, ipcRenderer, requests } = createTransport();
    const resolvers = [];
    helpers.respondTo("probe", () => new Promise((resolve) => resolvers.push(resolve)));
    const first = helpers.call("probe");
    const second = helpers.call("probe");
    resolvers[1]("second");
    assert.equal(await second, "second");
    assert.equal(ipcRenderer.listenerCount(requests[0].responseChannel), 1);
    resolvers[0]("first");
    assert.equal(await first, "first");
    assert.equal(ipcRenderer.listenerCount(requests[0].responseChannel), 0);
  });

  it("does not send a response after the sender is destroyed during the callback", async () => {
    const { helpers, ipcMain, sender } = createTransport();
    let rejectCallback;
    helpers.respondTo("probe", () => new Promise((_resolve, reject) => (rejectCallback = reject)));
    let responses = 0;
    sender.send = () => responses++;
    const handling = ipcMain.listeners("probe")[0]({ sender }, "response");
    sender.isDestroyed = () => true;
    rejectCallback(new Error("late failure"));
    await handling;
    assert.equal(responses, 0);
  });

  for (const callbackFails of [false, true]) {
    it(`reports a failed ${callbackFails ? "error" : "success"} reply without an unhandled rejection`, async () => {
      const { helpers, ipcMain, sender, reportedErrors } = createTransport();
      const transportError = new Error("reply transport unavailable");
      sender.send = () => {
        throw transportError;
      };
      helpers.respondTo("probe", () => {
        if (callbackFails) throw new Error("callback failed");
        return "result";
      });
      await assert.doesNotReject(ipcMain.listeners("probe")[0]({ sender }, "response"));
      assert.equal(reportedErrors.length, 1);
      assert.match(reportedErrors[0][0], /Failed to send IPC response 'probe'/);
      assert.strictEqual(reportedErrors[0][1], transportError);
    });
  }

  it("disposes only its own responder when several share a channel", () => {
    const { helpers, ipcMain } = createTransport();
    const first = helpers.respondTo("probe", () => "first");
    const second = helpers.respondTo("probe", () => "second");
    first.dispose();
    assert.equal(ipcMain.listenerCount("probe"), 1);
    second.dispose();
    assert.equal(ipcMain.listenerCount("probe"), 0);
  });
});
