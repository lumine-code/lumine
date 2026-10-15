describe("Repository freshness in editor windows", () => {
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });

  it("refreshes shared repository snapshots when an auxiliary window receives focus", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const refresh = spyOn(lumine.repositories, "handleWindowFocus");
    const window = extra.getDOMWindow();
    window.dispatchEvent(new window.Event("focus"));
    expect(refresh).toHaveBeenCalled();
  });
});
