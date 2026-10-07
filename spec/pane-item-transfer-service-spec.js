const path = require("path");
const { Disposable } = require("@lumine-code/event-kit");
const PaneItemTransferService = require("../src/pane-item-transfer-service");
const WorkspaceDropManager = require("../src/workspace-drop-manager");
const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("PaneItemTransferService", () => {
  let service, scope, pane, targetPane, editor, delegate;

  function remoteDescriptor(overrides = {}) {
    return {
      kind: "pane-item",
      token: "remote-token",
      allowedLocations: ["center"],
      defaultLocation: "center",
      source: { windowId: lumine.window.getId() + 100, paneId: 8, onlyItem: true },
      items: [{ type: "pane-item", uri: "", fileState: "modified", modifiedText: "source text" }],
      ...overrides,
    };
  }

  function context(destination = targetPane, overrides = {}) {
    return {
      pane: destination,
      index: 0,
      surface: "tab-bar",
      resolvePane: jasmine.createSpy("resolvePane").and.returnValue(destination),
      ...overrides,
    };
  }

  beforeEach(async () => {
    delegate = { invokeApp: jasmine.createSpy("invokeApp").and.resolveTo(22) };
    service = new PaneItemTransferService({
      workspace: lumine.workspace,
      workspaceDrops: lumine.workspaceDrops,
      windowService: lumine.window,
      applicationDelegate: delegate,
    });
    scope = service.createScope();
    pane = lumine.workspace.getActivePane();
    editor = await lumine.workspace.open("", { pane });
    targetPane = pane.splitRight({ activate: false });
    spyOn(lumine.window, "focus").and.resolveTo();
  });

  afterEach(() => service.destroy());

  it("captures an exact source item, content and view state in one descriptor", () => {
    editor.setText("unsaved source");
    editor.setSelectedBufferRange(
      [
        [0, 1],
        [0, 4],
      ],
      { reversed: true },
    );
    const descriptor = scope.createTransfer(pane, editor);

    expect(descriptor).toEqual(
      jasmine.objectContaining({
        kind: "pane-item",
        effect: "move",
        allowedLocations: ["center"],
        source: { windowId: lumine.window.getId(), paneId: pane.id, onlyItem: true },
      }),
    );
    expect(descriptor.items[0]).toEqual(
      jasmine.objectContaining({
        uri: "",
        modifiedText: "unsaved source",
        textEditorState: editor.serializeViewState(),
      }),
    );
    expect(lumine.workspaceDrops.getSession(descriptor.token).item).toBe(editor);
  });

  it("moves the exact local item and publishes only the final destination activation", () => {
    const other = lumine.workspace.buildTextEditor();
    pane.addItem(other);
    const descriptor = scope.createTransfer(pane, editor);
    pane.moveItem(editor, 1);
    const activations = [];
    const subscription = lumine.workspace.onDidChangeActivePaneItem((item) =>
      activations.push(item),
    );
    const added = jasmine.createSpy("added");
    const addedSubscription = targetPane.onDidAddItem(added);
    const prepared = scope.prepareDrop(descriptor, targetPane);
    const result = scope.moveLocalItem(context(), prepared);

    expect(result).toEqual({ pane: targetPane, item: editor });
    expect(lumine.workspace.paneForItem(editor)).toBe(targetPane);
    expect(activations).toEqual([editor]);
    expect(added.calls.mostRecent().args[0].moved).toBe(true);
    expect(lumine.workspaceDrops.getSession(descriptor.token)).toBeUndefined();
    subscription.dispose();
    addedSubscription.dispose();
  });

  it("keeps current local content if the user edited after drag capture", () => {
    const descriptor = scope.createTransfer(pane, editor);
    editor.setText("new local content");
    const prepared = scope.prepareDrop(descriptor, targetPane);
    scope.moveLocalItem(context(), prepared);
    expect(editor.getText()).toBe("new local content");
    expect(lumine.workspace.paneForItem(editor)).toBe(targetPane);
  });

  it("does not reorder an item dropped on the center of its current pane", () => {
    const descriptor = scope.createTransfer(pane, editor);
    const dropContext = context(pane, { surface: "pane", candidateSplit: null });
    const prepared = scope.prepareDrop(descriptor, pane);
    expect(prepared.allowSplit).toBe(false);
    scope.moveLocalItem(dropContext, prepared);
    expect(dropContext.resolvePane).not.toHaveBeenCalled();
  });

  it("rejects a malformed or expired descriptor before a drop starts", () => {
    expect(scope.prepareDrop(remoteDescriptor({ token: "" }), pane)).toBeNull();
    expect(scope.prepareDrop(remoteDescriptor({ items: [] }), pane)).toBeNull();
    const descriptor = scope.createTransfer(pane, editor);
    scope.release(descriptor.token);
    expect(scope.prepareDrop(descriptor, pane)).toBeNull();
  });

  it("stages remote content and selections before committing and focuses afterwards", async () => {
    const state = editor.serializeViewState();
    const descriptor = remoteDescriptor({
      items: [{ type: "pane-item", uri: "", modifiedText: "remote text", textEditorState: state }],
    });
    let stagedItem;
    const commit = spyOn(lumine.workspaceDrops, "commit").and.callFake(async () => {
      stagedItem = targetPane.getItems()[0];
      expect(stagedItem.getText()).toBe("remote text");
      expect(stagedItem.serializeViewState().selections).toEqual(state.selections);
      expect(lumine.window.focus).not.toHaveBeenCalled();
      return true;
    });
    const added = jasmine.createSpy("added");
    const subscription = targetPane.onDidAddItem(added);
    const result = await scope.performDrop(context(), scope.prepareDrop(descriptor, targetPane));

    expect(result).toEqual({ pane: targetPane, item: stagedItem });
    expect(commit).toHaveBeenCalledOnceWith(descriptor.token, {
      sourceWindowId: descriptor.source.windowId,
    });
    expect(added.calls.mostRecent().args[0].transferred).toBe(true);
    expect(lumine.window.focus).toHaveBeenCalled();
    subscription.dispose();
  });

  it("rejects a dirty target URI before opening or overwriting it", async () => {
    const file = path.join(__dirname, "fixtures", "sample.js");
    const target = await lumine.workspace.open(file, { pane: targetPane });
    target.setText("independent target changes");
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    const commit = spyOn(lumine.workspaceDrops, "commit").and.resolveTo(true);
    const descriptor = remoteDescriptor({
      items: [{ type: "pane-item", uri: file, modifiedText: "source changes" }],
    });

    await expectAsync(
      scope.performDrop(context(), scope.prepareDrop(descriptor, targetPane)),
    ).toBeRejectedWithError("The target window already has unsaved changes for this file");
    expect(target.getText()).toBe("independent target changes");
    expect(open).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("restores an existing clean target after source rejection", async () => {
    const file = path.join(__dirname, "fixtures", "sample.js");
    const target = await lumine.workspace.open(file, { pane: targetPane });
    const originalText = target.getText();
    target.setSelectedBufferRange([
      [0, 1],
      [0, 3],
    ]);
    const originalState = target.serializeViewState();
    spyOn(lumine.workspaceDrops, "commit").and.resolveTo(false);
    const descriptor = remoteDescriptor({
      items: [{ type: "pane-item", uri: file, modifiedText: "source changes" }],
    });

    await expectAsync(
      scope.performDrop(context(), scope.prepareDrop(descriptor, targetPane)),
    ).toBeRejectedWithError("The source window rejected the pane item transfer");
    expect(target.getText()).toBe(originalText);
    expect(target.serializeViewState().selections).toEqual(originalState.selections);
    expect(lumine.workspace.paneForItem(target)).toBe(targetPane);
    target.undo();
    expect(target.getText()).toBe(originalText);
    expect(target.getFileState()).toBe("unmodified");
  });

  it("removes a newly staged item after source rejection", async () => {
    spyOn(lumine.workspaceDrops, "commit").and.resolveTo(false);
    const descriptor = remoteDescriptor();
    await expectAsync(
      scope.performDrop(context(), scope.prepareDrop(descriptor, targetPane)),
    ).toBeRejectedWithError("The source window rejected the pane item transfer");
    expect(lumine.workspace.getTextEditors()).toEqual([editor]);
    expect(lumine.window.focus).not.toHaveBeenCalled();
  });

  it("restores a clean buffer shared with an existing editor in another pane", async () => {
    const file = path.join(__dirname, "fixtures", "sample.js");
    const existing = await lumine.workspace.open(file, { pane });
    const originalText = existing.getText();
    existing.setSelectedBufferRange(
      [
        [1, 1],
        [2, 2],
      ],
      { reversed: true },
    );
    const originalState = existing.serializeViewState();
    expect(existing.getFileState()).toBe("unmodified");
    spyOn(lumine.workspaceDrops, "commit").and.callFake(async () => {
      expect(existing.getText()).toBe("remote source draft");
      return false;
    });
    const descriptor = remoteDescriptor({
      items: [{ type: "pane-item", uri: file, modifiedText: "remote source draft" }],
    });

    await expectAsync(
      scope.performDrop(context(), scope.prepareDrop(descriptor, targetPane)),
    ).toBeRejectedWithError("The source window rejected the pane item transfer");
    expect(existing.getText()).toBe(originalText);
    expect(existing.getFileState()).toBe("unmodified");
    expect(existing.isDestroyed()).toBe(false);
    expect(existing.serializeViewState().selections).toEqual(originalState.selections);
    expect(lumine.workspace.getTextEditors()).toEqual([editor, existing]);
    existing.undo();
    expect(existing.getText()).toBe(originalText);
    expect(existing.getFileState()).toBe("unmodified");
  });

  for (const shared of [false, true]) {
    it(`preserves cursor changes made while a ${shared ? "shared" : "reused"} target awaits a rejected commit`, async () => {
      const file = path.join(__dirname, "fixtures", "sample.js");
      const existing = await lumine.workspace.open(file, { pane: shared ? pane : targetPane });
      const originalText = existing.getText();
      existing.setSelectedBufferRange([
        [1, 1],
        [2, 2],
      ]);
      let resolveCommit;
      spyOn(lumine.workspaceDrops, "commit").and.returnValue(
        new Promise((resolve) => {
          resolveCommit = resolve;
        }),
      );
      const descriptor = remoteDescriptor({
        items: [
          {
            type: "pane-item",
            uri: file,
            modifiedText: "remote draft with different lines\nsecond row",
          },
        ],
      });
      const result = scope.performDrop(context(), scope.prepareDrop(descriptor, targetPane));
      await conditionPromise(() => lumine.workspaceDrops.commit.calls.any());
      existing.setSelectedBufferRange(
        [
          [0, 1],
          [0, 3],
        ],
        { reversed: true },
      );
      const userState = existing.serializeViewState();
      resolveCommit(false);
      await expectAsync(result).toBeRejectedWithError(
        "The source window rejected the pane item transfer",
      );
      expect(existing.getText()).toBe(originalText);
      expect(existing.serializeViewState().selections).toEqual(userState.selections);
      existing.undo();
      expect(existing.getText()).toBe(originalText);
    });
  }

  it("discards a late open when the target scope was disposed before commit", async () => {
    let resolveOpen;
    let opened;
    const originalOpen = lumine.workspace.open.bind(lumine.workspace);
    spyOn(lumine.workspace, "open").and.callFake(async (...args) => {
      opened = await originalOpen(...args);
      await new Promise((resolve) => {
        resolveOpen = resolve;
      });
      return opened;
    });
    const commit = spyOn(lumine.workspaceDrops, "commit").and.resolveTo(true);
    const descriptor = remoteDescriptor();
    const result = scope.performDrop(context(), scope.prepareDrop(descriptor, targetPane));
    await conditionPromise(() => resolveOpen);
    scope.dispose();
    resolveOpen();
    await expectAsync(result).toBeRejectedWithError("The pane item transfer was cancelled");
    expect(opened.isDestroyed()).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects a destination destroyed while its opener is pending", async () => {
    let resolveOpen;
    const created = lumine.workspace.buildTextEditor();
    pane.addItem(created);
    spyOn(lumine.workspace, "open").and.returnValue(
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    );
    const commit = spyOn(lumine.workspaceDrops, "commit").and.resolveTo(true);
    const descriptor = remoteDescriptor();
    const result = scope.performDrop(context(), scope.prepareDrop(descriptor, targetPane));
    targetPane.destroy();
    resolveOpen(created);
    await expectAsync(result).toBeRejectedWithError("The destination pane is no longer available");
    expect(commit).not.toHaveBeenCalled();
    // This was an existing item before the opener, so cancellation preserves it.
    expect(created.isDestroyed()).toBe(false);
  });

  it("retains an accepted destination after disposal during commit, without focusing it", async () => {
    let resolveCommit;
    spyOn(lumine.workspaceDrops, "commit").and.returnValue(
      new Promise((resolve) => {
        resolveCommit = resolve;
      }),
    );
    const descriptor = remoteDescriptor();
    const result = scope.performDrop(context(), scope.prepareDrop(descriptor, targetPane));
    await conditionPromise(() => lumine.workspaceDrops.commit.calls.any());
    const staged = targetPane.getItems()[0];
    scope.dispose();
    resolveCommit(true);
    expect((await result).item).toBe(staged);
    expect(staged.isDestroyed()).toBe(false);
    expect(staged.getText()).toBe("source text");
    expect(lumine.window.focus).not.toHaveBeenCalled();
  });

  it("does not destroy a source edited after its content was captured", async () => {
    editor.setText("captured");
    const descriptor = scope.createTransfer(pane, editor);
    editor.setText("new source edits");
    expect(await lumine.workspaceDrops.commit(descriptor.token)).toBe(false);
    expect(editor.isDestroyed()).toBe(false);
    expect(editor.getText()).toBe("new source edits");
  });

  it("rejects remote commit when a clean source file was removed without changing its text", async () => {
    const descriptor = scope.createTransfer(pane, editor);
    const originalText = editor.getText();
    spyOn(editor, "getFileState").and.returnValue("removed");

    expect(await lumine.workspaceDrops.commit(descriptor.token)).toBe(false);
    expect(editor.isDestroyed()).toBe(false);
    expect(editor.getText()).toBe(originalText);
    // A local move retains the live object, so its changed state remains safe.
    const localDescriptor = scope.createTransfer(pane, editor);
    editor.getFileState.and.returnValue("conflicted");
    scope.moveLocalItem(context(), scope.prepareDrop(localDescriptor, targetPane));
    expect(lumine.workspace.paneForItem(editor)).toBe(targetPane);
  });

  it("checks source ownership after asynchronous close listeners", async () => {
    let resumeClose;
    const subscription = lumine.workspace.onWillDestroyPaneItem(
      () =>
        new Promise((resolve) => {
          resumeClose = resolve;
        }),
    );
    const descriptor = scope.createTransfer(pane, editor);
    const result = lumine.workspaceDrops.commit(descriptor.token);
    await conditionPromise(() => resumeClose);
    scope.dispose();
    resumeClose();
    expect(await result).toBe(false);
    expect(editor.isDestroyed()).toBe(false);
    subscription.dispose();
  });

  it("keeps the source until a new window commits its staged copy", async () => {
    const result = scope.openInNewWindow(pane, editor);
    const descriptor = delegate.invokeApp.calls.mostRecent().args[1];
    expect(editor.isDestroyed()).toBe(false);
    expect(delegate.invokeApp).toHaveBeenCalledWith("openPaneItemInNewWindow", descriptor);
    expect(await lumine.workspaceDrops.commit(descriptor.token)).toBe(true);
    expect(await result).toEqual({ windowId: 22 });
    expect(editor.isDestroyed()).toBe(true);
  });

  it("keeps the source if creating the new window fails", async () => {
    delegate.invokeApp.and.rejectWith(new Error("window failed"));
    await expectAsync(scope.openInNewWindow(pane, editor)).toBeRejectedWithError("window failed");
    expect(editor.isDestroyed()).toBe(false);
    expect(scope.sessions.size).toBe(0);
  });

  it("uses core acknowledgement and source veto across two window transports", async () => {
    const listeners = new Map();
    const windowServiceFor = (id) => ({
      getId: () => id,
      onDidReceive(eventName, callback) {
        listeners.set(`${id}:${eventName}`, callback);
        return new Disposable(() => listeners.delete(`${id}:${eventName}`));
      },
      async broadcast(eventName, message) {
        for (const otherId of [1, 2]) {
          if (otherId !== id) await listeners.get(`${otherId}:${eventName}`)?.(message);
        }
      },
      focus: async () => {},
    });
    const sourceWindows = windowServiceFor(1);
    const targetWindows = windowServiceFor(2);
    const sourceDrops = new WorkspaceDropManager({ workspace: {}, windowService: sourceWindows });
    const targetDrops = new WorkspaceDropManager({ workspace: {}, windowService: targetWindows });
    sourceDrops.initialize();
    targetDrops.initialize();
    const sourceService = new PaneItemTransferService({
      workspace: lumine.workspace,
      workspaceDrops: sourceDrops,
      windowService: sourceWindows,
      applicationDelegate: {
        invokeApp: async (_action, descriptor) => {
          await targetService.acceptInitialTransfer(descriptor);
          return 2;
        },
      },
    });
    const targetService = new PaneItemTransferService({
      workspace: lumine.workspace,
      workspaceDrops: targetDrops,
      windowService: targetWindows,
    });
    const veto = lumine.workspace.onWillDestroyPaneItem(({ item, prevent }) => {
      if (item === editor) prevent();
    });
    const sourceScope = sourceService.createScope();
    try {
      await expectAsync(sourceScope.openInNewWindow(pane, editor)).toBeRejectedWithError(
        "The source window rejected the pane item transfer",
      );
      expect(editor.isDestroyed()).toBe(false);
      expect(lumine.workspace.getTextEditors()).toEqual([editor]);
    } finally {
      veto.dispose();
      sourceService.destroy();
      targetService.destroy();
      sourceDrops.destroy();
      targetDrops.destroy();
    }
  });
});
