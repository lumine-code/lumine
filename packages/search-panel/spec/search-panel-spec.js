describe("search-panel integration", () => {
  let workspaceElement, editor, mainModule;

  beforeEach(async () => {
    atom.config.set("core.excludeVcsIgnoredPaths", true);
    workspaceElement = atom.views.getView(atom.workspace);
    editor = await atom.workspace.open();
    editor.setText("one two one\nthree one four\n");

    // search-panel activates on command, so trigger one and await activation.
    const activationPromise = atom.packages.activatePackage("search-panel");
    atom.commands.dispatch(workspaceElement, "search-panel:show");
    const pkg = await activationPromise;
    mainModule = pkg.mainModule;
  });

  describe("activation and services", () => {
    it("exposes the search-panel service", () => {
      const service = mainModule.provideSearchControl();
      expect(typeof service.search).toBe("function");
      expect(typeof service.projectSearch).toBe("function");
      expect(typeof service.showFind).toBe("function");
      expect(typeof service.resultsMarkerLayerForTextEditor).toBe("function");
    });
  });

  describe("the buffer find panel", () => {
    it("shows and hides with the toggle command", () => {
      atom.commands.dispatch(workspaceElement, "search-panel:show");
      expect(mainModule.findPanel.isVisible()).toBe(true);
      expect(workspaceElement.querySelector(".search-panel")).toExist();

      atom.commands.dispatch(workspaceElement, "search-panel:toggle");
      expect(mainModule.findPanel.isVisible()).toBe(false);
    });

    it("selects the next match found for the typed pattern", () => {
      atom.commands.dispatch(workspaceElement, "search-panel:show");
      mainModule.findView.findEditor.setText("one");
      atom.commands.dispatch(workspaceElement, "search-panel:find-next");

      expect(mainModule.findModel.markers.length).toBe(3);
      expect(editor.getSelectedText()).toBe("one");
    });

    it("replaces the current match in place", () => {
      atom.commands.dispatch(workspaceElement, "search-panel:show");
      mainModule.findView.findEditor.setText("two");
      mainModule.findView.replaceEditor.setText("2");
      atom.commands.dispatch(workspaceElement, "search-panel:find-next");
      atom.commands.dispatch(workspaceElement, "search-panel:replace-current");

      expect(editor.getText()).toContain("2");
      expect(editor.getText()).not.toContain("two");
    });

    it("replaces every match", () => {
      atom.commands.dispatch(workspaceElement, "search-panel:show");
      mainModule.findView.findEditor.setText("one");
      mainModule.findView.replaceEditor.setText("1");
      atom.commands.dispatch(workspaceElement, "search-panel:replace-all");

      expect(editor.getText()).not.toContain("one");
      expect((editor.getText().match(/1/g) || []).length).toBe(3);
    });
  });

  describe("the project find panel", () => {
    it("does not create the buffer panel when its command activates the package", async () => {
      await atom.packages.deactivatePackage("search-panel");

      const activationPromise = atom.packages.activatePackage("search-panel");
      atom.commands.dispatch(workspaceElement, "search-panel:project-show");
      const pkg = await activationPromise;
      mainModule = pkg.mainModule;

      expect(mainModule.findPanel).toBeNull();
      expect(mainModule.projectFindPanel.isVisible()).toBe(true);
    });

    it("shows with the project-show command", () => {
      atom.commands.dispatch(workspaceElement, "search-panel:project-show");
      expect(mainModule.projectFindPanel.isVisible()).toBe(true);
      expect(workspaceElement.querySelector(".search-panel-project")).toExist();
    });

    it("orders search options by regex engine, case, and word matching", () => {
      atom.commands.dispatch(workspaceElement, "search-panel:project-show");

      const optionClasses = Array.from(
        workspaceElement.querySelectorAll(".search-panel-project .btn-group-options > .btn"),
      ).map((button) => button.classList[1]);

      expect(optionClasses).toEqual([
        "option-regex",
        "option-pcre2",
        "option-case-sensitive",
        "option-whole-word",
        "option-include-vcs-ignored-paths",
      ]);
    });

    it("includes VCS-ignored files only when its option is selected", () => {
      atom.commands.dispatch(workspaceElement, "search-panel:project-show");
      const button = workspaceElement.querySelector(".option-include-vcs-ignored-paths");

      expect(mainModule.resultsModel.getFindOptions().includeVcsIgnoredPaths).toBe(false);
      expect(button.classList.contains("selected")).toBe(false);

      button.click();

      expect(atom.config.get("core.excludeVcsIgnoredPaths")).toBe(true);
      expect(mainModule.resultsModel.getFindOptions().includeVcsIgnoredPaths).toBe(true);
      expect(button.classList.contains("selected")).toBe(true);
    });

    it("updates the option when the core VCS ignore preference changes", () => {
      atom.commands.dispatch(workspaceElement, "search-panel:project-show");
      const button = workspaceElement.querySelector(".option-include-vcs-ignored-paths");

      atom.config.set("core.excludeVcsIgnoredPaths", false);

      expect(mainModule.resultsModel.getFindOptions().includeVcsIgnoredPaths).toBe(true);
      expect(button.classList.contains("selected")).toBe(true);
    });
  });
});
