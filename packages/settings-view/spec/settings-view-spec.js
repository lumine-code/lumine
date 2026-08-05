const path = require("path");
const main = require("../lib/main");
const PackageManager = require("../lib/package-manager");
const recentSettings = require("../lib/recent-settings");
const SnippetsProvider = {
  getSnippets() {
    return {};
  },
};

const { conditionPromise, timeoutPromise: wait } = require("./async-spec-helpers");

describe("SettingsView", function () {
  let settingsView = null;
  const packageManager = new PackageManager();

  beforeEach(function () {
    // `openSetting` records into a module singleton, so specs below would
    // otherwise seed the Search panel for every later spec in the run.
    recentSettings.clear();
    settingsView = main.createSettingsView({ packageManager, snippetsProvider: SnippetsProvider });
    spyOn(settingsView, "initializePanels").andCallThrough();
    window.advanceClock(10000);
    waitsFor(() => settingsView.initializePanels.callCount > 0);
  });

  describe("when a package operation fails", function () {
    it("surfaces the failure as a single editor notification with the stderr detail", function () {
      spyOn(atom.notifications, "addError").andCallThrough();
      const error = new Error("Installing “broken” failed.");
      error.stderr = "npm ERR! boom";
      settingsView.packageManager.emitPackageEvent("install-failed", { name: "broken" }, error);

      expect(atom.notifications.addError.callCount).toBe(1);
      const [message, options] = atom.notifications.addError.mostRecentCall.args;
      expect(message).toBe("Installing “broken” failed.");
      expect(options.detail).toBe("npm ERR! boom");
    });
  });

  describe("serialization", function () {
    it("remembers which panel was visible", function () {
      settingsView.showPanel("Themes");
      const newSettingsView = main.createSettingsView(settingsView.serialize());
      settingsView.destroy();
      jasmine.attachToDOM(newSettingsView.element);
      newSettingsView.initializePanels();
      expect(newSettingsView.activePanel).toEqual({ name: "Themes", options: {} });
    });

    it("shows the previously active panel if it is added after deserialization", function () {
      settingsView.addCorePanel("Panel 1", "panel-1", function () {
        const div = document.createElement("div");
        div.id = "panel-1";
        return {
          element: div,
          show() {
            return (div.style.display = "");
          },
          focus() {
            return div.focus();
          },
          destroy() {
            return div.remove();
          },
        };
      });
      settingsView.showPanel("Panel 1");
      const newSettingsView = main.createSettingsView(settingsView.serialize());
      newSettingsView.addPanel("Panel 1", function () {
        const div = document.createElement("div");
        div.id = "panel-1";
        return {
          element: div,
          show() {
            return (div.style.display = "");
          },
          focus() {
            return div.focus();
          },
          destroy() {
            return div.remove();
          },
        };
      });
      newSettingsView.initializePanels();
      jasmine.attachToDOM(newSettingsView.element);
      expect(newSettingsView.activePanel).toEqual({ name: "Panel 1", options: {} });
    });

    it("shows the Settings panel if the last saved active panel name no longer exists", function () {
      settingsView.addCorePanel("Panel 1", "panel1", function () {
        const div = document.createElement("div");
        div.id = "panel-1";
        return {
          element: div,
          show() {
            return (div.style.display = "");
          },
          focus() {
            return div.focus();
          },
          destroy() {
            return div.remove();
          },
        };
      });
      settingsView.showPanel("Panel 1");
      const newSettingsView = main.createSettingsView(settingsView.serialize());
      settingsView.destroy();
      jasmine.attachToDOM(newSettingsView.element);
      newSettingsView.initializePanels();
      expect(newSettingsView.activePanel).toEqual({ name: "Core", options: {} });
    });

    it("serializes the active panel name even when the panels were never initialized", function () {
      settingsView.showPanel("Themes");
      const settingsView2 = main.createSettingsView(settingsView.serialize());
      const settingsView3 = main.createSettingsView(settingsView2.serialize());
      jasmine.attachToDOM(settingsView3.element);
      settingsView3.initializePanels();
      expect(settingsView3.activePanel).toEqual({ name: "Themes", options: {} });
    });
  });

  describe("the default panel", function () {
    it("defaults to the Search panel when settings search is enabled", function () {
      atom.config.set("settings-view.enableSettingsSearch", true);
      const view = main.createSettingsView({ packageManager, snippetsProvider: SnippetsProvider });
      jasmine.attachToDOM(view.element);
      view.initializePanels();
      expect(view.activePanel).toEqual({ name: "Search", options: {} });
      view.destroy();
    });

    it("falls back to the Core panel when settings search is disabled", function () {
      atom.config.set("settings-view.enableSettingsSearch", false);
      const view = main.createSettingsView({ packageManager, snippetsProvider: SnippetsProvider });
      jasmine.attachToDOM(view.element);
      view.initializePanels();
      expect(view.activePanel).toEqual({ name: "Core", options: {} });
      view.destroy();
    });
  });

  describe(".addCorePanel(name, iconName, view)", () =>
    it("adds a menu entry to the left and a panel that can be activated by clicking it", function () {
      settingsView.addCorePanel("Panel 1", "panel1", function () {
        const div = document.createElement("div");
        div.id = "panel-1";
        return {
          element: div,
          show() {
            return (div.style.display = "");
          },
          focus() {
            return div.focus();
          },
          destroy() {
            return div.remove();
          },
        };
      });
      settingsView.addCorePanel("Panel 2", "panel2", function () {
        const div = document.createElement("div");
        div.id = "panel-2";
        return {
          element: div,
          show() {
            return (div.style.display = "");
          },
          focus() {
            return div.focus();
          },
          destroy() {
            return div.remove();
          },
        };
      });

      expect(settingsView.refs.panelMenu.querySelector('li[name="Panel 1"]')).toExist();
      expect(settingsView.refs.panelMenu.querySelector('li[name="Panel 2"]')).toExist();
      //expect(settingsView.refs.panelMenu.children[1]).toHaveClass 'active' # TODO FIX

      jasmine.attachToDOM(settingsView.element);
      settingsView.refs.panelMenu.querySelector('li[name="Panel 1"] a').click();
      expect(settingsView.refs.panelMenu.querySelectorAll(".active").length).toBe(1);
      expect(settingsView.refs.panelMenu.querySelector('li[name="Panel 1"]')).toHaveClass("active");
      expect(settingsView.refs.panels.querySelector("#panel-1")).toBeVisible();
      expect(settingsView.refs.panels.querySelector("#panel-2")).not.toExist();
      settingsView.refs.panelMenu.querySelector('li[name="Panel 2"] a').click();
      expect(settingsView.refs.panelMenu.querySelectorAll(".active").length).toBe(1);
      expect(settingsView.refs.panelMenu.querySelector('li[name="Panel 2"]')).toHaveClass("active");
      expect(settingsView.refs.panels.querySelector("#panel-1")).toBeHidden();
      expect(settingsView.refs.panels.querySelector("#panel-2")).toBeVisible();
    }));

  describe("when the package is activated", function () {
    const openWithCommand = (command) =>
      waitsFor(function (done) {
        var openSubscription = atom.workspace.onDidOpen(function () {
          openSubscription.dispose();
          return done();
        });
        return atom.commands.dispatch(atom.views.getView(atom.workspace), command);
      });

    beforeEach(function () {
      jasmine.attachToDOM(atom.views.getView(atom.workspace));
      waitsForPromise(() => atom.packages.activatePackage("settings-view"));
    });

    describe("when the settings view is opened with a settings-view:* command", function () {
      beforeEach(() => (settingsView = null));

      describe("settings-view:open", function () {
        it("opens the settings view", function () {
          openWithCommand("settings-view:open");
          runs(() =>
            expect(atom.workspace.getActivePaneItem().activePanel).toEqual({
              name: "Core",
              options: {},
            }),
          );
        });

        it("always open existing item in workspace", function () {
          const center = atom.workspace.getCenter();
          let [pane1, pane2] = [];

          waitsForPromise(() => atom.workspace.open(null, { split: "right" }));
          runs(function () {
            expect(center.getPanes()).toHaveLength(2);
            [pane1, pane2] = center.getPanes();
            expect(atom.workspace.getActivePane()).toBe(pane2);
          });

          openWithCommand("settings-view:open");

          runs(function () {
            expect(atom.workspace.getActivePaneItem().activePanel).toEqual({
              name: "Core",
              options: {},
            });
            expect(atom.workspace.getActivePane()).toBe(pane2);
          });

          runs(() => pane1.activate());

          openWithCommand("settings-view:open");

          runs(function () {
            expect(atom.workspace.getActivePaneItem().activePanel).toEqual({
              name: "Core",
              options: {},
            });
            expect(atom.workspace.getActivePane()).toBe(pane2);
          });
        });
      });

      describe("settings-view:core", () =>
        it("opens the core settings view", function () {
          openWithCommand("settings-view:editor");
          openWithCommand("settings-view:core");
          runs(() =>
            expect(atom.workspace.getActivePaneItem().activePanel).toEqual({
              name: "Core",
              options: { uri: "lumine://config/core" },
            }),
          );
        }));

      describe("settings-view:editor", () =>
        it("opens the editor settings view", function () {
          openWithCommand("settings-view:editor");
          runs(() =>
            expect(atom.workspace.getActivePaneItem().activePanel).toEqual({
              name: "Editor",
              options: { uri: "lumine://config/editor" },
            }),
          );
        }));

      describe("settings-view:show-keybindings", () =>
        it("opens the settings view to the keybindings page", function () {
          openWithCommand("settings-view:show-keybindings");
          runs(() =>
            expect(atom.workspace.getActivePaneItem().activePanel).toEqual({
              name: "Keybindings",
              options: { uri: "lumine://config/keybindings" },
            }),
          );
        }));

      describe("the theme mode commands", () =>
        it("set theme.mode without opening a settings view", function () {
          const workspaceElement = atom.views.getView(atom.workspace);

          atom.commands.dispatch(workspaceElement, "settings-view:use-dark-mode");
          expect(atom.config.get("theme.mode")).toBe("dark");

          atom.commands.dispatch(workspaceElement, "settings-view:use-light-mode");
          expect(atom.config.get("theme.mode")).toBe("light");

          atom.commands.dispatch(workspaceElement, "settings-view:use-system-mode");
          expect(atom.config.get("theme.mode")).toBe("system");
        }));

      describe("settings-view:uninstall-themes", () =>
        it("opens the settings view to the themes page", function () {
          openWithCommand("settings-view:uninstall-themes");
          runs(() =>
            expect(atom.workspace.getActivePaneItem().activePanel).toEqual({
              name: "Themes",
              options: { uri: "lumine://config/themes" },
            }),
          );
        }));

      describe("settings-view:uninstall-packages", () =>
        it("opens the settings view to the install page", function () {
          openWithCommand("settings-view:uninstall-packages");
          runs(() =>
            expect(atom.workspace.getActivePaneItem().activePanel).toEqual({
              name: "Packages",
              options: { uri: "lumine://config/packages" },
            }),
          );
        }));

      describe("settings-view:install-packages-and-themes", () =>
        it("opens the settings view to the install page", function () {
          openWithCommand("settings-view:install-packages-and-themes");
          runs(() =>
            expect(atom.workspace.getActivePaneItem().activePanel).toEqual({
              name: "Install",
              options: { uri: "lumine://config/install" },
            }),
          );
        }));
    });

    describe("when atom.workspace.open() is used with a config URI", function () {
      const focusIsWithinActivePanel = function () {
        const activePanel = settingsView.panelsByName[settingsView.activePanel.name];
        return (
          activePanel.element === document.activeElement ||
          activePanel.element.contains(document.activeElement)
        );
      };

      const expectActivePanelToBeKeyboardScrollable = function () {
        const activePanel = settingsView.panelsByName[settingsView.activePanel.name];
        spyOn(activePanel, "pageDown");
        atom.commands.dispatch(activePanel.element, "core:page-down");
        expect(activePanel.pageDown).toHaveBeenCalled();
        spyOn(activePanel, "pageUp");
        atom.commands.dispatch(activePanel.element, "core:page-up");
        expect(activePanel.pageUp).toHaveBeenCalled();
      };

      beforeEach(() => (settingsView = null));

      it("opens the settings to the correct panel with lumine://config/<panel-name> and that panel is keyboard-scrollable", function () {
        waitsForPromise(() =>
          atom.workspace.open("lumine://config").then((s) => (settingsView = s)),
        );

        waitsFor((done) => process.nextTick(done));
        runs(function () {
          expect(settingsView.activePanel).toEqual({ name: "Core", options: {} });
          expect(focusIsWithinActivePanel()).toBe(true);
          expectActivePanelToBeKeyboardScrollable();
        });

        waitsForPromise(() =>
          atom.workspace.open("lumine://config/editor").then((s) => (settingsView = s)),
        );

        waits(1);
        runs(function () {
          expect(settingsView.activePanel).toEqual({
            name: "Editor",
            options: { uri: "lumine://config/editor" },
          });
          expect(focusIsWithinActivePanel()).toBe(true);
          expectActivePanelToBeKeyboardScrollable();
        });

        waitsForPromise(() =>
          atom.workspace.open("lumine://config/language").then((s) => (settingsView = s)),
        );

        waits(1);
        runs(function () {
          expect(settingsView.activePanel).toEqual({
            name: "Language",
            options: { uri: "lumine://config/language" },
          });
          expect(focusIsWithinActivePanel()).toBe(true);
          expectActivePanelToBeKeyboardScrollable();
        });

        waitsForPromise(() =>
          atom.workspace.open("lumine://config/keybindings").then((s) => (settingsView = s)),
        );

        waits(1);
        runs(function () {
          expect(settingsView.activePanel).toEqual({
            name: "Keybindings",
            options: { uri: "lumine://config/keybindings" },
          });
          expect(focusIsWithinActivePanel()).toBe(true);
          expectActivePanelToBeKeyboardScrollable();
        });

        waitsForPromise(() =>
          atom.workspace.open("lumine://config/packages").then((s) => (settingsView = s)),
        );

        waits(1);
        runs(function () {
          expect(settingsView.activePanel).toEqual({
            name: "Packages",
            options: { uri: "lumine://config/packages" },
          });
          expect(focusIsWithinActivePanel()).toBe(true);
          expectActivePanelToBeKeyboardScrollable();
        });

        waitsForPromise(() =>
          atom.workspace.open("lumine://config/themes").then((s) => (settingsView = s)),
        );

        waits(1);
        runs(function () {
          expect(settingsView.activePanel).toEqual({
            name: "Themes",
            options: { uri: "lumine://config/themes" },
          });
          expect(focusIsWithinActivePanel()).toBe(true);
          expectActivePanelToBeKeyboardScrollable();
        });

        waitsForPromise(() =>
          atom.workspace.open("lumine://config/updates").then((s) => (settingsView = s)),
        );

        waits(1);
        runs(function () {
          // The legacy updates URI redirects to the Update panel.
          expect(settingsView.activePanel).toEqual({
            name: "Update",
            options: { uri: "lumine://config/updates" },
          });
          expect(focusIsWithinActivePanel()).toBe(true);
          expectActivePanelToBeKeyboardScrollable();
        });

        waitsForPromise(() =>
          atom.workspace.open("lumine://config/install").then((s) => (settingsView = s)),
        );

        let hasSystemPanel = false;
        waits(1);
        runs(function () {
          expect(settingsView.activePanel).toEqual({
            name: "Install",
            options: { uri: "lumine://config/install" },
          });
          expect(focusIsWithinActivePanel()).toBe(true);
          expectActivePanelToBeKeyboardScrollable();
          return (hasSystemPanel = settingsView.panelsByName["System"] != null);
        });

        if (hasSystemPanel) {
          waitsForPromise(() =>
            atom.workspace.open("lumine://config/system").then((s) => (settingsView = s)),
          );

          waits(1);
          runs(function () {
            expect(settingsView.activePanel).toEqual({
              name: "System",
              options: { uri: "lumine://config/system" },
            });
            expect(focusIsWithinActivePanel()).toBe(true);
            expectActivePanelToBeKeyboardScrollable();
          });
        }
      });

      it("opens the package settings view with lumine://config/packages/<package-name>", function () {
        waitsForPromise(() =>
          atom.packages.activatePackage(path.join(__dirname, "fixtures", "package-with-readme")),
        );

        waitsForPromise(() =>
          atom.workspace
            .open("lumine://config/packages/package-with-readme")
            .then((s) => (settingsView = s)),
        );

        waitsFor((done) => process.nextTick(done));
        runs(() =>
          expect(settingsView.activePanel).toEqual({
            name: "package-with-readme",
            options: {
              uri: "lumine://config/packages/package-with-readme",
              pack: {
                name: "package-with-readme",
                metadata: {
                  name: "package-with-readme",
                },
              },
              back: "Packages",
            },
          }),
        );
      });

      it("keeps the open package detail panel and refreshes it when the package is re-activated", async () => {
        jasmine.useRealClock();
        await atom.packages.activate();
        await atom.packages.activatePackage(
          path.join(__dirname, "fixtures", "package-with-readme"),
        );
        let settingsView = await atom.workspace.open(
          "lumine://config/packages/package-with-readme",
        );

        await wait(10);

        const detailInitial = settingsView.getOrCreatePanel("package-with-readme");
        expect(detailInitial).toBeTruthy();

        await atom.packages.deactivatePackage("package-with-readme");
        await atom.packages.activatePackage(
          path.join(__dirname, "fixtures", "package-with-readme"),
        );
        await atom.workspace.open("lumine://config/packages/package-with-readme");

        // The panel the reader has open is the one that must reflect the change,
        // so it stays and updates itself rather than being dropped and rebuilt
        // on the next visit — which left this one stale and orphaned in the DOM.
        expect(settingsView.getOrCreatePanel("package-with-readme")).toBe(detailInitial);
        expect(settingsView.refs.panels.contains(detailInitial.element)).toBe(true);
      });

      it("recreates an origin-keyed detail panel when a selected ref changes the package name", function () {
        settingsView = main.createSettingsView({
          packageManager,
          snippetsProvider: SnippetsProvider,
        });
        const originKey = "github.com/owner/renamed-package";
        const detailInitial = settingsView.getOrCreatePanel(`community:${originKey}`, {
          pack: {
            name: "old-package-name",
            repository: "owner/renamed-package",
            originKey,
            resolvedSha: "a".repeat(40),
            selectedRef: { type: "tag", value: "v1.0.0" },
            status: "ready",
            engines: { lumine: "*" },
          },
        });
        const detailAfterRename = settingsView.getOrCreatePanel(`community:${originKey}`, {
          pack: {
            name: "new-package-name",
            repository: "owner/renamed-package",
            originKey,
            resolvedSha: "b".repeat(40),
            selectedRef: { type: "tag", value: "v2.0.0" },
            status: "ready",
            engines: { lumine: "*" },
          },
        });

        expect(detailAfterRename).not.toBe(detailInitial);
        expect(detailAfterRename.pack.name).toBe("new-package-name");
        expect(settingsView.panelsByName[`community:${originKey}`]).toBe(detailAfterRename);
      });

      it("passes the URI to a pane's beforeShow() method on settings view initialization", function () {
        const InstallPanel = require("../lib/install-panel");
        spyOn(InstallPanel.prototype, "beforeShow");

        waitsForPromise(() =>
          atom.workspace
            .open("lumine://config/install/package:something")
            .then((s) => (settingsView = s)),
        );

        waitsFor(() => settingsView.activePanel != null, "The activePanel should be set", 5000);

        runs(function () {
          expect(settingsView.activePanel).toEqual({
            name: "Install",
            options: { uri: "lumine://config/install/package:something" },
          });
          expect(InstallPanel.prototype.beforeShow).toHaveBeenCalledWith({
            uri: "lumine://config/install/package:something",
          });
        });
      });

      it("passes the URI to a pane's beforeShow() method after initialization", function () {
        const InstallPanel = require("../lib/install-panel");
        spyOn(InstallPanel.prototype, "beforeShow");

        waitsForPromise(() =>
          atom.workspace.open("lumine://config").then((s) => (settingsView = s)),
        );

        waitsFor((done) => process.nextTick(done));

        runs(() => expect(settingsView.activePanel).toEqual({ name: "Core", options: {} }));

        waitsForPromise(() =>
          atom.workspace
            .open("lumine://config/install/package:something")
            .then((s) => (settingsView = s)),
        );

        waits(1);
        runs(function () {
          expect(settingsView.activePanel).toEqual({
            name: "Install",
            options: { uri: "lumine://config/install/package:something" },
          });
          expect(InstallPanel.prototype.beforeShow).toHaveBeenCalledWith({
            uri: "lumine://config/install/package:something",
          });
        });
      });
    });

    describe("when the package is then deactivated", function () {
      beforeEach(() => (settingsView = null));

      it("calls the dispose method on all panels", function () {
        openWithCommand("settings-view:open");

        waitsFor((done) => process.nextTick(done));

        runs(function () {
          let panel;
          settingsView = atom.workspace.getActivePaneItem();
          const panels = [
            settingsView.getOrCreatePanel("Core"),
            settingsView.getOrCreatePanel("Editor"),
            settingsView.getOrCreatePanel("Keybindings"),
            settingsView.getOrCreatePanel("Packages"),
            settingsView.getOrCreatePanel("Themes"),
            settingsView.getOrCreatePanel("Install"),
          ];
          const systemPanel = settingsView.getOrCreatePanel("System");
          if (systemPanel != null) {
            panels.push(systemPanel);
          }
          for (panel of Array.from(panels)) {
            if (panel.dispose) {
              spyOn(panel, "dispose");
            } else {
              spyOn(panel, "destroy");
            }
          }

          waitsForPromise(() => Promise.resolve(atom.packages.deactivatePackage("settings-view"))); // Ensure works on promise and non-promise versions

          runs(function () {
            for (panel of Array.from(panels)) {
              if (panel.dispose) {
                expect(panel.dispose).toHaveBeenCalled();
              } else {
                expect(panel.destroy).toHaveBeenCalled();
              }
            }
          });
        });
      });
    });
  });

  describe("opening a search result", () => {
    it("routes settings that live outside the Core panel", () => {
      spyOn(settingsView, "showPanel");
      spyOn(settingsView, "revealSetting");

      settingsView.openSetting("core.themes");
      expect(settingsView.showPanel).toHaveBeenCalledWith("Themes", {
        uri: "lumine://config/themes",
      });

      settingsView.openSetting("core.uriHandlerRegistration");
      expect(settingsView.showPanel).toHaveBeenCalledWith("URI Handling", {
        uri: "lumine://config/uri-handling",
      });

      settingsView.openSetting("language.tabLength");
      expect(settingsView.showPanel).toHaveBeenCalledWith("Language", {
        uri: "lumine://config/language",
      });
    });

    it("round-trips the recently opened list through the package state", () => {
      spyOn(settingsView, "showPanel");
      spyOn(settingsView, "revealSetting");

      settingsView.openSetting("editor.fontSize");
      const state = main.serialize();
      recentSettings.clear();

      main.initialize(state);
      expect(recentSettings.getPaths()).toEqual(["editor.fontSize"]);

      // `initialize` runs again after a disable/enable cycle, and the package
      // state is `{}` on a first run.
      main.initialize(state);
      expect(recentSettings.getPaths()).toEqual(["editor.fontSize"]);

      main.initialize({});
      expect(recentSettings.getPaths()).toEqual([]);
    });

    it("records the setting as recently opened, most recent first", () => {
      spyOn(settingsView, "showPanel");
      spyOn(settingsView, "revealSetting");

      settingsView.openSetting("editor.fontSize");
      settingsView.openSetting("core.closeDeletedFileTabs");
      settingsView.openSetting("editor.fontSize");

      expect(recentSettings.getPaths()).toEqual(["editor.fontSize", "core.closeDeletedFileTabs"]);
    });

    it("expands, scrolls to, focuses, and highlights a nested setting", () => {
      const panelElement = document.createElement("div");
      const section = document.createElement("section");
      section.classList.add("sub-section", "collapsed");
      const target = document.createElement("div");
      target.dataset.settingKey = "example.group.enabled";
      target.scrollIntoView = jasmine.createSpy("scrollIntoView");
      const input = document.createElement("input");
      target.appendChild(input);
      section.appendChild(target);
      panelElement.appendChild(section);
      jasmine.attachToDOM(panelElement);

      settingsView.panelsByName.Example = { element: panelElement };
      settingsView.activePanel = { name: "Example", options: {} };

      expect(settingsView.revealSetting("example.group.enabled")).toBe(true);
      expect(section).not.toHaveClass("collapsed");
      expect(target).toHaveClass("search-settings-match");
      expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
      expect(document.activeElement).toBe(input);
    });
  });

  describe("when the active theme has settings", function () {
    let panel = null;

    beforeEach(async () => {
      jasmine.useRealClock();
      atom.packages.packageDirPaths.push(path.join(__dirname, "fixtures"));
      atom.packages.loadPackage("ui-theme-with-config");
      atom.packages.loadPackage("syntax-theme-with-config");
      atom.config.set("theme.mode", "dark");
      atom.config.set("theme.dark", ["ui-theme-with-config", "syntax-theme-with-config"]);

      const reloadedHandler = jasmine.createSpy("reloadedHandler");
      atom.themes.onDidChangeActiveThemes(reloadedHandler);
      atom.themes.activatePackages();

      await conditionPromise(() => {
        return reloadedHandler.callCount === 1;
      }, "themes to be reloaded");

      settingsView.showPanel("Themes");
      panel = settingsView.element.querySelector(".themes-panel");
    });

    afterEach(() => atom.themes.unwatchUserStylesheet());

    describe("when the UI theme's settings button is clicked", () => {
      it("navigates to that theme's detail view", function () {
        jasmine.attachToDOM(settingsView.element);
        expect(panel.querySelector(".dark-ui-theme-settings")).toBeVisible();

        panel.querySelector(".dark-ui-theme-settings").click();
        const packageDetail = settingsView.element.querySelector(".package-detail li.active");
        expect(packageDetail.textContent).toBe("Ui Theme With Config");
      });
    });

    describe("when the syntax theme's settings button is clicked", () => {
      it("navigates to that theme's detail view", function () {
        jasmine.attachToDOM(settingsView.element);
        expect(panel.querySelector(".dark-syntax-theme-settings")).toBeVisible();

        panel.querySelector(".dark-syntax-theme-settings").click();
        const packageDetail = settingsView.element.querySelector(".package-detail li.active");
        expect(packageDetail.textContent).toBe("Syntax Theme With Config");
      });
    });
  });
});
