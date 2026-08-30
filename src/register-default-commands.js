const { ipcRenderer } = require("electron");
const Grim = require("@lumine-code/grim");
const { isSaveCancellationError } = require("./pane");

function settleSaveCommand(result) {
  return Promise.resolve(result).catch((error) => {
    if (!isSaveCancellationError(error)) throw error;
  });
}

function paneItemForCommandTarget(workspace, target) {
  for (let element = target; element; element = element.parentNode) {
    const item = element.item;
    const pane = item && workspace.paneForItem(item);
    if (pane && !pane.isDetached()) return item;
  }
  const item = workspace.getActivePaneItem();
  const pane = item && workspace.paneForItem(item);
  return pane && !pane.isDetached() ? item : null;
}

function primaryWorkspaceElement(element) {
  const workspace = element.getModel();
  workspace.focusPrimaryWindow();
  return workspace.getElement();
}

module.exports = function ({
  commandRegistry,
  commandInstaller,
  config,
  notificationManager,
  project,
  repositories,
  clipboard,
}) {
  commandRegistry.add(
    "lumine-workspace",
    {
      "pane:show-next-recently-used-item": {
        description: "Step through the pane's tabs in the order they were last used.",
        didDispatch: function () {
          return this.getModel().getActivePane().activateNextRecentlyUsedItem();
        },
      },
      "pane:show-previous-recently-used-item": {
        description: "Step back through the pane's tabs in the order they were last used.",
        didDispatch: function () {
          return this.getModel().getActivePane().activatePreviousRecentlyUsedItem();
        },
      },
      "pane:move-active-item-to-top-of-stack": {
        description: "Mark the active tab as the most recently used one.",
        didDispatch: function () {
          return this.getModel().getActivePane().moveActiveItemToTopOfStack();
        },
      },
      "pane:show-next-item": function () {
        return this.getModel().getActivePane().activateNextItem();
      },
      "pane:show-previous-item": function () {
        return this.getModel().getActivePane().activatePreviousItem();
      },
      "pane:show-item-1": function () {
        return this.getModel().getActivePane().activateItemAtIndex(0);
      },
      "pane:show-item-2": function () {
        return this.getModel().getActivePane().activateItemAtIndex(1);
      },
      "pane:show-item-3": function () {
        return this.getModel().getActivePane().activateItemAtIndex(2);
      },
      "pane:show-item-4": function () {
        return this.getModel().getActivePane().activateItemAtIndex(3);
      },
      "pane:show-item-5": function () {
        return this.getModel().getActivePane().activateItemAtIndex(4);
      },
      "pane:show-item-6": function () {
        return this.getModel().getActivePane().activateItemAtIndex(5);
      },
      "pane:show-item-7": function () {
        return this.getModel().getActivePane().activateItemAtIndex(6);
      },
      "pane:show-item-8": function () {
        return this.getModel().getActivePane().activateItemAtIndex(7);
      },
      "pane:show-item-9": {
        description: "Show the last tab in the pane, however many there are.",
        didDispatch: function () {
          return this.getModel().getActivePane().activateLastItem();
        },
      },
      "pane:move-item-right": {
        description: "Move the active tab one place along, within its own pane.",
        didDispatch: function () {
          return this.getModel().getActivePane().moveItemRight();
        },
      },
      "pane:move-item-left": {
        description: "Move the active tab one place back, within its own pane.",
        didDispatch: function () {
          return this.getModel().getActivePane().moveItemLeft();
        },
      },
      "pane:toggle-pending-item": {
        description: "Keep a previewed tab open, or hand it back to preview.",
        didDispatch: function () {
          return this.getModel().getActivePane().togglePendingItem();
        },
      },
      "window:increase-font-size": function () {
        return this.getModel().increaseFontSize();
      },
      "window:decrease-font-size": function () {
        return this.getModel().decreaseFontSize();
      },
      "window:reset-font-size": function () {
        return this.getModel().resetFontSize();
      },
      "application:about": function () {
        return ipcRenderer.send("command", "application:about");
      },
      "application:show-settings": function () {
        return ipcRenderer.send("command", "application:show-settings");
      },
      "application:quit": function () {
        return ipcRenderer.send("command", "application:quit");
      },
      "application:new-window": function () {
        return ipcRenderer.send("command", "application:new-window");
      },
      "application:new-file": function () {
        return ipcRenderer.send("command", "application:new-file");
      },
      "application:open": function () {
        var defaultPath, ref, ref1, ref2;
        defaultPath =
          (ref =
            (ref1 = lumine.workspace.getActiveTextEditor()) != null ? ref1.getPath() : void 0) !=
          null
            ? ref
            : (ref2 = lumine.project.getPaths()) != null
              ? ref2[0]
              : void 0;
        return ipcRenderer.send("open-chosen-any", defaultPath);
      },
      "application:open-file": function () {
        var defaultPath, ref, ref1, ref2;
        defaultPath =
          (ref =
            (ref1 = lumine.workspace.getActiveTextEditor()) != null ? ref1.getPath() : void 0) !=
          null
            ? ref
            : (ref2 = lumine.project.getPaths()) != null
              ? ref2[0]
              : void 0;
        return ipcRenderer.send("open-chosen-file", defaultPath);
      },
      "application:open-folder": function () {
        var defaultPath, ref, ref1, ref2;
        defaultPath =
          (ref =
            (ref1 = lumine.workspace.getActiveTextEditor()) != null ? ref1.getPath() : void 0) !=
          null
            ? ref
            : (ref2 = lumine.project.getPaths()) != null
              ? ref2[0]
              : void 0;
        return ipcRenderer.send("open-chosen-folder", defaultPath);
      },
      "application:open-dev": {
        description: "Choose a file or folder and open it in a dev-mode window.",
        didDispatch: function () {
          return ipcRenderer.send("command", "application:open-dev");
        },
      },
      "application:reopen-window-in-dev-mode": function () {
        return ipcRenderer.send("command", "application:reopen-window-in-dev-mode");
      },
      "application:open-safe": {
        description: "Choose a file or folder and open it without your packages.",
        didDispatch: function () {
          return ipcRenderer.send("command", "application:open-safe");
        },
      },
      "application:add-project-folder": function () {
        return lumine.addProjectFolder();
      },
      "git:update-repositories": {
        description: "Look for Git repositories again and reread what each one holds.",
        didDispatch: function () {
          return repositories.update();
        },
      },
      "core:toggle-vcs-ignored-paths": {
        description: "Include VCS-ignored paths in project discovery, or exclude them again.",
        displayName: "Core: Toggle VCS Ignored Paths",
        didDispatch: function () {
          const keyPath = "core.excludeVcsIgnoredPaths";
          return config.set(keyPath, !config.get(keyPath));
        },
      },
      "core:refresh-file-index": {
        description: "Crawl the project again and update the shared file index.",
        didDispatch: function () {
          return project.refreshFilePaths();
        },
      },
      "application:minimize": function () {
        return ipcRenderer.send("command", "application:minimize");
      },
      "application:zoom": {
        description: "Switch the window between its zoomed and its restored size.",
        didDispatch: function () {
          return ipcRenderer.send("command", "application:zoom");
        },
      },
      "application:open-your-config": function () {
        return ipcRenderer.send("command", "application:open-your-config");
      },
      "application:open-your-init-script": function () {
        return ipcRenderer.send("command", "application:open-your-init-script");
      },
      "application:open-your-keymap": function () {
        return ipcRenderer.send("command", "application:open-your-keymap");
      },
      "application:open-your-snippets": function () {
        return ipcRenderer.send("command", "application:open-your-snippets");
      },
      "application:open-your-stylesheet": function () {
        return ipcRenderer.send("command", "application:open-your-stylesheet");
      },
      "application:open-license": function () {
        return this.getModel().openLicense();
      },
      "application:open-documentation": function () {
        return ipcRenderer.send("command", "application:open-documentation");
      },
      "application:open-api-reference": function () {
        return ipcRenderer.send("command", "application:open-api-reference");
      },
      "window:run-package-specs": {
        description: "Run the spec suite of the package this window has open.",
        didDispatch: function () {
          return primaryWorkspaceElement(this).runPackageSpecs();
        },
      },
      "window:toggle-left-dock": function () {
        return this.getModel().getLeftDock().toggle();
      },
      "window:toggle-right-dock": function () {
        return this.getModel().getRightDock().toggle();
      },
      "window:toggle-bottom-dock": function () {
        return this.getModel().getBottomDock().toggle();
      },
      "window:focus-next-pane": function () {
        return this.getModel().activateNextPane();
      },
      "window:focus-previous-pane": function () {
        return this.getModel().activatePreviousPane();
      },
      "window:focus-pane-above": function () {
        return primaryWorkspaceElement(this).focusPaneViewAbove();
      },
      "window:focus-pane-below": function () {
        return primaryWorkspaceElement(this).focusPaneViewBelow();
      },
      "window:focus-pane-on-left": function () {
        return primaryWorkspaceElement(this).focusPaneViewOnLeft();
      },
      "window:focus-pane-on-right": function () {
        return primaryWorkspaceElement(this).focusPaneViewOnRight();
      },
      "window:move-active-item-to-pane-above": function () {
        return primaryWorkspaceElement(this).moveActiveItemToPaneAbove();
      },
      "window:move-active-item-to-pane-below": function () {
        return primaryWorkspaceElement(this).moveActiveItemToPaneBelow();
      },
      "window:move-active-item-to-pane-on-left": function () {
        return primaryWorkspaceElement(this).moveActiveItemToPaneOnLeft();
      },
      "window:move-active-item-to-pane-on-right": function () {
        return primaryWorkspaceElement(this).moveActiveItemToPaneOnRight();
      },
      "window:copy-active-item-to-pane-above": function () {
        return primaryWorkspaceElement(this).moveActiveItemToPaneAbove({
          keepOriginal: true,
        });
      },
      "window:copy-active-item-to-pane-below": function () {
        return primaryWorkspaceElement(this).moveActiveItemToPaneBelow({
          keepOriginal: true,
        });
      },
      "window:copy-active-item-to-pane-on-left": function () {
        return primaryWorkspaceElement(this).moveActiveItemToPaneOnLeft({
          keepOriginal: true,
        });
      },
      "window:copy-active-item-to-pane-on-right": function () {
        return primaryWorkspaceElement(this).moveActiveItemToPaneOnRight({
          keepOriginal: true,
        });
      },
      "window:save-all": function () {
        return settleSaveCommand(this.getModel().saveAll());
      },
      "window:toggle-invisibles": {
        description: "Show or hide the marks standing for spaces, tabs and line ends.",
        didDispatch: function () {
          return config.set("editor.showInvisibles", !config.get("editor.showInvisibles"));
        },
      },
      "git:colorize-toggle": {
        description: "Turn the Git status colouring off across this window.",
        didDispatch: function () {
          this.getModel()
            .getActiveWindowSurface()
            ?.document.body.classList.toggle("git-colorize-disabled");
        },
      },
      "window:log-deprecation-warnings": {
        description: "Print the deprecated API calls made so far to the console.",
        didDispatch: function () {
          return Grim.logDeprecations();
        },
      },
      "window:toggle-auto-indent": {
        description: "Turn automatic indentation of newly typed lines on or off.",
        didDispatch: function () {
          return config.set("editor.autoIndent", !config.get("editor.autoIndent"));
        },
      },
      "pane:reopen-closed-item": {
        description: "Open the tab that was closed most recently.",
        didDispatch: function () {
          return this.getModel().reopenItem();
        },
      },
      "core:close": {
        description: "Close the active tab, or the empty pane, or the window.",
        didDispatch: function () {
          return this.getModel().closeActivePaneItemOrEmptyPaneOrWindow();
        },
      },
      "pane:detach-item": {
        description: "Move the targeted or active workspace-center item into its own window.",
        didDispatch: function (event) {
          const workspace = this.getModel();
          const item = paneItemForCommandTarget(workspace, event.target);
          if (item) return workspace.detachPaneItem(item);
        },
      },
      "core:save": function () {
        return settleSaveCommand(this.getModel().saveActivePaneItem());
      },
      "core:save-as": function () {
        return this.getModel().saveActivePaneItemAs();
      },
      "modal:go-back": {
        hiddenInCommandPalette: true,
        didDispatch() {
          return this.getModel().popModal();
        },
      },
    },
    false,
  );
  if (process.platform === "darwin") {
    commandRegistry.add(
      "lumine-workspace",
      {
        "application:hide": function () {
          return ipcRenderer.send("command", "application:hide");
        },
        "application:hide-other-applications": function () {
          return ipcRenderer.send("command", "application:hide-other-applications");
        },
        "application:unhide-all-applications": function () {
          return ipcRenderer.send("command", "application:unhide-all-applications");
        },
        "application:bring-all-windows-to-front": function () {
          return ipcRenderer.send("command", "application:bring-all-windows-to-front");
        },
        "window:install-shell-commands": {
          description: "Put the lumine and lumine-code commands on your shell path.",
          didDispatch: function () {
            return commandInstaller.installShellCommandsInteractively();
          },
        },
      },
      false,
    );
  }
  commandRegistry.add(
    "lumine-dock",
    {
      "dock:hide": {
        description: "Hide this dock.",
        didDispatch: function () {
          const workspace = this.closest("lumine-workspace")?.getModel?.();
          const dock = [
            workspace?.getLeftDock(),
            workspace?.getRightDock(),
            workspace?.getBottomDock(),
          ].find((candidate) => candidate?.getElement() === this);
          return dock?.hide();
        },
      },
    },
    false,
  );
  commandRegistry.add(
    "lumine-pane",
    {
      "pane:save-items": {
        description: "Save every unsaved tab in this pane.",
        didDispatch: function () {
          return settleSaveCommand(this.getModel().saveItems());
        },
      },
      "pane:split-left": {
        description: "Open an empty pane to the left of this one.",
        didDispatch: function () {
          return this.getModel().splitLeft();
        },
      },
      "pane:split-right": {
        description: "Open an empty pane to the right of this one.",
        didDispatch: function () {
          return this.getModel().splitRight();
        },
      },
      "pane:split-up": {
        description: "Open an empty pane above this one.",
        didDispatch: function () {
          return this.getModel().splitUp();
        },
      },
      "pane:split-down": {
        description: "Open an empty pane below this one.",
        didDispatch: function () {
          return this.getModel().splitDown();
        },
      },
      "pane:split-left-and-copy-active-item": function () {
        return this.getModel().splitLeft({
          copyActiveItem: true,
        });
      },
      "pane:split-right-and-copy-active-item": function () {
        return this.getModel().splitRight({
          copyActiveItem: true,
        });
      },
      "pane:split-up-and-copy-active-item": function () {
        return this.getModel().splitUp({
          copyActiveItem: true,
        });
      },
      "pane:split-down-and-copy-active-item": function () {
        return this.getModel().splitDown({
          copyActiveItem: true,
        });
      },
      "pane:split-left-and-move-active-item": function () {
        return this.getModel().splitLeft({
          moveActiveItem: true,
        });
      },
      "pane:split-right-and-move-active-item": function () {
        return this.getModel().splitRight({
          moveActiveItem: true,
        });
      },
      "pane:split-up-and-move-active-item": function () {
        return this.getModel().splitUp({
          moveActiveItem: true,
        });
      },
      "pane:split-down-and-move-active-item": function () {
        return this.getModel().splitDown({
          moveActiveItem: true,
        });
      },
      "pane:close": {
        description: "Close every tab in this pane, and the pane with them.",
        didDispatch: function () {
          return this.getModel().close();
        },
      },
      "pane:close-other-items": {
        description: "Close every tab in this pane except the active one.",
        didDispatch: function () {
          return this.getModel().destroyInactiveItems();
        },
      },
      "pane:increase-size": {
        description: "Grow this pane, taking the space from the panes beside it.",
        didDispatch: function () {
          return this.getModel().increaseSize();
        },
      },
      "pane:decrease-size": {
        description: "Shrink this pane, giving the space to the panes beside it.",
        didDispatch: function () {
          return this.getModel().decreaseSize();
        },
      },
    },
    false,
  );
  commandRegistry.add(
    "lumine-text-editor",
    stopEventPropagation({
      "core:move-left": function () {
        return this.moveLeft();
      },
      "core:move-right": function () {
        return this.moveRight();
      },
      "core:select-left": function () {
        return this.selectLeft();
      },
      "core:select-right": function () {
        return this.selectRight();
      },
      "core:select-up": function () {
        return this.selectUp();
      },
      "core:select-down": function () {
        return this.selectDown();
      },
      "core:select-all": function () {
        return this.selectAll();
      },
      "editor:select-word": function () {
        return this.selectWordsContainingCursors();
      },
      "editor:select-subword": {
        description: "Select the camelCase or snake_case part under each cursor.",
        didDispatch: function () {
          return this.selectSubwordsContainingCursors();
        },
      },
      "editor:consolidate-selections": {
        description: "Drop every selection but the one added most recently.",
        didDispatch: function (event) {
          if (!this.consolidateSelections()) {
            return event.abortKeyBinding();
          }
        },
      },
      "editor:move-to-beginning-of-next-paragraph": function () {
        return this.moveToBeginningOfNextParagraph();
      },
      "editor:move-to-beginning-of-previous-paragraph": function () {
        return this.moveToBeginningOfPreviousParagraph();
      },
      "editor:move-to-beginning-of-screen-line": {
        description: "Move to the start of the wrapped row, not of the whole line.",
        didDispatch: function () {
          return this.moveToBeginningOfScreenLine();
        },
      },
      "editor:move-to-beginning-of-line": function () {
        return this.moveToBeginningOfLine();
      },
      "editor:move-to-end-of-screen-line": {
        description: "Move to the end of the wrapped row, not of the whole line.",
        didDispatch: function () {
          return this.moveToEndOfScreenLine();
        },
      },
      "editor:move-to-end-of-line": function () {
        return this.moveToEndOfLine();
      },
      "editor:move-to-first-character-of-line": {
        description: "Move to the first character of the line past its indentation.",
        didDispatch: function () {
          return this.moveToFirstCharacterOfLine();
        },
      },
      "editor:move-to-beginning-of-word": function () {
        return this.moveToBeginningOfWord();
      },
      "editor:move-to-end-of-word": function () {
        return this.moveToEndOfWord();
      },
      "editor:move-to-beginning-of-next-word": function () {
        return this.moveToBeginningOfNextWord();
      },
      "editor:move-to-previous-word-boundary": function () {
        return this.moveToPreviousWordBoundary();
      },
      "editor:move-to-next-word-boundary": function () {
        return this.moveToNextWordBoundary();
      },
      "editor:move-to-previous-subword-boundary": function () {
        return this.moveToPreviousSubwordBoundary();
      },
      "editor:move-to-next-subword-boundary": function () {
        return this.moveToNextSubwordBoundary();
      },
      "editor:select-to-beginning-of-next-paragraph": function () {
        return this.selectToBeginningOfNextParagraph();
      },
      "editor:select-to-beginning-of-previous-paragraph": function () {
        return this.selectToBeginningOfPreviousParagraph();
      },
      "editor:select-to-end-of-line": function () {
        return this.selectToEndOfLine();
      },
      "editor:select-to-beginning-of-line": function () {
        return this.selectToBeginningOfLine();
      },
      "editor:select-to-end-of-word": function () {
        return this.selectToEndOfWord();
      },
      "editor:select-to-beginning-of-word": function () {
        return this.selectToBeginningOfWord();
      },
      "editor:select-to-beginning-of-next-word": function () {
        return this.selectToBeginningOfNextWord();
      },
      "editor:select-to-next-word-boundary": function () {
        return this.selectToNextWordBoundary();
      },
      "editor:select-to-previous-word-boundary": function () {
        return this.selectToPreviousWordBoundary();
      },
      "editor:select-to-next-subword-boundary": function () {
        return this.selectToNextSubwordBoundary();
      },
      "editor:select-to-previous-subword-boundary": function () {
        return this.selectToPreviousSubwordBoundary();
      },
      "editor:select-to-first-character-of-line": function () {
        return this.selectToFirstCharacterOfLine();
      },
      "editor:select-line": function () {
        return this.selectLinesContainingCursors();
      },
      "editor:select-larger-syntax-node": {
        description: "Grow the selection to the enclosing node of the syntax tree.",
        didDispatch: function () {
          return this.selectLargerSyntaxNode();
        },
      },
      "editor:select-smaller-syntax-node": {
        description: "Shrink the selection back towards the node it grew from.",
        didDispatch: function () {
          return this.selectSmallerSyntaxNode();
        },
      },
    }),
    false,
  );
  commandRegistry.add(
    "lumine-text-editor:not([readonly])",
    stopEventPropagation({
      "core:undo": function () {
        return this.undo();
      },
      "core:redo": function () {
        return this.redo();
      },
    }),
    false,
  );
  commandRegistry.add(
    "lumine-text-editor",
    stopEventPropagationAndGroupUndo(config, {
      "core:copy": {
        description: "Copy the selection, or the whole line when nothing is selected.",
        didDispatch: function () {
          return this.getElement().copySelectedText();
        },
      },
      "editor:copy-selection": {
        description: "Copy the selection alone, never the whole line when nothing is selected.",
        didDispatch: function () {
          return this.getElement().copyOnlySelectedText();
        },
      },
    }),
    false,
  );
  commandRegistry.add(
    "lumine-text-editor:not([readonly])",
    stopEventPropagationAndGroupUndo(config, {
      "core:backspace": function () {
        return this.backspace();
      },
      "core:delete": function () {
        return this.delete();
      },
      "core:cut": {
        description: "Cut the selection, or the whole line when nothing is selected.",
        didDispatch: function () {
          return this.getElement().cutSelectedText();
        },
      },
      "core:paste": function (event) {
        return this.getElement().pasteText(undefined, event);
      },
      "editor:paste-without-reformatting": {
        description: "Paste as it is, with no re-indenting and no line-ending fix.",
        didDispatch: function (event) {
          return this.getElement().pasteText(
            {
              normalizeLineEndings: false,
              autoIndent: false,
              preserveTrailingLineIndentation: true,
              skipPasteProviders: true,
            },
            event,
          );
        },
      },
      "editor:delete-to-previous-word-boundary": function () {
        return this.deleteToPreviousWordBoundary();
      },
      "editor:delete-to-next-word-boundary": function () {
        return this.deleteToNextWordBoundary();
      },
      "editor:delete-to-beginning-of-word": function () {
        return this.deleteToBeginningOfWord();
      },
      "editor:delete-to-beginning-of-line": function () {
        return this.deleteToBeginningOfLine();
      },
      "editor:delete-to-end-of-line": function () {
        return this.deleteToEndOfLine();
      },
      "editor:delete-to-end-of-word": function () {
        return this.deleteToEndOfWord();
      },
      "editor:delete-to-beginning-of-subword": function () {
        return this.deleteToBeginningOfSubword();
      },
      "editor:delete-to-end-of-subword": function () {
        return this.deleteToEndOfSubword();
      },
      "editor:delete-line": function () {
        return this.deleteLine();
      },
      "editor:cut-to-end-of-line": {
        description: "Cut to the end of the wrapped row, not of the whole line.",
        didDispatch: function () {
          return this.cutToEndOfLine();
        },
      },
      "editor:cut-to-end-of-buffer-line": {
        description: "Cut to the end of the whole line, however it is wrapped.",
        didDispatch: function () {
          return this.cutToEndOfBufferLine();
        },
      },
      "editor:transpose": {
        description: "Swap the two characters around each cursor.",
        didDispatch: function () {
          return this.transpose();
        },
      },
      "editor:upper-case": function () {
        return this.upperCase();
      },
      "editor:lower-case": function () {
        return this.lowerCase();
      },
    }),
    false,
  );
  commandRegistry.add(
    "lumine-text-editor:not([mini])",
    stopEventPropagation({
      "core:move-up": function () {
        return this.moveUp();
      },
      "core:move-down": function () {
        return this.moveDown();
      },
      "core:move-to-top": function () {
        return this.moveToTop();
      },
      "core:move-to-bottom": function () {
        return this.moveToBottom();
      },
      "core:page-up": function () {
        return this.pageUp();
      },
      "core:page-down": function () {
        return this.pageDown();
      },
      "core:select-to-top": function () {
        return this.selectToTop();
      },
      "core:select-to-bottom": function () {
        return this.selectToBottom();
      },
      "core:select-page-up": function () {
        return this.selectPageUp();
      },
      "core:select-page-down": function () {
        return this.selectPageDown();
      },
      "editor:add-selection-below": function () {
        return this.addSelectionBelow();
      },
      "editor:add-selection-above": function () {
        return this.addSelectionAbove();
      },
      "editor:split-selections-into-lines": {
        description: "Break each multi-line selection into one selection per line.",
        didDispatch: function () {
          return this.splitSelectionsIntoLines();
        },
      },
      "editor:toggle-soft-tabs": {
        description: "Switch between indenting with spaces and with tab characters.",
        didDispatch: function () {
          return this.toggleSoftTabs();
        },
      },
      "editor:toggle-soft-wrap": function () {
        return this.toggleSoftWrapped();
      },
      "editor:fold-all": function () {
        return this.foldAll();
      },
      "editor:unfold-all": function () {
        return this.unfoldAll();
      },
      "editor:fold-current-row": function () {
        this.foldCurrentRow();
        return this.scrollToCursorPosition();
      },
      "editor:unfold-current-row": function () {
        this.unfoldCurrentRow();
        return this.scrollToCursorPosition();
      },
      "editor:fold-selection": function () {
        return this.foldSelectedLines();
      },
      "editor:fold-at-indent-level-1": function () {
        this.foldAllAtIndentLevel(0);
        return this.scrollToCursorPosition();
      },
      "editor:fold-at-indent-level-2": function () {
        this.foldAllAtIndentLevel(1);
        return this.scrollToCursorPosition();
      },
      "editor:fold-at-indent-level-3": function () {
        this.foldAllAtIndentLevel(2);
        return this.scrollToCursorPosition();
      },
      "editor:fold-at-indent-level-4": function () {
        this.foldAllAtIndentLevel(3);
        return this.scrollToCursorPosition();
      },
      "editor:fold-at-indent-level-5": function () {
        this.foldAllAtIndentLevel(4);
        return this.scrollToCursorPosition();
      },
      "editor:fold-at-indent-level-6": function () {
        this.foldAllAtIndentLevel(5);
        return this.scrollToCursorPosition();
      },
      "editor:fold-at-indent-level-7": function () {
        this.foldAllAtIndentLevel(6);
        return this.scrollToCursorPosition();
      },
      "editor:fold-at-indent-level-8": function () {
        this.foldAllAtIndentLevel(7);
        return this.scrollToCursorPosition();
      },
      "editor:fold-at-indent-level-9": function () {
        this.foldAllAtIndentLevel(8);
        return this.scrollToCursorPosition();
      },
      "editor:log-cursor-scope": {
        description: "Show the grammar scopes that apply at the cursor.",
        didDispatch: function () {
          return showCursorScope(this.getCursorScope(), notificationManager);
        },
      },
      "editor:validate-grammar-queries": {
        description: "Report the errors in this Tree-sitter grammar's own queries.",
        didDispatch: function () {
          let languageMode = this.getBuffer().getLanguageMode();
          if (typeof languageMode.validateGrammarQueries !== "function") {
            notificationManager.addInfo("This buffer does not use a Tree-sitter grammar.");
            return;
          }
          return languageMode.validateGrammarQueries();
        },
      },
      "editor:log-cursor-syntax-tree-scope": {
        description: "Show the syntax tree nodes that contain the cursor.",
        didDispatch: function () {
          return showSyntaxTree(this.getCursorSyntaxTreeScope(), notificationManager);
        },
      },
      "editor:copy-path": {
        description: "Copy this file's full path from the filesystem root.",
        didDispatch: function () {
          return copyPathToClipboard(this, project, clipboard, false);
        },
      },
      "editor:copy-project-path": {
        description: "Copy this file's path relative to the project root.",
        didDispatch: function () {
          return copyPathToClipboard(this, project, clipboard, true);
        },
      },
      "editor:toggle-line-numbers": function () {
        return config.set("editor.showLineNumbers", !config.get("editor.showLineNumbers"));
      },
      "editor:scroll-to-cursor": function () {
        return this.scrollToCursorPosition();
      },
      "editor:scroll-up": {
        description: "Scroll the view up, leaving the cursor where it is.",
        didDispatch: function () {
          return scrollEditorByPage(this, -1);
        },
      },
      "editor:scroll-down": {
        description: "Scroll the view down, leaving the cursor where it is.",
        didDispatch: function () {
          return scrollEditorByPage(this, 1);
        },
      },
      "editor:increase-scroll-distance": {
        description: "Double how far the scroll commands move, up to 64 screens.",
        didDispatch: function () {
          return this.update({
            scrollCommandDistance: Math.min(64, this.getScrollCommandDistance() * 2),
          });
        },
      },
      "editor:decrease-scroll-distance": {
        description: "Halve how far the scroll commands move, down to a 64th.",
        didDispatch: function () {
          return this.update({
            scrollCommandDistance: Math.max(0.015625, this.getScrollCommandDistance() / 2),
          });
        },
      },
    }),
    false,
  );
  return commandRegistry.add(
    "lumine-text-editor:not([mini]):not([readonly])",
    stopEventPropagationAndGroupUndo(config, {
      "editor:indent": {
        description: "Indent at the cursor, as pressing Tab does.",
        didDispatch: function () {
          return this.indent();
        },
      },
      "editor:auto-indent": {
        description: "Re-indent the selected rows to the grammar's own rules.",
        didDispatch: function () {
          return this.autoIndentSelectedRows();
        },
      },
      "editor:indent-selected-rows": {
        description: "Indent every selected row by one level.",
        didDispatch: function () {
          return this.indentSelectedRows();
        },
      },
      "editor:outdent-selected-rows": function () {
        return this.outdentSelectedRows();
      },
      "editor:newline": function () {
        return this.insertNewline();
      },
      "editor:newline-below": function () {
        return this.insertNewlineBelow();
      },
      "editor:newline-above": function () {
        return this.insertNewlineAbove();
      },
      "editor:toggle-line-comments": function () {
        return this.toggleLineCommentsInSelection();
      },
      "editor:checkout-head-revision": {
        description: "Discard this file's changes and restore it from Git HEAD.",
        didDispatch: function () {
          return lumine.workspace.checkoutHeadRevision(this);
        },
      },
      "editor:move-line-up": function () {
        return this.moveLineUp();
      },
      "editor:move-line-down": function () {
        return this.moveLineDown();
      },
      "editor:move-selection-left": {
        description: "Shift the selected text one column left, taking the selection.",
        didDispatch: function () {
          return this.moveSelectionLeft();
        },
      },
      "editor:move-selection-right": {
        description: "Shift the selected text one column right, taking the selection.",
        didDispatch: function () {
          return this.moveSelectionRight();
        },
      },
      "editor:duplicate-lines": function () {
        return this.duplicateLines();
      },
      "editor:join-lines": function () {
        return this.joinLines();
      },
      "editor:delete-to-next-line-content": {
        description: "Delete forward to the first character of the next line.",
        didDispatch: function () {
          return this.deleteToNextLineContent();
        },
      },
      "editor:collapse-blank-lines": {
        description: "Reduce every run of blank lines in the file to a single one.",
        didDispatch: function () {
          return this.collapseBlankLines();
        },
      },
      "editor:collapse-content-spaces": {
        description: "Reduce runs of spaces to one, leaving the indentation alone.",
        didDispatch: function () {
          return this.collapseContentSpaces();
        },
      },
    }),
    false,
  );
};

// Puts a listener back together around a handler of the wrapper's own making,
// keeping whatever else it carried. A listener is either a bare handler or a
// descriptor whose `didDispatch` is the handler and whose remaining keys —
// `description` above all — are the metadata `extractDescriptor` keeps and the
// palette shows. Both wrappers below substitute the handler, so each has to
// carry those keys across itself: returning a bare function would drop every
// one of them, and writing a descriptor into a map that reached an unwrapped
// wrapper would leave it calling `.call` on an object.
const rewrapCommandListener = function (listener, wrap) {
  const didDispatch = typeof listener === "function" ? listener : listener.didDispatch;
  const wrapped = wrap(didDispatch);
  return typeof listener === "function" ? wrapped : { ...listener, didDispatch: wrapped };
};

var stopEventPropagation = function (commandListeners) {
  const newCommandListeners = {};
  for (let commandName in commandListeners) {
    newCommandListeners[commandName] = rewrapCommandListener(
      commandListeners[commandName],
      (didDispatch) =>
        function (event) {
          event.stopPropagation();
          return didDispatch.call(this.getModel(), event);
        },
    );
  }
  return newCommandListeners;
};

var stopEventPropagationAndGroupUndo = function (config, commandListeners) {
  const newCommandListeners = {};
  for (let commandName in commandListeners) {
    newCommandListeners[commandName] = rewrapCommandListener(
      commandListeners[commandName],
      (didDispatch) =>
        function (event) {
          event.stopPropagation();
          const model = this.getModel();
          model.transact(model.getUndoGroupingInterval(), () => didDispatch.call(model, event));
        },
    );
  }
  return newCommandListeners;
};

var showCursorScope = function (descriptor, notificationManager) {
  let list = descriptor.scopes.toString().split(",");
  list = list.map((item) => `* ${item}`);
  const content = `Scopes at Cursor\n${list.join("\n")}`;
  return notificationManager.addInfo(content, { dismissable: true });
};

var showSyntaxTree = function (descriptor, notificationManager) {
  let list = descriptor.scopes.toString().split(",");
  list = list.map((item) => `* ${item}`);
  const content = `Syntax tree at Cursor\n${list.join("\n")}`;
  return notificationManager.addInfo(content, { dismissable: true });
};

var copyPathToClipboard = function (editor, project, clipboard, relative) {
  let filePath;
  if ((filePath = editor.getPath())) {
    if (relative) {
      filePath = project.relativize(filePath);
    }
    clipboard.write(filePath);
  }
};

var scrollEditorByPage = function (editor, direction) {
  const element = editor.getElement();
  if (!element) return;
  const component = element.getComponent();
  const deltaY = direction * element.offsetHeight * editor.getScrollCommandDistance();

  if (editor.getSmoothScrolling()) {
    // reset: true restarts the glide from the current position, so rapid
    // repeated invocations don't accumulate an unbounded target.
    const accepted = component.scrollAnimator.scrollBy({
      y: deltaY,
      smoothness: editor.getCommandSmoothness(),
      reset: true,
    });
    if (accepted) {
      // The user took over the viewport; stop pinning the inherited anchor.
      component.settlingScrollAnchor = null;
    }
  } else {
    if (component.setScrollTop(component.getScrollTop() + deltaY)) {
      // The user took over the viewport; stop pinning the inherited anchor.
      component.settlingScrollAnchor = null;
      component.updateSync();
    }
  }
};
