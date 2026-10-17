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
    spyOn(document, "hasFocus").and.returnValue(true);
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

  it("keeps secondary documents outside the native renderer keyboard bridge", () => {
    const rendererBridge = lumine.keymaps.frameKeyboardBridge;
    const secondaryHandler = new WindowEventHandler({
      lumineEnvironment: lumine,
      applicationDelegate: lumine.applicationDelegate,
    });
    try {
      secondaryHandler.initialize(window, document.implementation.createHTMLDocument());
      expect(secondaryHandler.frameKeyboardBridge).toBeUndefined();
      expect(lumine.keymaps.frameKeyboardBridge).toBe(rendererBridge);
    } finally {
      secondaryHandler.unsubscribe();
    }
    expect(lumine.keymaps.frameKeyboardBridge).toBe(rendererBridge);
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

  describe("native caption mouse input", () => {
    const { ipcRenderer } = require("electron");
    const notify = (windowId, position) =>
      ipcRenderer.emit("did-mouse-down-in-window", {}, { windowId, position });
    const presentation = (id, domWindow) => ({
      getId: () => id,
      getDOMWindow: () => domWindow,
      isDestroyed: () => false,
    });
    const auxiliaryDOMWindow = ({ target = null, devicePixelRatio = 1 } = {}) => {
      const domWindow = new EventTarget();
      domWindow.Event = class extends Event {};
      domWindow.devicePixelRatio = devicePixelRatio;
      domWindow.document = {
        elementFromPoint: jasmine.createSpy("elementFromPoint").and.returnValue(target),
      };
      domWindow.getComputedStyle = (element) => window.getComputedStyle(element);
      return domWindow;
    };

    afterEach(() => {
      // Environment cleanup needs the real presentation registry before
      // Jasmine restores this spec's spies.
      lumine.workspace.getWindows.and.callThrough();
    });

    it("routes main-window caption input without dispatching or cancelling DOM mouse input", () => {
      const auxiliary = auxiliaryDOMWindow();
      spyOn(lumine.workspace, "getWindows").and.returnValue([
        presentation(17, window),
        presentation(-18, auxiliary),
      ]);
      const caption = jasmine.createSpy("caption");
      const mouseDown = jasmine.createSpy("mouseDown");
      const auxiliaryCaption = jasmine.createSpy("auxiliaryCaption");
      window.addEventListener("lumine:native-caption-mousedown", caption);
      window.addEventListener("mousedown", mouseDown);
      auxiliary.addEventListener("lumine:native-caption-mousedown", auxiliaryCaption);
      try {
        notify(17);

        expect(caption.calls.count()).toBe(1);
        const event = caption.calls.mostRecent().args[0];
        expect(event.target).toBe(window);
        expect(event.bubbles).toBe(false);
        expect(event.cancelable).toBe(false);
        expect(event.defaultPrevented).toBe(false);
        expect(mouseDown).not.toHaveBeenCalled();
        expect(auxiliaryCaption).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("lumine:native-caption-mousedown", caption);
        window.removeEventListener("mousedown", mouseDown);
      }
    });

    it("routes auxiliary caption input only to the matching presentation using its Event constructor", () => {
      const auxiliary = auxiliaryDOMWindow();
      spyOn(lumine.workspace, "getWindows").and.returnValue([
        presentation(17, window),
        presentation(-18, auxiliary),
      ]);
      const mainCaption = jasmine.createSpy("mainCaption");
      const caption = jasmine.createSpy("caption");
      window.addEventListener("lumine:native-caption-mousedown", mainCaption);
      auxiliary.addEventListener("lumine:native-caption-mousedown", caption);
      try {
        notify(-18);

        expect(caption.calls.count()).toBe(1);
        expect(caption.calls.mostRecent().args[0] instanceof auxiliary.Event).toBe(true);
        expect(caption.calls.mostRecent().args[0].target).toBe(auxiliary);
        expect(mainCaption).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("lumine:native-caption-mousedown", mainCaption);
      }
    });

    for (const devicePixelRatio of [1, 1.25, 2.5]) {
      it(`hit-tests physical mouse coordinates in CSS pixels at effective scale ${devicePixelRatio}`, () => {
        const titleBar = document.createElement("div");
        titleBar.style.setProperty("app-region", "drag");
        const title = titleBar.appendChild(document.createElement("span"));
        document.body.appendChild(titleBar);
        const auxiliary = auxiliaryDOMWindow({ target: title, devicePixelRatio });
        spyOn(lumine.workspace, "getWindows").and.returnValue([presentation(-18, auxiliary)]);
        const caption = jasmine.createSpy("caption");
        auxiliary.addEventListener("lumine:native-caption-mousedown", caption);
        try {
          // The effective ratio includes both monitor DPI and page zoom.
          notify(-18, { x: 240 * devicePixelRatio, y: 32 * devicePixelRatio });

          expect(auxiliary.document.elementFromPoint).toHaveBeenCalledWith(240, 32);
          expect(caption.calls.count()).toBe(1);
          expect(caption.calls.mostRecent().args[0] instanceof auxiliary.Event).toBe(true);
        } finally {
          titleBar.remove();
        }
      });
    }

    it("excludes a no-drag ancestor even when a nested element declares drag", () => {
      const titleBar = document.createElement("div");
      titleBar.style.setProperty("app-region", "drag");
      const controls = titleBar.appendChild(document.createElement("div"));
      controls.style.setProperty("app-region", "no-drag");
      const button = controls.appendChild(document.createElement("button"));
      button.style.setProperty("app-region", "drag");
      const icon = button.appendChild(document.createElement("span"));
      document.body.appendChild(titleBar);
      const auxiliary = auxiliaryDOMWindow({ target: icon });
      spyOn(lumine.workspace, "getWindows").and.returnValue([presentation(-18, auxiliary)]);
      const caption = jasmine.createSpy("caption");
      auxiliary.addEventListener("lumine:native-caption-mousedown", caption);
      try {
        notify(-18, { x: 240, y: 32 });

        expect(auxiliary.document.elementFromPoint).toHaveBeenCalledWith(240, 32);
        expect(caption).not.toHaveBeenCalled();
      } finally {
        titleBar.remove();
      }
    });

    it("ignores client clicks outside an element or in ordinary editor content", () => {
      const editor = document.createElement("div");
      editor.classList.add("editor");
      const text = editor.appendChild(document.createElement("span"));
      document.body.appendChild(editor);
      const auxiliary = auxiliaryDOMWindow();
      spyOn(lumine.workspace, "getWindows").and.returnValue([presentation(-18, auxiliary)]);
      const caption = jasmine.createSpy("caption");
      auxiliary.addEventListener("lumine:native-caption-mousedown", caption);
      try {
        notify(-18, { x: 240, y: 80 });
        auxiliary.document.elementFromPoint.and.returnValue(text);
        notify(-18, { x: 240, y: 80 });

        expect(caption).not.toHaveBeenCalled();
      } finally {
        editor.remove();
      }
    });

    it("uses only the matching window's document and scale for client clicks", () => {
      const titleBar = document.createElement("div");
      titleBar.style.setProperty("app-region", "drag");
      document.body.appendChild(titleBar);
      const first = auxiliaryDOMWindow({ target: titleBar, devicePixelRatio: 1 });
      const second = auxiliaryDOMWindow({ target: titleBar, devicePixelRatio: 2 });
      spyOn(lumine.workspace, "getWindows").and.returnValue([
        presentation(-18, first),
        presentation(-19, second),
      ]);
      const firstCaption = jasmine.createSpy("firstCaption");
      const secondCaption = jasmine.createSpy("secondCaption");
      first.addEventListener("lumine:native-caption-mousedown", firstCaption);
      second.addEventListener("lumine:native-caption-mousedown", secondCaption);
      try {
        notify(-19, { x: 480, y: 64 });

        expect(first.document.elementFromPoint).not.toHaveBeenCalled();
        expect(firstCaption).not.toHaveBeenCalled();
        expect(second.document.elementFromPoint).toHaveBeenCalledWith(240, 32);
        expect(secondCaption.calls.count()).toBe(1);
      } finally {
        titleBar.remove();
      }
    });

    it("ignores unknown, destroyed and closed presentations", () => {
      const destroyed = auxiliaryDOMWindow();
      const closed = auxiliaryDOMWindow();
      closed.closed = true;
      spyOn(lumine.workspace, "getWindows").and.returnValue([
        { ...presentation(-18, destroyed), isDestroyed: () => true },
        presentation(-19, closed),
        presentation(-20, null),
      ]);
      const caption = jasmine.createSpy("caption");
      destroyed.addEventListener("lumine:native-caption-mousedown", caption);
      closed.addEventListener("lumine:native-caption-mousedown", caption);

      for (const id of [-18, -19, -20, 999]) expect(() => notify(id)).not.toThrow();

      expect(caption).not.toHaveBeenCalled();
    });

    it("unsubscribes from native caption input when disposed", () => {
      const auxiliary = auxiliaryDOMWindow();
      spyOn(lumine.workspace, "getWindows").and.returnValue([presentation(-18, auxiliary)]);
      const caption = jasmine.createSpy("caption");
      auxiliary.addEventListener("lumine:native-caption-mousedown", caption);

      windowEventHandler.unsubscribe();
      notify(-18);

      expect(caption).not.toHaveBeenCalled();
    });
  });

  describe("when the window is loaded", () =>
    it("doesn't have .is-blurred on the body tag", () => {
      expect(document.body.className).not.toMatch("is-blurred");
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

  describe("window reload lifecycle", () => {
    const { ipcRenderer } = require("electron");

    beforeEach(() => {
      spyOn(lumine.window, "isSpecMode").and.returnValue(false);
      spyOn(lumine, "storeWindowDimensions");
      spyOn(lumine, "unloadEditorWindow");
      spyOn(lumine, "destroy");
    });

    it("keeps a focused window visible when the main process commits a reload", () => {
      ipcRenderer.emit("will-reload-window", {});

      windowEventHandler.handleWindowBeforeunload();

      expect(lumine.window.hide).not.toHaveBeenCalled();
      expect(lumine.unloadEditorWindow).toHaveBeenCalled();
      expect(lumine.destroy).toHaveBeenCalled();
      expect(windowEventHandler.reloadRequested).toBe(false);
    });

    it("still hides a focused window when it closes", () => {
      windowEventHandler.handleWindowBeforeunload();

      expect(lumine.window.hide).toHaveBeenCalled();
    });

    it("does not mark a requested reload before the main process accepts it", async () => {
      spyOn(lumine.window, "reload").and.returnValue(Promise.resolve());

      window.dispatchEvent(new CustomEvent("window:reload"));
      await Promise.resolve();

      expect(lumine.window.reload).toHaveBeenCalled();
      expect(windowEventHandler.reloadRequested).toBe(false);
      windowEventHandler.handleWindowBeforeunload();
      expect(lumine.window.hide).toHaveBeenCalled();
    });

    it("stops observing reloads when disposed", () => {
      windowEventHandler.unsubscribe();

      ipcRenderer.emit("will-reload-window", {});

      expect(windowEventHandler.reloadRequested).toBe(false);
    });
  });

  describe("when a link is clicked", () => {
    it("opens the http, https, and mailto links in an external application", () => {
      spyOn(lumine.shell, "openExternal").and.returnValue(Promise.resolve());

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
      expect(lumine.shell.openExternal).toHaveBeenCalled();
      expect(lumine.shell.openExternal.calls.argsFor(0)[0]).toBe("http://github.com");
      lumine.shell.openExternal.calls.reset();

      link.href = "https://github.com";
      windowEventHandler.handleLinkClick(fakeEvent);
      expect(lumine.shell.openExternal).toHaveBeenCalled();
      expect(lumine.shell.openExternal.calls.argsFor(0)[0]).toBe("https://github.com");
      lumine.shell.openExternal.calls.reset();

      link.href = "mailto:issues@example.com";
      windowEventHandler.handleLinkClick(fakeEvent);
      expect(lumine.shell.openExternal).toHaveBeenCalledWith("mailto:issues@example.com");
      lumine.shell.openExternal.calls.reset();

      link.href = "";
      windowEventHandler.handleLinkClick(fakeEvent);
      expect(lumine.shell.openExternal).not.toHaveBeenCalled();
      lumine.shell.openExternal.calls.reset();

      link.href = "#scroll-me";
      windowEventHandler.handleLinkClick(fakeEvent);
      expect(lumine.shell.openExternal).not.toHaveBeenCalled();
    });

    it("warns when the operating system cannot open an external link", async () => {
      const error = new Error("No browser is available");
      spyOn(lumine.shell, "openExternal").and.returnValue(Promise.reject(error));
      spyOn(lumine.notifications, "addWarning");
      const link = document.createElement("a");
      link.href = "https://example.com";

      windowEventHandler.handleLinkClick({ currentTarget: link, preventDefault() {} });
      await Promise.resolve();

      expect(lumine.notifications.addWarning).toHaveBeenCalledWith("Unable to open external link", {
        detail: error.message,
        dismissable: true,
      });
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
