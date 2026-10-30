const path = require("node:path");
const CSON = require("@lumine-code/season");
const { ipcRenderer } = require("electron");
const { buildKeydownEvent } = require("./keymap-spec-helpers/helpers");

describe("dialog action keyboard activation", () => {
  let host, bindings;

  beforeEach(() => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    bindings = lumine.keymaps.add(
      "dialog-action-keyboard-spec",
      CSON.readFileSync(path.join(__dirname, "../keymaps/base.json")),
    );
  });

  afterEach(async () => {
    await host?.destroy();
    bindings.dispose();
  });

  async function createDialog() {
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    actions.append(cancel);
    host = lumine.workspace.addInputDialog({ contentElement: actions });
    const confirmed = jasmine.createSpy("confirmed");
    const cancelled = jasmine.createSpy("cancelled");
    host.getModel().onDidConfirm(confirmed);
    host.onDidCancel(cancelled);
    cancel.addEventListener("click", () => host.cancel());
    await host.show();
    cancel.focus();
    return { cancel, confirmed, cancelled };
  }

  it("preserves native Enter on Cancel instead of dispatching the primary action", async () => {
    const { cancel, confirmed } = await createDialog();
    const keydown = buildKeydownEvent({ key: "Enter", target: cancel });
    lumine.keymaps.handleKeyboardEvent(keydown);
    expect(keydown.defaultPrevented).toBe(false);
    expect(confirmed).not.toHaveBeenCalled();
    expect(host.isVisible()).toBe(true);
  });

  jasmine.itWithDocumentFocus("activates the focused Cancel with a real Enter key", async () => {
    const { confirmed, cancelled } = await createDialog();
    for (const type of ["keyDown", "keyUp"]) {
      await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
        type,
        keyCode: "Enter",
      });
    }
    await conditionPromise(() => !host.isVisible());
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(confirmed).not.toHaveBeenCalled();
  });
});
