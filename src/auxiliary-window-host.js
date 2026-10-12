const { Disposable } = require("@lumine-code/event-kit");
const AuxiliaryWindowService = require("./auxiliary-window-service");
const EditorWindow = require("./editor-window");
const PaneContainer = require("./pane-container");
const { createWorkspaceElement } = require("./workspace-element");
const EmbeddedPaneKeyboardBridge = require("./embedded-pane-keyboard-bridge");
const AuxiliaryKeyboardTransport = require("./auxiliary-keyboard-transport");

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
    try {
      domWindow = environment.domWindow.open("about:blank", token);
      if (!domWindow) throw new Error("The auxiliary editor window could not be opened.");
      const descriptor = await environment.applicationDelegate.invokeAuxiliaryWindow(
        "resolve",
        token,
      );
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
      document.body.append(root);
      editorWindow.subscriptions.add(
        new Disposable(() => {
          root.destroy();
          root.remove();
        }),
      );
      editorWindow.subscriptions.add(environment.commands.attach(domWindow));
      editorWindow.subscriptions.add(environment.keymaps.addDocumentTarget(document, root));
      const dropSurface = environment.workspaceDrops.attachPresentation(root);
      editorWindow.subscriptions.add(
        new Disposable(() => environment.workspaceDrops.releaseSurface(dropSurface)),
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
          "window:toggle-dev-tools": () => service.openDevTools(),
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
      if (editorWindow) {
        workspace.getCenter().removePaneContainer(container);
        editorWindow.destroy();
      }
      container?.destroy();
      if (service) await service.close().catch(() => {});
      else await environment.applicationDelegate.invokeAuxiliaryWindow("cancel", token);
      throw error;
    }
  }
};
