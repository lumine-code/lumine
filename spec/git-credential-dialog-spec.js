const { promptForGitCredential } = require("../src/git-credential-dialog");

describe("Git credential dialog", () => {
  let workspaceElement;
  let panel;

  beforeEach(() => {
    workspaceElement = lumine.workspace.getElement();
    jasmine.attachToDOM(workspaceElement);
    panel = null;
  });

  afterEach(() => {
    panel?.destroy();
  });

  function prompt(options) {
    const result = promptForGitCredential({ prompt: "Password:" }, options);
    panel = lumine.workspace
      .getModalPanels()
      .find((candidate) => candidate.getElement().querySelector(".git-credential-dialog"));
    return result;
  }

  it("cancels the pending request without closing the document behind it", async () => {
    const editor = await lumine.workspace.open();
    const result = prompt();
    const cancelled = expectAsync(result).toBeRejectedWithError(
      "Git credential prompt was cancelled",
    );
    const input = panel.getElement().querySelector("input");

    lumine.commands.dispatch(input, "core:cancel");

    await cancelled;
    expect(panel.destroyed).toBe(true);
    expect(editor.isDestroyed()).toBe(false);
    expect(lumine.workspace.getModalPanels()).not.toContain(panel);
  });

  it("settles a pending request when its panel is hidden", async () => {
    const result = prompt();
    const cancelled = expectAsync(result).toBeRejectedWithError(
      "Git credential prompt was cancelled",
    );

    panel.hide();

    await cancelled;
    expect(panel.destroyed).toBe(true);
  });

  it("settles a pending request when its panel is destroyed", async () => {
    const result = prompt();
    const cancelled = expectAsync(result).toBeRejectedWithError(
      "Git credential prompt was cancelled",
    );

    panel.destroy();

    await cancelled;
  });

  it("returns credentials once and removes its command listeners", async () => {
    const result = prompt();
    const input = panel.getElement().querySelector("input");
    input.value = "secret";

    lumine.commands.dispatch(input, "core:confirm");

    await expectAsync(result).toBeResolvedTo({ password: "secret" });
    expect(panel.destroyed).toBe(true);
    expect(lumine.commands.findCommands({ target: input }).map(({ name }) => name)).not.toContain(
      "core:cancel",
    );
  });

  it("closes the prompt when the Git operation is aborted", async () => {
    const controller = new AbortController();
    const result = prompt({ signal: controller.signal });
    const failure = new Error("Git operation cancelled");
    const cancelled = expectAsync(result).toBeRejectedWith(failure);
    controller.abort(failure);
    await cancelled;
    expect(panel.destroyed).toBe(true);
  });

  it("does not open a dialog for an already cancelled operation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Git operation cancelled"));
    const result = prompt({ signal: controller.signal });
    await expectAsync(result).toBeRejectedWith(controller.signal.reason);
    expect(panel).toBeUndefined();
  });
});
