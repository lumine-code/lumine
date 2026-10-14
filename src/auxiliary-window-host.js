const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Disposable } = require("@lumine-code/event-kit");
const AuxiliaryWindowService = require("./auxiliary-window-service");
const EditorWindow = require("./editor-window");
const PaneContainer = require("./pane-container");
const { createWorkspaceElement } = require("./workspace-element");
const EmbeddedPaneKeyboardBridge = require("./embedded-pane-keyboard-bridge");
const AuxiliaryKeyboardTransport = require("./auxiliary-keyboard-transport");
const {
  captureLifecycleError,
  awaitLifecycleCleanup,
  throwLifecycleErrors,
} = require("./package-lifecycle-errors");

// Owns one additional Document and its UI bindings. It shares all models,
// providers and package generations with the opening Environment.
module.exports = class AuxiliaryWindowHost {
  constructor(environment) {
    this.environment = environment;
  }

  async open(options = {}) {
    const environment = this.environment;
    const workspace = environment.workspace;
    const token = await environment.applicationDelegate.invokeAuxiliaryWindow("prepare", options);
    let domWindow;
    let service;
    let editorWindow;
    let container;
    let descriptor;
    try {
      domWindow = environment.domWindow.open("about:blank", token);
      if (!domWindow) throw new Error("The auxiliary editor window could not be opened.");
      descriptor = await environment.applicationDelegate.invokeAuxiliaryWindow("resolve", token);
      if (!workspace.isAlive() || environment.unloading)
        throw new Error("The workspace is closing.");
      service = new AuxiliaryWindowService(environment.applicationDelegate, descriptor);
      container = new PaneContainer(workspace.getCenter().params);
      editorWindow = new EditorWindow({
        workspace,
        editorContainer: container,
        windowService: service,
        requestClose: (presentation) => workspace.closeEditorWindow(presentation),
      });
      editorWindow.persistentId = descriptor.persistentId;
      editorWindow.subscriptions.add(new Disposable(() => service.destroy()));
      const document = domWindow.document;
      // about:blank has no doctype and uses quirks-mode inline layout. Parse the
      // presentation shell before installing bindings so every window uses the
      // same standards-mode geometry as static/index.html.
      document.open();
      document.write(
        '<!doctype html><html><head><title>Lumine</title></head><body tabindex="-1"></body></html>',
      );
      document.close();
      Object.defineProperty(domWindow, "lumine", { value: environment, configurable: true });
      editorWindow.subscriptions.add(
        new Disposable(() => {
          delete domWindow.lumine;
        }),
      );
      const bootstrap = document.createElement("script");
      bootstrap.src = pathToFileURL(
        path.join(environment.application.getResourcePath(), "static", "auxiliary-window.js"),
      ).href;
      let bootstrapTimeout;
      await new Promise((resolve, reject) => {
        bootstrap.onload = resolve;
        bootstrap.onerror = () =>
          reject(new Error("The editor window presentation could not initialize."));
        bootstrapTimeout = setTimeout(
          () => reject(new Error("The editor window presentation timed out.")),
          15000,
        );
        document.head.append(bootstrap);
      }).finally(() => {
        clearTimeout(bootstrapTimeout);
        bootstrap.onload = bootstrap.onerror = null;
      });
      editorWindow.subscriptions.add(
        new Disposable(() => {
          bootstrap.remove();
          delete domWindow.luminePresentation;
        }),
      );
      if (!workspace.isAlive() || environment.unloading || service.closed)
        throw new Error("The workspace closed while preparing its editor window.");
      // Developer tools inspect this document while evaluating shared runtime
      // APIs and Node modules in the single opening environment.
      const consoleGlobals = { editorWindow };
      for (const name of ["require", "process", "Buffer"])
        if (environment.domWindow[name]) consoleGlobals[name] = environment.domWindow[name];
      for (const [name, value] of Object.entries(consoleGlobals))
        Object.defineProperty(domWindow, name, { value, configurable: true });
      editorWindow.subscriptions.add(
        new Disposable(() => {
          for (const name of Object.keys(consoleGlobals)) delete domWindow[name];
        }),
      );
      document.title = "Lumine";
      document.documentElement.className = environment.document.documentElement.className;
      document.body.className = environment.document.body.className;
      const styles = environment.styles.buildStylesElement();
      document.head.append(styles);
      editorWindow.subscriptions.add(new Disposable(() => styles.remove()));
      editorWindow.subscriptions.add(
        new Disposable(() => environment.menu.releaseDocument(document)),
      );
      const root = createWorkspaceElement();
      document.adoptNode(root);
      editorWindow.setPresentation(domWindow, root);
      root.initialize(workspace, {
        editorWindow,
        config: environment.config,
        project: environment.project,
        styleManager: environment.styles,
        viewRegistry: environment.views,
      });
      for (const theme of environment.themes.getActiveThemes())
        root.classList.add(`theme-${theme.name}`);
      document.body.append(root);
      editorWindow.subscriptions.add(
        new Disposable(() => {
          root.destroy();
          root.remove();
        }),
      );
      editorWindow.subscriptions.add(environment.commands.attach(domWindow));
      editorWindow.subscriptions.add(environment.views.attachPresentationDocument(document));
      editorWindow.subscriptions.add(environment.tooltips.attachWindow(domWindow));
      editorWindow.subscriptions.add(environment.keymaps.addDocumentTarget(document, root));
      const workspaceDrops = environment.workspaceDrops;
      const dropSurface = workspaceDrops.attachPresentation(root);
      editorWindow.subscriptions.add(
        new Disposable(() => workspaceDrops.releaseSurface(dropSurface)),
      );
      const keyboardTransport = new AuxiliaryKeyboardTransport(service);
      const frameKeyboardBridge = new EmbeddedPaneKeyboardBridge({
        keymaps: environment.keymaps,
        workspace,
        views: environment.views,
        window: domWindow,
        document,
        root,
        transport: keyboardTransport,
      });
      editorWindow.subscriptions.add(
        environment.keymaps.addFrameKeyboardBridge(frameKeyboardBridge),
        new Disposable(() => frameKeyboardBridge.dispose()),
        keyboardTransport,
      );
      const keyboard = (event) => {
        environment.keymaps.handleKeyboardEvent(event);
        event.stopImmediatePropagation();
      };
      const contextMenu = (event) => {
        event.preventDefault();
        environment.contextMenu.showForEvent(event);
      };
      const focused = () => {
        environment.views.setAnimationFrameWindow(domWindow);
        document.body.classList.remove("is-blurred");
      };
      const blurred = () => document.body.classList.add("is-blurred");
      for (const name of ["keydown", "keyup"]) document.addEventListener(name, keyboard);
      document.addEventListener("contextmenu", contextMenu);
      domWindow.addEventListener("focus", focused);
      domWindow.addEventListener("blur", blurred);
      editorWindow.subscriptions.add(
        new Disposable(() => {
          for (const name of ["keydown", "keyup"]) document.removeEventListener(name, keyboard);
          document.removeEventListener("contextmenu", contextMenu);
          domWindow.removeEventListener("focus", focused);
          domWindow.removeEventListener("blur", blurred);
        }),
      );
      editorWindow.subscriptions.add(
        environment.commands.add(domWindow, {
          "window:close": () => editorWindow.close(),
          "window:reload": () =>
            environment.commands.dispatch(environment.domWindow, "window:reload"),
          "window:toggle-full-screen": async () =>
            service.setFullScreen(!(await service.isFullScreen())),
          "window:toggle-dev-tools": () => service.toggleDevTools(),
        }),
        service.onDidClose(() => {
          if (!editorWindow.isDestroyed())
            void workspace.recoverClosedEditorWindow(editorWindow).catch((error) =>
              environment.notifications.addError("Unable to restore the closed editor window.", {
                detail: error.message,
                dismissable: true,
              }),
            );
        }),
        service.onDidRequestClose(() => {
          void editorWindow.close().catch((error) =>
            environment.notifications.addError("Unable to close the editor window.", {
              detail: error.message,
            }),
          );
        }),
      );
      workspace.getCenter().addPaneContainer(container);
      workspace.registerEditorWindow(editorWindow);
      if (options.show !== false) await service.show();
      return editorWindow;
    } catch (error) {
      const failures = [error];
      if (editorWindow) {
        captureLifecycleError(failures, () => workspace.getCenter().removePaneContainer(container));
        captureLifecycleError(failures, () => editorWindow.destroy());
      }
      captureLifecycleError(failures, () => container?.destroy());
      if (!domWindow?.closed) {
        await awaitLifecycleCleanup(failures, () => {
          if (service) return service.close();
          if (descriptor)
            return environment.applicationDelegate.invokeAuxiliaryWindow(
              "invoke",
              descriptor.id,
              "close",
            );
          return environment.applicationDelegate.invokeAuxiliaryWindow("cancel", token);
        });
      }
      throwLifecycleErrors(
        failures,
        "Unable to open the editor window and release its presentation.",
      );
    }
  }
};
