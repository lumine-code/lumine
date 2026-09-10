const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough, Readable } = require("stream");
const TextBuffer = require("../src/text-buffer");
const FileState = require("../src/file-state");
const FileDocumentRegistry = require("../src/file-document-registry");
const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("TextBuffer deferred file observation", () => {
  let originalLumine;
  let directory;
  let buffer;
  let handles;

  beforeEach(() => {
    jasmine.useRealClock?.();
    originalLumine = globalThis.lumine;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "buffer-watch-regression-"));
    handles = [];
    globalThis.lumine = {
      fileWatchClient: {
        watchFile() {
          const handle = {
            ready: Promise.resolve(),
            onDidChange(callback) {
              this.change = callback;
              return { dispose() {} };
            },
            onDidInvalidate(callback) {
              this.invalidate = callback;
              return { dispose() {} };
            },
            onDidError() {
              return { dispose() {} };
            },
            dispose() {},
          };
          handles.push(handle);
          return handle;
        },
      },
    };
  });

  afterEach(() => {
    buffer?.destroy();
    buffer = null;
    globalThis.lumine = originalLumine;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function source(text = "before") {
    return {
      text,
      exists: true,
      path: path.join(directory, "custom"),
      getPath() {
        return this.path;
      },
      existsSync() {
        return this.exists;
      },
      createReadStream() {
        return Readable.from([this.text]);
      },
      onDidChange(callback) {
        this.change = callback;
        return { dispose() {} };
      },
      onDidDelete(callback) {
        this.delete = callback;
        return { dispose() {} };
      },
    };
  }

  async function changedWhileSuspended(custom, text) {
    buffer.beginFileOperation();
    custom.text = text;
    custom.change();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(buffer.pendingFileReconcile).toBe(true);
    await buffer.endFileOperation();
  }

  for (const mode of ["async", "sync"]) {
    it(`initializes an allowed missing ${mode} load and reads a subsequent creation`, async () => {
      const filePath = path.join(directory, "not-created-yet");
      buffer = mode === "async" ? await TextBuffer.load(filePath) : TextBuffer.loadSync(filePath);
      expect(buffer.loaded).toBe(true);
      expect(buffer.didHaveFileOnDisk).toBe(false);
      fs.writeFileSync(filePath, "created after load");
      handles[0].change([{ action: "created", path: filePath }]);
      await conditionPromise(
        () => buffer.getText() === "created after load",
        "created file loaded",
      );
      expect(buffer.getText()).toBe("created after load");
      expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
    });
  }

  for (const newestFirst of [false, true]) {
    it(`cancels an obsolete native reload before applying its contents (${newestFirst ? "newest" : "oldest"} finishes first)`, async () => {
      const custom = source();
      buffer = await TextBuffer.load(custom);
      const reads = [];
      custom.createReadStream = () => {
        const stream = new PassThrough();
        reads.push(stream);
        return stream;
      };
      const changes = [];
      buffer.onDidChange(({ changes: edits }) => changes.push(...edits));
      const older = buffer.reload();
      const newer = buffer.reload();
      if (newestFirst) {
        reads[1].end("newest");
        await newer;
        reads[0].end("obsolete");
        await older;
      } else {
        // Two reads of identical contents must still deliver the first patch.
        // Applying and then ignoring the obsolete read would leave the latest
        // read with an empty diff and lose both its event and undo history.
        reads[0].end("newest");
        await older;
        reads[1].end("newest");
        await newer;
      }
      expect(buffer.getText()).toBe("newest");
      expect(changes.length).toBeGreaterThan(0);
      buffer.undo();
      expect(buffer.getText()).toBe("before");
    });
  }

  it("defers watcher reconciliation until an explicit reload finishes", async () => {
    const custom = source();
    buffer = await TextBuffer.load(custom);
    buffer.delete([
      [0, 0],
      [0, 2],
    ]);

    const reads = [];
    custom.createReadStream = () => {
      const stream = new PassThrough();
      reads.push(stream);
      return stream;
    };
    const events = [];
    buffer.onWillReload(() => events.push("will-reload"));
    buffer.onDidReload(() => events.push("did-reload"));

    const reload = buffer.reload();
    expect(reads.length).toBe(1);
    await buffer.reconcileWatchedFile();
    expect(reads.length).toBe(1);

    reads[0].end("after");
    await conditionPromise(() => reads.length === 2, "deferred reconciliation started");
    reads[1].end("after");
    await reload;
    expect(buffer.getText()).toBe("after");
    expect(events).toEqual(["will-reload", "did-reload"]);
  });

  it("releases the pending load when a custom source cannot create its stream", async () => {
    const custom = source();
    buffer = await TextBuffer.load(custom);
    const error = new Error("Custom source failed");
    custom.createReadStream = () => {
      throw error;
    };
    await expectAsync(buffer.reload()).toBeRejectedWith(error);
    expect(buffer.pendingFileLoads).toBe(0);
    expect(buffer.getText()).toBe("before");
    custom.createReadStream = () => Readable.from(["recovered"]);
    await buffer.reload();
    expect(buffer.getText()).toBe("recovered");
  });

  it("drains a custom source change deferred during a file operation", async () => {
    const custom = source();
    buffer = await TextBuffer.load(custom);
    await changedWhileSuspended(custom, "after operation");
    expect(buffer.getText()).toBe("after operation");
    expect(buffer.pendingFileReconcile).toBe(false);
  });

  it("drains a custom source deletion deferred during a file operation", async () => {
    const custom = source();
    buffer = await TextBuffer.load(custom);
    buffer.beginFileOperation();
    custom.exists = false;
    custom.delete();
    expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
    await buffer.endFileOperation();
    expect(buffer.getFileState()).toBe(FileState.REMOVED);
    expect(buffer.getText()).toBe("before");
  });

  it("replaces the old native reconciliation closure when switching to a custom source", async () => {
    const filePath = path.join(directory, "old-source");
    fs.writeFileSync(filePath, "before");
    buffer = await TextBuffer.load(filePath);
    const oldReconcile = buffer.reconcileWatchedFile;
    const custom = source();
    buffer.setFile(custom);
    await buffer.load();
    expect(buffer.reconcileWatchedFile).not.toBe(oldReconcile);
    await changedWhileSuspended(custom, "custom contents");
    expect(buffer.getText()).toBe("custom contents");
    await oldReconcile();
    expect(buffer.getText()).toBe("custom contents");
  });

  function registerBuffer(registry) {
    return registry.register({
      owner: buffer,
      getPath: () => buffer.getFileMovePath(),
      setPath: (target) => buffer.relocateFile(target),
      beginFileOperation: () => buffer.beginFileOperation(),
      endFileOperation: () => buffer.endFileOperation(),
    });
  }

  for (const emitRename of [false, true]) {
    it(`preserves an opted-in custom source through relocation${emitRename ? " with provider rename events" : ""}`, async () => {
      const custom = source("decoded contents");
      const renameListeners = new Set();
      custom.onDidRename = (callback) => {
        renameListeners.add(callback);
        return { dispose: () => renameListeners.delete(callback) };
      };
      custom.setPath = async (target) => {
        custom.path = target;
        if (emitRename) for (const callback of renameListeners) callback();
      };
      buffer = await TextBuffer.load(custom);
      buffer.append(" with unsaved edits");
      const pathChanged = jasmine.createSpy("path changed");
      buffer.onDidChangePath(pathChanged);
      const registry = new FileDocumentRegistry();
      const registration = registerBuffer(registry);
      const move = { oldPath: custom.path, newPath: path.join(directory, "relocated") };
      try {
        await registry.beginFileMove([move]).complete([move]);
        expect(buffer.file).toBe(custom);
        expect(buffer.getPath()).toBe(move.newPath);
        expect(buffer.getText()).toBe("decoded contents with unsaved edits");
        expect(buffer.getFileState()).toBe(FileState.MODIFIED);
        expect(pathChanged).toHaveBeenCalledOnceWith(move.newPath);
        // A provider may deliver a second asynchronous notification after its
        // setPath promise settles; it still represents the same path change.
        if (emitRename) for (const callback of renameListeners) callback();
        expect(pathChanged).toHaveBeenCalledTimes(1);
        buffer.undo();
        expect(buffer.getText()).toBe("decoded contents");
        expect(renameListeners.size).toBe(1);
      } finally {
        registration.dispose();
        registry.dispose();
      }
    });
  }

  it("excludes custom sources that do not opt in to filesystem relocation", async () => {
    const custom = source();
    buffer = await TextBuffer.load(custom);
    expect(buffer.getFileMovePath()).toBeNull();
    const registry = new FileDocumentRegistry();
    const registration = registerBuffer(registry);
    const oldPath = custom.path;
    const move = { oldPath, newPath: path.join(directory, "unrelated") };
    try {
      const operation = registry.beginFileMove([move]);
      expect(buffer.fileWatchOperationDepth).toBe(0);
      await operation.complete([move]);
      expect(buffer.file).toBe(custom);
      expect(buffer.getPath()).toBe(oldPath);
      expect(buffer.getText()).toBe("before");
    } finally {
      registration.dispose();
      registry.dispose();
    }
  });
});
