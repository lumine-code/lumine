const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();
const TextBuffer = require("../src/text-buffer");
const FileState = require("../src/file-state");
const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("file document moves", () => {
  let root;
  beforeEach(async () => {
    jasmine.useRealClock();
    root = fs.realpathSync.native(temp.mkdirSync("document-moves-"));
    lumine.project.setPaths([root]);
    lumine.config.set("core.closeDeletedFileTabs", false);
    await lumine.project.getWatcherPromise(root);
  });

  async function open(name, contents = "base") {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    const editor = await lumine.workspace.open(target);
    await editor.getBuffer().getFileWatchStartPromise();
    return editor;
  }

  it("preserves dirty text and undo through a confirmed move", async () => {
    const editor = await open("source.txt");
    editor.setText("unsaved");
    const buffer = editor.getBuffer();
    const effect = {
      oldPath: editor.getPath(),
      newPath: path.join(root, "target.txt"),
      isDirectory: false,
    };
    const transaction = lumine.workspace.beginFileMove([effect]);
    fs.renameSync(effect.oldPath, effect.newPath);
    await transaction.complete([effect]);
    expect(editor.getBuffer()).toBe(buffer);
    expect(editor.getPath()).toBe(effect.newPath);
    expect(editor.getText()).toBe("unsaved");
    expect(buffer.getFileState()).toBe(FileState.MODIFIED);
    editor.undo();
    expect(editor.getText()).toBe("base");
  });

  it("does not close clean tabs when a move's delete arrives before completion", async () => {
    const editor = await open("source.txt");
    lumine.config.set("core.closeDeletedFileTabs", true);
    const effect = {
      oldPath: editor.getPath(),
      newPath: path.join(root, "target.txt"),
      isDirectory: false,
    };
    const transaction = lumine.workspace.beginFileMove([effect]);
    fs.renameSync(effect.oldPath, effect.newPath);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(editor.isDestroyed()).toBe(false);
    await transaction.complete([effect]);
    expect(editor.getPath()).toBe(effect.newPath);
    expect(editor.isDestroyed()).toBe(false);
  });

  it("retargets documents below moved directories without touching siblings", async () => {
    const moved = await open("dir/a.txt");
    const sibling = await open("dir-other/a.txt");
    const effect = {
      oldPath: path.join(root, "dir"),
      newPath: path.join(root, "renamed"),
      isDirectory: true,
    };
    const transaction = lumine.workspace.beginFileMove([effect]);
    fs.renameSync(effect.oldPath, effect.newPath);
    await transaction.complete([effect]);
    expect(moved.getPath()).toBe(path.join(root, "renamed", "a.txt"));
    expect(sibling.getPath()).toBe(path.join(root, "dir-other", "a.txt"));
  });

  it("keeps an externally renamed document at its original missing path", async () => {
    const editor = await open("source.txt");
    const original = editor.getPath();
    editor.setText("unsaved");
    fs.renameSync(original, path.join(root, "external.txt"));
    await conditionPromise(() => editor.getBuffer().getFileState() === FileState.REMOVED);
    expect(editor.getPath()).toBe(original);
    expect(editor.getText()).toBe("unsaved");
    await editor.save();
    expect(fs.readFileSync(original, "utf8")).toBe("unsaved");
  });

  it("reconciles invalidation without replacing unsaved contents", async () => {
    const file = path.join(root, "recovery.txt");
    fs.writeFileSync(file, "base");
    let invalidate;
    const subscription = () => ({ dispose() {} });
    spyOn(lumine.fileWatchClient, "watchFile").and.callFake((target) => ({
      path: target,
      ready: Promise.resolve(),
      closed: Promise.resolve(),
      dispose() {},
      onDidChange: subscription,
      onDidError: subscription,
      onDidInvalidate(callback) {
        invalidate = callback;
        return subscription();
      },
    }));
    const buffer = await TextBuffer.load(file);
    try {
      buffer.setText("unsaved");
      fs.writeFileSync(file, "changed during outage");
      invalidate({ path: file, reason: "worker-restarted", generation: 2 });
      await conditionPromise(() => buffer.getFileState() === FileState.CONFLICTED);
      expect(buffer.getText()).toBe("unsaved");
    } finally {
      buffer.destroy();
    }
  });

  it("releases every document watch after repeated open and close", async () => {
    await lumine.fileWatchClient.settlePendingTeardown();
    const before = lumine.fileWatchClient.handles.size;
    for (let i = 0; i < 12; i++) {
      const editor = await open(`file-${i}.txt`);
      editor.destroy();
    }
    await lumine.fileWatchClient.settlePendingTeardown();
    expect(lumine.fileWatchClient.handles.size).toBe(before);
    expect(lumine.workspace.fileDocuments.documents.size).toBe(0);
  });
});
