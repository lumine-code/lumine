describe("Window creation during orderly unload", () => {
  afterEach(async () => {
    lumine.workspace.windowLifecycleChanging = false;
    await lumine.workspace.discardEditorWindows();
  });

  it("rejects new presentations after the unload drain has begun", async () => {
    await lumine.workspace.whenWindowOperationsIdle();
    await expectAsync(lumine.workspace.openEditorWindow({ show: false })).toBeRejectedWithError(
      "The workspace windows are preparing to unload.",
    );
  });

  it("allows an already scheduled detach to finish while rejecting unrelated opens", async () => {
    const workspace = lumine.workspace;
    await workspace.open();
    const detached = workspace.detachPane(workspace.getActivePane());
    const drained = workspace.whenWindowOperationsIdle();
    const extra = await detached;
    await drained;
    expect(extra.getEditorContainer().getPaneItems()).toHaveSize(1);
    await expectAsync(workspace.openEditorWindow({ show: false })).toBeRejectedWithError(
      "The workspace windows are preparing to unload.",
    );
  });
});
