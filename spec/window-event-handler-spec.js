const KeymapManager = require("../src/keymap-manager");
const WindowEventHandler = require("../src/window-event-handler");

describe("WindowEventHandler", () => {
  let windowEventHandler;

  beforeEach(() => {
    lumine.uninstallWindowEventHandler();
    spyOn(lumine.window, "hide");
    // Initialization must reconcile stale visual state with the document's
    // current focus rather than waiting for another focus event.
    document.body.classList.add("is-blurred");
    windowEventHandler = new WindowEventHandler({
      lumineEnvironment: lumine,
      applicationDelegate: lumine.applicationDelegate,
    });
    windowEventHandler.initialize(window, document);
  });

  afterEach(() => {
    windowEventHandler.unsubscribe();
    lumine.installWindowEventHandler();
  });

  it("marks an unhandled drag as unavailable", () => {
    const event = {
      dataTransfer: { dropEffect: "move" },
      preventDefault: jasmine.createSpy("preventDefault"),
      stopPropagation: jasmine.createSpy("stopPropagation"),
    };

    windowEventHandler.handleDragover(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(event.dataTransfer.dropEffect).toBe("none");
  });

  describe("when the window is loaded", () =>
    it("doesn't have .is-blurred on the body tag", (done) => {
      jasmine.filterByPlatform({ except: ["win32"] }, done); // Win32TestFailures - can not steal focus
      expect(document.body.className).not.toMatch("is-blurred");

      done();
    }));

  describe("when the window is blurred", () => {
    beforeEach(() => window.dispatchEvent(new CustomEvent("blur")));

    afterEach(() => document.body.classList.remove("is-blurred"));

    it("adds the .is-blurred class on the body", () =>
      expect(document.body.className).toMatch("is-blurred"));

    describe("when the window is focused again", () =>
      it("removes the .is-blurred class from the body", () => {
        window.dispatchEvent(new CustomEvent("focus"));
        expect(document.body.className).not.toMatch("is-blurred");
      }));
  });

  describe("resize event", () =>
    it("calls storeWindowDimensions", (done) => {
      jasmine.useRealClock();

      spyOn(lumine, "storeWindowDimensions").and.callFake(() => {
        done();
      });
      window.dispatchEvent(new CustomEvent("resize"));
    }));

  describe("window:close event", () =>
    it("closes the window", () => {
      spyOn(lumine.window, "close");
      window.dispatchEvent(new CustomEvent("window:close"));
      expect(lumine.window.close).toHaveBeenCalled();
    }));

  describe("when a link is clicked", () => {
    it("opens the http/https links in an external application", () => {
      spyOn(lumine.applicationDelegate, "openExternal");

      const link = document.createElement("a");
      const linkChild = document.createElement("span");
      link.appendChild(linkChild);
      link.href = "http://github.com";
      jasmine.attachToDOM(link);
      const fakeEvent = {
        target: linkChild,
        currentTarget: link,
        preventDefault: () => {},
      };

      windowEventHandler.handleLinkClick(fakeEvent);
      expect(lumine.applicationDelegate.openExternal).toHaveBeenCalled();
      expect(lumine.applicationDelegate.openExternal.calls.argsFor(0)[0]).toBe("http://github.com");
      lumine.applicationDelegate.openExternal.calls.reset();

      link.href = "https://github.com";
      windowEventHandler.handleLinkClick(fakeEvent);
      expect(lumine.applicationDelegate.openExternal).toHaveBeenCalled();
      expect(lumine.applicationDelegate.openExternal.calls.argsFor(0)[0]).toBe(
        "https://github.com",
      );
      lumine.applicationDelegate.openExternal.calls.reset();

      link.href = "";
      windowEventHandler.handleLinkClick(fakeEvent);
      expect(lumine.applicationDelegate.openExternal).not.toHaveBeenCalled();
      lumine.applicationDelegate.openExternal.calls.reset();

      link.href = "#scroll-me";
      windowEventHandler.handleLinkClick(fakeEvent);
      expect(lumine.applicationDelegate.openExternal).not.toHaveBeenCalled();
    });

    it('opens the "lumine://" links with URL handler', () => {
      const uriHandler = windowEventHandler.lumineEnvironment.uriHandlers;
      expect(uriHandler).toBeDefined();
      spyOn(uriHandler, "handleURI");

      const link = document.createElement("a");
      const linkChild = document.createElement("span");
      link.appendChild(linkChild);
      link.href = "lumine://github.com";
      jasmine.attachToDOM(link);
      const fakeEvent = {
        target: linkChild,
        currentTarget: link,
        preventDefault: () => {},
      };

      windowEventHandler.handleLinkClick(fakeEvent);
      expect(uriHandler.handleURI).toHaveBeenCalled();
      expect(uriHandler.handleURI.calls.argsFor(0)[0]).toBe("lumine://github.com");
    });
  });

  describe("when a form is submitted", () =>
    it("prevents the default so that the window's URL isn't changed", () => {
      const form = document.createElement("form");
      jasmine.attachToDOM(form);

      let defaultPrevented = false;
      const event = new CustomEvent("submit", { bubbles: true });
      event.preventDefault = () => {
        defaultPrevented = true;
      };
      form.dispatchEvent(event);
      expect(defaultPrevented).toBe(true);
    }));

  describe("core:focus-next and core:focus-previous", () => {
    describe("when there is no currently focused element", () =>
      it("focuses the element with the lowest/highest tabindex", () => {
        const wrapperDiv = document.createElement("div");
        wrapperDiv.innerHTML = `
          <div>
            <button tabindex="2"></button>
            <input tabindex="1">
          </div>
        `.trim();
        const elements = wrapperDiv.firstChild;
        jasmine.attachToDOM(elements);

        elements.dispatchEvent(new CustomEvent("core:focus-next", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(1);

        document.body.focus();
        elements.dispatchEvent(new CustomEvent("core:focus-previous", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(2);
      }));

    describe("when a tabindex is set on the currently focused element", () =>
      it("focuses the element with the next highest/lowest tabindex, skipping disabled elements", () => {
        const wrapperDiv = document.createElement("div");
        wrapperDiv.innerHTML = `
          <div>
            <input tabindex="1">
            <button tabindex="2"></button>
            <button tabindex="5"></button>
            <input tabindex="-1">
            <input tabindex="3">
            <button tabindex="7"></button>
            <input tabindex="9" disabled>
          </div>
        `.trim();
        const elements = wrapperDiv.firstChild;
        jasmine.attachToDOM(elements);

        elements.querySelector('[tabindex="1"]').focus();

        elements.dispatchEvent(new CustomEvent("core:focus-next", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(2);

        elements.dispatchEvent(new CustomEvent("core:focus-next", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(3);

        elements.dispatchEvent(new CustomEvent("core:focus-next", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(5);

        elements.dispatchEvent(new CustomEvent("core:focus-next", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(7);

        elements.dispatchEvent(new CustomEvent("core:focus-next", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(1);

        elements.dispatchEvent(new CustomEvent("core:focus-previous", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(7);

        elements.dispatchEvent(new CustomEvent("core:focus-previous", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(5);

        elements.dispatchEvent(new CustomEvent("core:focus-previous", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(3);

        elements.dispatchEvent(new CustomEvent("core:focus-previous", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(2);

        elements.dispatchEvent(new CustomEvent("core:focus-previous", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(1);

        elements.dispatchEvent(new CustomEvent("core:focus-previous", { bubbles: true }));
        expect(document.activeElement.tabIndex).toBe(7);
      }));
  });

  describe("when keydown events occur on the document", () =>
    it("dispatches the event via the KeymapManager and CommandRegistry", () => {
      const dispatchedCommands = [];
      lumine.commands.onWillDispatch((command) => dispatchedCommands.push(command));
      lumine.commands.add("*", { "foo-command": () => {} });
      lumine.keymaps.add("source-name", { "*": { x: "foo-command" } });

      const event = KeymapManager.buildKeydownEvent("x", {
        target: document.createElement("div"),
      });
      document.dispatchEvent(event);

      expect(dispatchedCommands.length).toBe(1);
      expect(dispatchedCommands[0].type).toBe("foo-command");
    }));

  describe("native key bindings", () =>
    it("correctly dispatches them to active elements with the '.native-key-bindings' class", () => {
      spyOn(lumine.applicationDelegate, "performWebContentsAction");

      const nativeKeyBindingsInput = document.createElement("input");
      nativeKeyBindingsInput.classList.add("native-key-bindings");
      jasmine.attachToDOM(nativeKeyBindingsInput);
      nativeKeyBindingsInput.focus();

      lumine.dispatchApplicationMenuCommand("core:copy");
      lumine.dispatchApplicationMenuCommand("core:paste");

      expect(lumine.applicationDelegate.performWebContentsAction).toHaveBeenCalledWith("copy");
      expect(lumine.applicationDelegate.performWebContentsAction).toHaveBeenCalledWith("paste");

      lumine.applicationDelegate.performWebContentsAction.calls.reset();

      const normalInput = document.createElement("input");
      jasmine.attachToDOM(normalInput);
      normalInput.focus();

      lumine.dispatchApplicationMenuCommand("core:copy");
      lumine.dispatchApplicationMenuCommand("core:paste");

      expect(lumine.applicationDelegate.performWebContentsAction).not.toHaveBeenCalled();
    }));
});
