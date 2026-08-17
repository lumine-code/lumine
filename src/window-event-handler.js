const { Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const listen = require("./delegated-listener");
const { debounce } = require("@lumine-code/underscore-plus");

// Handles low-level events related to the `window`.
module.exports = class WindowEventHandler {
  constructor({ lumineEnvironment, applicationDelegate }) {
    this.handleDocumentKeyEvent = this.handleDocumentKeyEvent.bind(this);
    this.handleFocusNext = this.handleFocusNext.bind(this);
    this.handleFocusPrevious = this.handleFocusPrevious.bind(this);
    this.handleWindowBlur = this.handleWindowBlur.bind(this);
    this.handleWindowResize = this.handleWindowResize.bind(this);
    this.handleEnterFullScreen = this.handleEnterFullScreen.bind(this);
    this.handleLeaveFullScreen = this.handleLeaveFullScreen.bind(this);
    this.handleWindowBeforeunload = this.handleWindowBeforeunload.bind(this);
    this.handleWindowToggleFullScreen = this.handleWindowToggleFullScreen.bind(this);
    this.handleWindowClose = this.handleWindowClose.bind(this);
    this.handleWindowReload = this.handleWindowReload.bind(this);
    this.handleWindowToggleDevTools = this.handleWindowToggleDevTools.bind(this);
    this.handleWindowToggleMenuBar = this.handleWindowToggleMenuBar.bind(this);
    this.handleLinkClick = this.handleLinkClick.bind(this);
    this.handleDocumentContextmenu = this.handleDocumentContextmenu.bind(this);
    this.lumineEnvironment = lumineEnvironment;
    this.applicationDelegate = applicationDelegate;
    this.reloadRequested = false;
    this.subscriptions = new CompositeDisposable();

    this.handleNativeKeybindings();
  }

  initialize(window, document) {
    this.window = window;
    this.document = document;
    // Derive the initial visual state from the document instead of inheriting
    // a stale class when focus changed before this handler was installed. Some
    // embedders supply a minimal document-like object without `hasFocus`; keep
    // the historical behavior for those custom documents.
    if (typeof this.document.hasFocus === "function") {
      this.document.body.classList.toggle("is-blurred", !this.document.hasFocus());
    }
    this.subscriptions.add(
      this.lumineEnvironment.commands.add(this.window, {
        "window:toggle-full-screen": this.handleWindowToggleFullScreen,
        "window:close": this.handleWindowClose,
        "window:reload": this.handleWindowReload,
        "window:toggle-dev-tools": this.handleWindowToggleDevTools,
      }),
    );

    if (["win32", "linux"].includes(process.platform)) {
      this.subscriptions.add(
        this.lumineEnvironment.commands.add(this.window, {
          "window:toggle-menu-bar": this.handleWindowToggleMenuBar,
        }),
      );
    }

    this.subscriptions.add(
      this.lumineEnvironment.commands.add(this.document, {
        "core:focus-next": {
          description: "Move focus to the next element that accepts it, not the next pane.",
          didDispatch: this.handleFocusNext,
        },
        "core:focus-previous": {
          description: "Move focus back to the previous element that accepts it.",
          didDispatch: this.handleFocusPrevious,
        },
      }),
    );

    this.addEventListener(this.window, "beforeunload", this.handleWindowBeforeunload);
    this.addEventListener(this.window, "focus", this.handleWindowFocus);
    this.addEventListener(this.window, "blur", this.handleWindowBlur);
    this.addEventListener(this.window, "resize", debounce(this.handleWindowResize, 500));

    this.addEventListener(this.document, "keyup", this.handleDocumentKeyEvent);
    this.addEventListener(this.document, "keydown", this.handleDocumentKeyEvent);
    this.addEventListener(this.document, "drop", this.handleDocumentDrop);
    this.addEventListener(this.document, "dragover", this.handleDocumentDragover);
    this.addEventListener(this.document, "contextmenu", this.handleDocumentContextmenu);
    this.subscriptions.add(listen(this.document, "click", "a", this.handleLinkClick));
    this.subscriptions.add(listen(this.document, "submit", "form", this.handleFormSubmit));

    this.subscriptions.add(
      this.applicationDelegate.onDidEnterFullScreen(this.handleEnterFullScreen),
    );
    this.subscriptions.add(
      this.applicationDelegate.onDidLeaveFullScreen(this.handleLeaveFullScreen),
    );
  }

  // Wire commands that should be handled by Chromium for elements with the
  // `.native-key-bindings` class.
  handleNativeKeybindings() {
    const bindCommandToAction = (command, action) => {
      this.subscriptions.add(
        this.lumineEnvironment.commands.add(
          ".native-key-bindings",
          command,
          (_event) => this.applicationDelegate.performWebContentsAction(action),
          false,
        ),
      );
    };

    bindCommandToAction("core:copy", "copy");
    bindCommandToAction("core:paste", "paste");
    bindCommandToAction("core:undo", "undo");
    bindCommandToAction("core:redo", "redo");
    bindCommandToAction("core:select-all", "selectAll");
    bindCommandToAction("core:cut", "cut");
  }

  unsubscribe() {
    this.subscriptions.dispose();
  }

  on(target, eventName, handler) {
    target.on(eventName, handler);
    this.subscriptions.add(
      new Disposable(function () {
        target.removeListener(eventName, handler);
      }),
    );
  }

  addEventListener(target, eventName, handler) {
    target.addEventListener(eventName, handler);
    this.subscriptions.add(
      new Disposable(function () {
        target.removeEventListener(eventName, handler);
      }),
    );
  }

  handleDocumentKeyEvent(event) {
    this.lumineEnvironment.keymaps.handleKeyboardEvent(event);
    event.stopImmediatePropagation();
  }

  handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  handleDragover(event) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "none";
  }

  eachTabIndexedElement(callback) {
    for (let element of this.document.querySelectorAll("[tabindex]")) {
      if (element.disabled) {
        continue;
      }
      if (!(element.tabIndex >= 0)) {
        continue;
      }
      callback(element, element.tabIndex);
    }
  }

  handleFocusNext() {
    const focusedTabIndex =
      this.document.activeElement.tabIndex != null
        ? this.document.activeElement.tabIndex
        : -Infinity;

    let nextElement = null;
    let nextTabIndex = Infinity;
    let lowestElement = null;
    let lowestTabIndex = Infinity;
    this.eachTabIndexedElement(function (element, tabIndex) {
      if (tabIndex < lowestTabIndex) {
        lowestTabIndex = tabIndex;
        lowestElement = element;
      }

      if (focusedTabIndex < tabIndex && tabIndex < nextTabIndex) {
        nextTabIndex = tabIndex;
        nextElement = element;
      }
    });

    if (nextElement != null) {
      nextElement.focus();
    } else if (lowestElement != null) {
      lowestElement.focus();
    }
  }

  handleFocusPrevious() {
    const focusedTabIndex =
      this.document.activeElement.tabIndex != null
        ? this.document.activeElement.tabIndex
        : Infinity;

    let previousElement = null;
    let previousTabIndex = -Infinity;
    let highestElement = null;
    let highestTabIndex = -Infinity;
    this.eachTabIndexedElement(function (element, tabIndex) {
      if (tabIndex > highestTabIndex) {
        highestTabIndex = tabIndex;
        highestElement = element;
      }

      if (focusedTabIndex > tabIndex && tabIndex > previousTabIndex) {
        previousTabIndex = tabIndex;
        previousElement = element;
      }
    });

    if (previousElement != null) {
      previousElement.focus();
    } else if (highestElement != null) {
      highestElement.focus();
    }
  }

  handleWindowFocus() {
    this.document.body.classList.remove("is-blurred");
  }

  handleWindowBlur() {
    this.document.body.classList.add("is-blurred");
    void Promise.resolve(this.lumineEnvironment.storeWindowDimensions()).catch((error) =>
      console.error(error),
    );
  }

  handleWindowResize() {
    void Promise.resolve(this.lumineEnvironment.storeWindowDimensions()).catch((error) =>
      console.error(error),
    );
  }

  handleEnterFullScreen() {
    this.document.body.classList.add("fullscreen");
  }

  handleLeaveFullScreen() {
    this.document.body.classList.remove("fullscreen");
  }

  handleWindowBeforeunload(_event) {
    if (
      !this.reloadRequested &&
      !this.lumineEnvironment.window.isSpecMode() &&
      // `BrowserWindow#isWebViewFocused()` no longer exists in modern Electron;
      // `document.hasFocus()` is the renderer-side equivalent of "is this
      // window's web view focused".
      this.document.hasFocus()
    ) {
      void this.lumineEnvironment.window.hide();
    }
    this.reloadRequested = false;
    void Promise.resolve(this.lumineEnvironment.storeWindowDimensions()).catch((error) =>
      console.error(error),
    );
    this.lumineEnvironment.unloadEditorWindow();
    this.lumineEnvironment.destroy();
  }

  handleWindowToggleFullScreen() {
    void this.lumineEnvironment.window.toggleFullScreen();
  }

  handleWindowClose() {
    void this.lumineEnvironment.window.close();
  }

  handleWindowReload() {
    this.reloadRequested = true;
    void this.lumineEnvironment.window.reload();
  }

  handleWindowToggleDevTools() {
    this.lumineEnvironment.window.toggleDevTools();
  }

  handleWindowToggleMenuBar() {
    this.lumineEnvironment.config.set(
      "core.autoHideMenuBar",
      !this.lumineEnvironment.config.get("core.autoHideMenuBar"),
    );

    if (this.lumineEnvironment.config.get("core.autoHideMenuBar")) {
      const detail = "To toggle, press the Alt key or execute the window:toggle-menu-bar command";
      this.lumineEnvironment.notifications.addHint("Menu bar hidden", { detail });
    }
  }

  handleLinkClick(event) {
    event.preventDefault();
    const uri = event.currentTarget && event.currentTarget.getAttribute("href");
    if (uri && uri[0] !== "#") {
      if (/^https?:\/\//.test(uri)) {
        this.applicationDelegate.openExternal(uri);
      } else if (uri.startsWith("lumine://")) {
        this.lumineEnvironment.uriHandlers.handleURI(uri);
      }
    }
  }

  handleFormSubmit(event) {
    // Prevent form submits from changing the current window's URL
    event.preventDefault();
  }

  handleDocumentContextmenu(event) {
    event.preventDefault();
    this.lumineEnvironment.contextMenu.showForEvent(event);
  }
};
