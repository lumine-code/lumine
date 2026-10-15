describe("Window participant registration lifetime", () => {
  let registrations, item, root, localRegistry;

  beforeEach(async () => {
    registrations = [];
    jasmine.attachToDOM(lumine.workspace.getElement());
    root = document.createElement("div");
    item = { element: root, getTitle: () => "Participant lifetime" };
    await lumine.workspace.open(item);
  });

  afterEach(async () => {
    for (const registration of registrations) registration.dispose();
    localRegistry?.clear();
    localRegistry = null;
    await lumine.workspace.discardEditorWindows();
  });

  it("does not let a retired registration remove its replacement after registry reset", async () => {
    const ViewRegistry = require("../src/view-registry");
    localRegistry = new ViewRegistry(lumine);
    const prepare = jasmine.createSpy("current participant preparation");
    const participant = { prepareWindowChange: prepare };
    const first = localRegistry.addWindowParticipant(root, participant);
    registrations.push(first);
    localRegistry.clear();
    registrations.push(localRegistry.addWindowParticipant(root, participant));
    first.dispose();
    const state = await localRegistry.preparePaneItemWindowChange(item, {});
    state.dispose();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("binds a replacement in its current window and follows its return to the main window", async () => {
    const first = lumine.views.addWindowParticipant(root, {});
    registrations.push(first);
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    await lumine.workspace.movePaneItem(item, {
      targetPane: extra.getEditorContainer().getActivePane(),
    });
    first.dispose();
    const attached = jasmine.createSpy("replacement windows");
    registrations.push(lumine.views.addWindowParticipant(root, { didAttachToWindow: attached }));
    expect(attached.calls.mostRecent().args[0].window).toBe(extra);
    await lumine.workspace.attachWindow(extra);
    expect(attached.calls.mostRecent().args[0].window).toBe(lumine.workspace.getMainWindow());
    expect(attached).toHaveBeenCalledTimes(2);
  });

  it("binds a replacement participant on the same live root", () => {
    const first = lumine.views.addWindowParticipant(root, { didAttachToWindow() {} });
    registrations.push(first);
    first.dispose();
    const attached = jasmine.createSpy("replacement attach");
    registrations.push(lumine.views.addWindowParticipant(root, { didAttachToWindow: attached }));
    expect(attached).toHaveBeenCalledOnceWith({
      window: lumine.workspace.getMainWindow(),
      document,
    });
  });

  it("allows recovery when the initial presentation binding throws", () => {
    expect(() =>
      lumine.views.addWindowParticipant(root, {
        didAttachToWindow() {
          throw new Error("Presentation failed");
        },
      }),
    ).toThrowError("Presentation failed");
    const attached = jasmine.createSpy("recovered attach");
    registrations.push(lumine.views.addWindowParticipant(root, { didAttachToWindow: attached }));
    expect(attached).toHaveBeenCalled();
  });
});
