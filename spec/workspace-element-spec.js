const { ipcRenderer } = require("electron");
const etch = require("@lumine-code/etch");
const path = require("path");
const temp = require("@lumine-code/temp").track();

const { conditionPromise } = require("./helpers/async-spec-helpers");

const getNextUpdatePromise = () => etch.getScheduler().nextUpdatePromise;

describe("WorkspaceElement", () => {
  it("registers only Lumine custom element names", () => {
    for (const name of [
      "workspace",
      "text-editor",
      "pane",
      "pane-axis",
      "pane-container",
      "pane-resize-handle",
      "panel-container",
      "styles",
    ]) {
      expect(window.customElements.get(`lumine-${name}`)).toBeDefined();
      expect(window.customElements.get(`atom-${name}`)).toBeUndefined();
    }
  });

  afterEach(() => {
    try {
      temp.cleanupSync();
    } catch {
      // Do nothing
    }
  });

  describe("when the workspace element is focused", () => {
    jasmine.itWithDocumentFocus("transfers focus to the active pane", () => {
      const workspaceElement = lumine.workspace.getElement();
      jasmine.attachToDOM(workspaceElement);
      const activePaneElement = lumine.workspace.getActivePane().getElement();
      document.body.focus();
      expect(document.activeElement).not.toBe(activePaneElement);
      workspaceElement.focus();
      expect(document.activeElement).toBe(activePaneElement);
    });
  });

  describe("when the active pane of an inactive pane container is focused", () => {
    jasmine.itWithDocumentFocus("changes the active pane container", () => {
      const dock = lumine.workspace.getLeftDock();
      dock.show();
      jasmine.attachToDOM(lumine.workspace.getElement());
      expect(lumine.workspace.getActivePaneContainer()).toBe(lumine.workspace.getCenter());
      dock.getActivePane().getElement().focus();
      expect(lumine.workspace.getActivePaneContainer()).toBe(dock);
    });
  });

  jasmine.describeWithDocumentFocus(
    "finding the nearest visible pane in a specific direction",
    () => {
      let nearestPaneElement,
        pane1,
        pane2,
        pane3,
        pane4,
        pane5,
        pane6,
        pane7,
        pane8,
        leftDockPane,
        rightDockPane,
        bottomDockPane,
        workspace,
        workspaceElement;

      beforeEach(function () {
        lumine.config.set("core.destroyEmptyPanes", false);

        workspace = lumine.workspace;

        // Set up a workspace center with a grid of 9 panes, in the following
        // arrangement, where the numbers correspond to the variable names below.
        //
        // -------
        // |1|2|3|
        // -------
        // |4|5|6|
        // -------
        // |7|8|9|
        // -------

        const container = workspace.getActivePaneContainer();
        expect(container.getLocation()).toEqual("center");
        expect(container.getPanes().length).toEqual(1);

        pane1 = container.getActivePane();
        pane4 = pane1.splitDown();
        pane7 = pane4.splitDown();

        pane2 = pane1.splitRight();
        pane3 = pane2.splitRight();

        pane5 = pane4.splitRight();
        pane6 = pane5.splitRight();

        pane8 = pane7.splitRight();
        pane8.splitRight();

        const leftDock = workspace.getLeftDock();
        const rightDock = workspace.getRightDock();
        const bottomDock = workspace.getBottomDock();

        expect(leftDock.isVisible()).toBe(false);
        expect(rightDock.isVisible()).toBe(false);
        expect(bottomDock.isVisible()).toBe(false);

        expect(leftDock.getPanes().length).toBe(1);
        expect(rightDock.getPanes().length).toBe(1);
        expect(bottomDock.getPanes().length).toBe(1);

        leftDockPane = leftDock.getPanes()[0];
        rightDockPane = rightDock.getPanes()[0];
        bottomDockPane = bottomDock.getPanes()[0];

        workspaceElement = lumine.workspace.getElement();
        workspaceElement.style.height = "400px";
        workspaceElement.style.width = "400px";
        jasmine.attachToDOM(workspaceElement);
      });

      describe("finding the nearest pane above", () => {
        describe("when there are multiple rows above the pane", () => {
          it("returns the pane in the adjacent row above", () => {
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("above", pane8);
            expect(nearestPaneElement).toBe(pane5.getElement());
          });
        });

        describe("when there are no rows above the pane", () => {
          it("returns null", () => {
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("above", pane2);
            expect(nearestPaneElement).toBeUndefined(); // TODO Expect toBeNull()
          });
        });

        describe("when the bottom dock contains the pane", () => {
          it("returns the pane in the adjacent row above", () => {
            workspace.getBottomDock().show();
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection(
              "above",
              bottomDockPane,
            );
            expect(nearestPaneElement).toBe(pane7.getElement());
          });
        });
      });

      describe("finding the nearest pane below", () => {
        describe("when there are multiple rows below the pane", () => {
          it("returns the pane in the adjacent row below", () => {
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("below", pane2);
            expect(nearestPaneElement).toBe(pane5.getElement());
          });
        });

        describe("when there are no rows below the pane", () => {
          it("returns null", () => {
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("below", pane8);
            expect(nearestPaneElement).toBeUndefined(); // TODO Expect toBeNull()
          });
        });

        describe("when the bottom dock is visible", () => {
          describe("when the workspace center's bottommost row contains the pane", () => {
            it("returns the pane in the bottom dock's adjacent row below", () => {
              workspace.getBottomDock().show();
              nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("below", pane8);
              expect(nearestPaneElement).toBe(bottomDockPane.getElement());
            });
          });
        });
      });

      describe("finding the nearest pane to the left", () => {
        describe("when there are multiple columns to the left of the pane", () => {
          it("returns the pane in the adjacent column to the left", () => {
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("left", pane6);
            expect(nearestPaneElement).toBe(pane5.getElement());
          });
        });

        describe("when there are no columns to the left of the pane", () => {
          it("returns null", () => {
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("left", pane4);
            expect(nearestPaneElement).toBeUndefined(); // TODO Expect toBeNull()
          });
        });

        describe("when the right dock contains the pane", () => {
          it("returns the pane in the adjacent column to the left", () => {
            workspace.getRightDock().show();
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection(
              "left",
              rightDockPane,
            );
            expect(nearestPaneElement).toBe(pane3.getElement());
          });
        });

        describe("when the left dock is visible", () => {
          describe("when the workspace center's leftmost column contains the pane", () => {
            it("returns the pane in the left dock's adjacent column to the left", () => {
              workspace.getLeftDock().show();
              nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("left", pane4);
              expect(nearestPaneElement).toBe(leftDockPane.getElement());
            });
          });

          describe("when the bottom dock contains the pane", () => {
            it("returns the pane in the left dock's adjacent column to the left", () => {
              workspace.getLeftDock().show();
              workspace.getBottomDock().show();
              nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection(
                "left",
                bottomDockPane,
              );
              expect(nearestPaneElement).toBe(leftDockPane.getElement());
            });
          });
        });
      });

      describe("finding the nearest pane to the right", () => {
        describe("when there are multiple columns to the right of the pane", () => {
          it("returns the pane in the adjacent column to the right", () => {
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("right", pane4);
            expect(nearestPaneElement).toBe(pane5.getElement());
          });
        });

        describe("when there are no columns to the right of the pane", () => {
          it("returns null", () => {
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("right", pane6);
            expect(nearestPaneElement).toBeUndefined(); // TODO Expect toBeNull()
          });
        });

        describe("when the left dock contains the pane", () => {
          it("returns the pane in the adjacent column to the right", () => {
            workspace.getLeftDock().show();
            nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection(
              "right",
              leftDockPane,
            );
            expect(nearestPaneElement).toBe(pane1.getElement());
          });
        });

        describe("when the right dock is visible", () => {
          describe("when the workspace center's rightmost column contains the pane", () => {
            it("returns the pane in the right dock's adjacent column to the right", () => {
              workspace.getRightDock().show();
              nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection("right", pane6);
              expect(nearestPaneElement).toBe(rightDockPane.getElement());
            });
          });

          describe("when the bottom dock contains the pane", () => {
            it("returns the pane in the right dock's adjacent column to the right", () => {
              workspace.getRightDock().show();
              workspace.getBottomDock().show();
              nearestPaneElement = workspaceElement.nearestVisiblePaneInDirection(
                "right",
                bottomDockPane,
              );
              expect(nearestPaneElement).toBe(rightDockPane.getElement());
            });
          });
        });
      });
    },
  );

  jasmine.describeWithDocumentFocus(
    "changing focus, copying, and moving items directionally between panes",
    function () {
      let workspace, workspaceElement, startingPane;

      beforeEach(function () {
        lumine.config.set("core.destroyEmptyPanes", false);

        workspace = lumine.workspace;
        expect(workspace.getLeftDock().isVisible()).toBe(false);
        expect(workspace.getRightDock().isVisible()).toBe(false);
        expect(workspace.getBottomDock().isVisible()).toBe(false);

        const panes = workspace.getCenter().getPanes();
        expect(panes.length).toEqual(1);
        startingPane = panes[0];

        workspaceElement = lumine.workspace.getElement();
        workspaceElement.style.height = "400px";
        workspaceElement.style.width = "400px";
        jasmine.attachToDOM(workspaceElement);
      });

      describe("::focusPaneViewAbove()", function () {
        describe("when there is a row above the focused pane", () =>
          it("focuses up to the adjacent row", function () {
            const paneAbove = startingPane.splitUp();
            startingPane.activate();
            workspaceElement.focusPaneViewAbove();
            expect(document.activeElement).toBe(paneAbove.getElement());
          }));

        describe("when there are no rows above the focused pane", () =>
          it("keeps the current pane focused", function () {
            startingPane.activate();
            workspaceElement.focusPaneViewAbove();
            expect(document.activeElement).toBe(startingPane.getElement());
          }));
      });

      describe("::focusPaneViewBelow()", function () {
        describe("when there is a row below the focused pane", () =>
          it("focuses down to the adjacent row", function () {
            const paneBelow = startingPane.splitDown();
            startingPane.activate();
            workspaceElement.focusPaneViewBelow();
            expect(document.activeElement).toBe(paneBelow.getElement());
          }));

        describe("when there are no rows below the focused pane", () =>
          it("keeps the current pane focused", function () {
            startingPane.activate();
            workspaceElement.focusPaneViewBelow();
            expect(document.activeElement).toBe(startingPane.getElement());
          }));
      });

      describe("::focusPaneViewOnLeft()", function () {
        describe("when there is a column to the left of the focused pane", () =>
          it("focuses left to the adjacent column", function () {
            const paneOnLeft = startingPane.splitLeft();
            startingPane.activate();
            workspaceElement.focusPaneViewOnLeft();
            expect(document.activeElement).toBe(paneOnLeft.getElement());
          }));

        describe("when there are no columns to the left of the focused pane", () =>
          it("keeps the current pane focused", function () {
            startingPane.activate();
            workspaceElement.focusPaneViewOnLeft();
            expect(document.activeElement).toBe(startingPane.getElement());
          }));
      });

      describe("::focusPaneViewOnRight()", function () {
        describe("when there is a column to the right of the focused pane", () =>
          it("focuses right to the adjacent column", function () {
            const paneOnRight = startingPane.splitRight();
            startingPane.activate();
            workspaceElement.focusPaneViewOnRight();
            expect(document.activeElement).toBe(paneOnRight.getElement());
          }));

        describe("when there are no columns to the right of the focused pane", () =>
          it("keeps the current pane focused", function () {
            startingPane.activate();
            workspaceElement.focusPaneViewOnRight();
            expect(document.activeElement).toBe(startingPane.getElement());
          }));
      });

      describe("::moveActiveItemToPaneAbove(keepOriginal)", function () {
        describe("when there is a row above the focused pane", () =>
          it("moves the active item up to the adjacent row", function () {
            const item = document.createElement("div");
            const paneAbove = startingPane.splitUp();
            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.moveActiveItemToPaneAbove();
            expect(workspace.paneForItem(item)).toBe(paneAbove);
            expect(paneAbove.getActiveItem()).toBe(item);
          }));

        describe("when there are no rows above the focused pane", () =>
          it("keeps the active pane focused", function () {
            const item = document.createElement("div");
            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.moveActiveItemToPaneAbove();
            expect(workspace.paneForItem(item)).toBe(startingPane);
          }));

        describe("when `keepOriginal: true` is passed in the params", () =>
          it("keeps the item and adds a copy of it to the adjacent pane", function () {
            const itemA = document.createElement("div");
            const itemB = document.createElement("div");
            itemA.copy = () => itemB;
            const paneAbove = startingPane.splitUp();
            startingPane.activate();
            startingPane.activateItem(itemA);
            workspaceElement.moveActiveItemToPaneAbove({ keepOriginal: true });
            expect(workspace.paneForItem(itemA)).toBe(startingPane);
            expect(paneAbove.getActiveItem()).toBe(itemB);
          }));
      });

      describe("::moveActiveItemToPaneBelow(keepOriginal)", function () {
        describe("when there is a row below the focused pane", () =>
          it("moves the active item down to the adjacent row", function () {
            const item = document.createElement("div");
            const paneBelow = startingPane.splitDown();
            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.moveActiveItemToPaneBelow();
            expect(workspace.paneForItem(item)).toBe(paneBelow);
            expect(paneBelow.getActiveItem()).toBe(item);
          }));

        describe("when there are no rows below the focused pane", () =>
          it("keeps the active item in the focused pane", function () {
            const item = document.createElement("div");
            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.moveActiveItemToPaneBelow();
            expect(workspace.paneForItem(item)).toBe(startingPane);
          }));

        describe("when `keepOriginal: true` is passed in the params", () =>
          it("keeps the item and adds a copy of it to the adjacent pane", function () {
            const itemA = document.createElement("div");
            const itemB = document.createElement("div");
            itemA.copy = () => itemB;
            const paneBelow = startingPane.splitDown();
            startingPane.activate();
            startingPane.activateItem(itemA);
            workspaceElement.moveActiveItemToPaneBelow({ keepOriginal: true });
            expect(workspace.paneForItem(itemA)).toBe(startingPane);
            expect(paneBelow.getActiveItem()).toBe(itemB);
          }));
      });

      describe("::moveActiveItemToPaneOnLeft(keepOriginal)", function () {
        describe("when there is a column to the left of the focused pane", () =>
          it("moves the active item left to the adjacent column", function () {
            const item = document.createElement("div");
            const paneOnLeft = startingPane.splitLeft();
            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.moveActiveItemToPaneOnLeft();
            expect(workspace.paneForItem(item)).toBe(paneOnLeft);
            expect(paneOnLeft.getActiveItem()).toBe(item);
          }));

        describe("when there are no columns to the left of the focused pane", () =>
          it("keeps the active item in the focused pane", function () {
            const item = document.createElement("div");
            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.moveActiveItemToPaneOnLeft();
            expect(workspace.paneForItem(item)).toBe(startingPane);
          }));

        describe("when `keepOriginal: true` is passed in the params", () =>
          it("keeps the item and adds a copy of it to the adjacent pane", function () {
            const itemA = document.createElement("div");
            const itemB = document.createElement("div");
            itemA.copy = () => itemB;
            const paneOnLeft = startingPane.splitLeft();
            startingPane.activate();
            startingPane.activateItem(itemA);
            workspaceElement.moveActiveItemToPaneOnLeft({ keepOriginal: true });
            expect(workspace.paneForItem(itemA)).toBe(startingPane);
            expect(paneOnLeft.getActiveItem()).toBe(itemB);
          }));
      });

      describe("::moveActiveItemToPaneOnRight(keepOriginal)", function () {
        describe("when there is a column to the right of the focused pane", () =>
          it("moves the active item right to the adjacent column", function () {
            const item = document.createElement("div");
            const paneOnRight = startingPane.splitRight();
            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.moveActiveItemToPaneOnRight();
            expect(workspace.paneForItem(item)).toBe(paneOnRight);
            expect(paneOnRight.getActiveItem()).toBe(item);
          }));

        describe("when there are no columns to the right of the focused pane", () =>
          it("keeps the active item in the focused pane", function () {
            const item = document.createElement("div");
            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.moveActiveItemToPaneOnRight();
            expect(workspace.paneForItem(item)).toBe(startingPane);
          }));

        describe("when `keepOriginal: true` is passed in the params", () =>
          it("keeps the item and adds a copy of it to the adjacent pane", function () {
            const itemA = document.createElement("div");
            const itemB = document.createElement("div");
            itemA.copy = () => itemB;
            const paneOnRight = startingPane.splitRight();
            startingPane.activate();
            startingPane.activateItem(itemA);
            workspaceElement.moveActiveItemToPaneOnRight({ keepOriginal: true });
            expect(workspace.paneForItem(itemA)).toBe(startingPane);
            expect(paneOnRight.getActiveItem()).toBe(itemB);
          }));
      });

      describe("::moveActiveItemToNearestPaneInDirection(direction, params)", () => {
        describe("when the item is not allowed in nearest pane in the given direction", () => {
          it("does not move or copy the active item", function () {
            const item = {
              element: document.createElement("div"),
              getAllowedLocations: () => ["left", "right"],
            };

            workspace.getBottomDock().show();
            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.moveActiveItemToNearestPaneInDirection("below", {
              keepOriginal: false,
            });
            expect(workspace.paneForItem(item)).toBe(startingPane);

            workspaceElement.moveActiveItemToNearestPaneInDirection("below", {
              keepOriginal: true,
            });
            expect(workspace.paneForItem(item)).toBe(startingPane);
          });
        });

        describe("when the item doesn't implement a `copy` function", () => {
          it("does not copy the active item", function () {
            const item = document.createElement("div");
            const paneBelow = startingPane.splitDown();
            expect(paneBelow.getItems().length).toEqual(0);

            startingPane.activate();
            startingPane.activateItem(item);
            workspaceElement.focusPaneViewAbove();
            workspaceElement.moveActiveItemToNearestPaneInDirection("below", {
              keepOriginal: true,
            });
            expect(workspace.paneForItem(item)).toBe(startingPane);
            expect(paneBelow.getItems().length).toEqual(0);
          });
        });
      });
    },
  );

  describe("mousing over docks", () => {
    let workspaceElement;
    let originalTimeout = jasmine.getEnv().defaultTimeoutInterval;

    beforeEach(() => {
      workspaceElement = lumine.workspace.getElement();
      workspaceElement.style.width = "600px";
      workspaceElement.style.height = "300px";
      jasmine.attachToDOM(workspaceElement);

      // To isolate this test from unintended events happening on the host machine,
      // we remove any listener that could cause interferences.
      window.removeEventListener("mousemove", workspaceElement.handleEdgesMouseMove);
      workspaceElement.htmlElement.removeEventListener(
        "mouseleave",
        workspaceElement.handleCenterLeave,
      );

      jasmine.getEnv().defaultTimeoutInterval = 10000;
    });

    afterEach(() => {
      jasmine.getEnv().defaultTimeoutInterval = originalTimeout;

      window.addEventListener("mousemove", workspaceElement.handleEdgesMouseMove);
      workspaceElement.htmlElement.addEventListener(
        "mouseleave",
        workspaceElement.handleCenterLeave,
      );
    });

    it("shows the toggle button when the dock is open", async () => {
      await Promise.all([
        lumine.workspace.open({
          element: document.createElement("div"),
          getDefaultLocation() {
            return "left";
          },
          getPreferredWidth() {
            return 150;
          },
        }),
        lumine.workspace.open({
          element: document.createElement("div"),
          getDefaultLocation() {
            return "right";
          },
          getPreferredWidth() {
            return 150;
          },
        }),
        lumine.workspace.open({
          element: document.createElement("div"),
          getDefaultLocation() {
            return "bottom";
          },
          getPreferredHeight() {
            return 100;
          },
        }),
      ]);

      const leftDock = lumine.workspace.getLeftDock();
      const rightDock = lumine.workspace.getRightDock();
      const bottomDock = lumine.workspace.getBottomDock();

      expect(leftDock.isVisible()).toBe(true);
      expect(rightDock.isVisible()).toBe(true);
      expect(bottomDock.isVisible()).toBe(true);
      expectToggleButtonHidden(leftDock);
      expectToggleButtonHidden(rightDock);
      expectToggleButtonHidden(bottomDock);

      // --- Right Dock ---

      // Mouse over where the toggle button would be if the dock were hovered
      moveMouse({ clientX: 440, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(leftDock);
      expectToggleButtonHidden(rightDock);
      expectToggleButtonHidden(bottomDock);

      // Mouse over the dock
      moveMouse({ clientX: 460, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(leftDock);
      expectToggleButtonVisible(rightDock, "icon-chevron-right");
      expectToggleButtonHidden(bottomDock);

      // Mouse over the toggle button
      moveMouse({ clientX: 440, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(leftDock);
      expectToggleButtonVisible(rightDock, "icon-chevron-right");
      expectToggleButtonHidden(bottomDock);

      // Click the toggle button
      rightDock.refs.toggleButton.refs.innerElement.click();
      await getNextUpdatePromise();
      expect(rightDock.isVisible()).toBe(false);
      expectToggleButtonHidden(rightDock);

      // Mouse to edge of the window
      moveMouse({ clientX: 575, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(rightDock);
      moveMouse({ clientX: 598, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonVisible(rightDock, "icon-chevron-left");

      // Click the toggle button again
      rightDock.refs.toggleButton.refs.innerElement.click();
      await getNextUpdatePromise();
      expect(rightDock.isVisible()).toBe(true);
      expectToggleButtonVisible(rightDock, "icon-chevron-right");

      // --- Left Dock ---

      // Mouse over where the toggle button would be if the dock were hovered
      moveMouse({ clientX: 160, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(leftDock);
      expectToggleButtonHidden(rightDock);
      expectToggleButtonHidden(bottomDock);

      // Mouse over the dock
      moveMouse({ clientX: 140, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonVisible(leftDock, "icon-chevron-left");
      expectToggleButtonHidden(rightDock);
      expectToggleButtonHidden(bottomDock);

      // Mouse over the toggle button
      moveMouse({ clientX: 160, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonVisible(leftDock, "icon-chevron-left");
      expectToggleButtonHidden(rightDock);
      expectToggleButtonHidden(bottomDock);

      // Click the toggle button
      leftDock.refs.toggleButton.refs.innerElement.click();
      await getNextUpdatePromise();
      expect(leftDock.isVisible()).toBe(false);
      expectToggleButtonHidden(leftDock);

      // Mouse to edge of the window
      moveMouse({ clientX: 25, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(leftDock);
      moveMouse({ clientX: 2, clientY: 150 });
      await getNextUpdatePromise();
      expectToggleButtonVisible(leftDock, "icon-chevron-right");

      // Click the toggle button again
      leftDock.refs.toggleButton.refs.innerElement.click();
      await getNextUpdatePromise();
      expect(leftDock.isVisible()).toBe(true);
      expectToggleButtonVisible(leftDock, "icon-chevron-left");

      // --- Bottom Dock ---

      // Mouse over where the toggle button would be if the dock were hovered
      moveMouse({ clientX: 300, clientY: 190 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(leftDock);
      expectToggleButtonHidden(rightDock);
      expectToggleButtonHidden(bottomDock);

      // Mouse over the dock
      moveMouse({ clientX: 300, clientY: 210 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(leftDock);
      expectToggleButtonHidden(rightDock);
      expectToggleButtonVisible(bottomDock, "icon-chevron-down");

      // Mouse over the toggle button
      moveMouse({ clientX: 300, clientY: 195 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(leftDock);
      expectToggleButtonHidden(rightDock);
      expectToggleButtonVisible(bottomDock, "icon-chevron-down");

      // Click the toggle button
      bottomDock.refs.toggleButton.refs.innerElement.click();
      await getNextUpdatePromise();
      expect(bottomDock.isVisible()).toBe(false);
      expectToggleButtonHidden(bottomDock);

      // Mouse to edge of the window
      moveMouse({ clientX: 300, clientY: 290 });
      await getNextUpdatePromise();
      expectToggleButtonHidden(leftDock);
      moveMouse({ clientX: 300, clientY: 299 });
      await getNextUpdatePromise();
      expectToggleButtonVisible(bottomDock, "icon-chevron-up");

      // Click the toggle button again
      bottomDock.refs.toggleButton.refs.innerElement.click();
      await getNextUpdatePromise();
      expect(bottomDock.isVisible()).toBe(true);
      expectToggleButtonVisible(bottomDock, "icon-chevron-down");
    });

    // Coordinates below are relative to the workspace element, not to the
    // viewport. `pointWithinHoverArea` compares against
    // `getBoundingClientRect()`, so passing raw viewport pixels only works
    // while the workspace happens to start at the viewport origin — which it
    // does when this file runs alone and does not when the whole suite has
    // been leaving elements in the body before it.
    function moveMouse(coordinates) {
      const bounds = workspaceElement.getBoundingClientRect();
      // Simulate a mouse move event by calling the method that handles that event.
      workspaceElement.updateHoveredDock({
        x: bounds.left + coordinates.clientX,
        y: bounds.top + coordinates.clientY,
      });
      advanceClock(100);
    }

    function expectToggleButtonHidden(dock) {
      expect(dock.refs.toggleButton.element).not.toHaveClass("lumine-dock-toggle-button-visible");
    }

    function expectToggleButtonVisible(dock, iconClass) {
      expect(dock.refs.toggleButton.element).toHaveClass("lumine-dock-toggle-button-visible");
      expect(dock.refs.toggleButton.refs.iconElement).toHaveClass(iconClass);
    }
  });

  describe("the scrollbar visibility class", () => {
    it("has a class based on the style of the scrollbar", () => {
      const workspaceElement = lumine.workspace.getElement();
      jasmine.attachToDOM(workspaceElement);

      // The initial value is measured from how this window actually renders
      // scrollbars, so it's platform-dependent — but it's always one of the
      // two known styles.
      expect(
        workspaceElement.classList.contains("scrollbars-visible-always") ||
          workspaceElement.classList.contains("scrollbars-visible-when-scrolling"),
      ).toBe(true);

      // Style changes are pushed from the main process over IPC.
      ipcRenderer.emit("did-change-scrollbar-style", {}, "legacy");
      expect(workspaceElement).toHaveClass("scrollbars-visible-always");
      expect(workspaceElement).not.toHaveClass("scrollbars-visible-when-scrolling");

      ipcRenderer.emit("did-change-scrollbar-style", {}, "overlay");
      expect(workspaceElement).toHaveClass("scrollbars-visible-when-scrolling");
      expect(workspaceElement).not.toHaveClass("scrollbars-visible-always");
    });
  });

  describe("editor font styling", () => {
    let editor, editorElement, workspaceElement;
    let originalPixelRatio = window.devicePixelRatio;

    beforeEach(async () => {
      await lumine.workspace.open("sample.js");

      workspaceElement = lumine.workspace.getElement();
      jasmine.attachToDOM(workspaceElement);
      editor = lumine.workspace.getActiveTextEditor();
      editorElement = editor.getElement();
    });

    afterEach(() => {
      window.devicePixelRatio = originalPixelRatio;
    });

    it("updates the font-size based on the 'editor.fontSize' config value", async () => {
      const initialCharWidth = editor.getDefaultCharWidth();
      expect(getComputedStyle(editorElement).fontSize).toBe(
        lumine.config.get("editor.fontSize") + "px",
      );

      await new Promise((resolve) => {
        editorElement.component.getNextUpdatePromise().then(() => resolve());

        lumine.config.set("editor.fontSize", lumine.config.get("editor.fontSize") + 5);
      });

      expect(getComputedStyle(editorElement).fontSize).toBe(
        lumine.config.get("editor.fontSize") + "px",
      );
      expect(editor.getDefaultCharWidth()).toBeGreaterThan(initialCharWidth);
    });

    it("updates the font-family based on the 'editor.fontFamily' config value", async () => {
      const initialCharWidth = editor.getDefaultCharWidth();
      let fontFamily = lumine.config.get("editor.fontFamily");
      expect(getComputedStyle(editorElement).fontFamily).toBe(fontFamily);

      await new Promise((resolve) => {
        editorElement.component.getNextUpdatePromise().then(() => resolve());
        lumine.config.set("editor.fontFamily", "sans-serif");
      });

      fontFamily = lumine.config.get("editor.fontFamily");
      expect(getComputedStyle(editorElement).fontFamily).toBe(fontFamily);
      expect(editor.getDefaultCharWidth()).not.toBe(initialCharWidth);
    });

    // These next few specs may trigger the behavior that aims to preserve a
    // `line-height` value that conforms to the hardware pixel grid.
    it("updates the line-height based on the 'editor.lineHeight' config value (when the value is a pixel measurement string)", async () => {
      const initialLineHeight = editor.getLineHeightInPixels();

      await new Promise((resolve) => {
        editorElement.component.getNextUpdatePromise().then(() => resolve());
        lumine.config.set("editor.lineHeight", "30px");
      });

      expect(getComputedStyle(editorElement).lineHeight).toBe(
        lumine.config.get("editor.lineHeight"),
      );
      expect(editor.getLineHeightInPixels()).not.toBe(initialLineHeight);
    });

    it("updates the line-height based on the 'editor.lineHeight' config value (when the value is given as a bare number that needs no rounding)", async () => {
      jasmine.useRealClock();
      const initialLineHeight = editor.getLineHeightInPixels();
      lumine.config.set("editor.fontSize", 16);
      lumine.config.set("editor.lineHeight", 1.875);
      let expectedValue = `${lumine.config.get("editor.fontSize") * lumine.config.get("editor.lineHeight")}px`;
      await conditionPromise(() => {
        return getComputedStyle(editorElement).lineHeight === expectedValue;
      });
      expect(getComputedStyle(editorElement).lineHeight).toBe(expectedValue);
      expect(editor.getLineHeightInPixels()).not.toBe(initialLineHeight);
    });

    it("adjusts the line-height to a value that is appropriate for the display's pixel density (when the value is given in pixels)", async () => {
      jasmine.useRealClock();
      const initialLineHeight = editor.getLineHeightInPixels();
      // It's weird that browsers expose this as a writable getter, but we'll
      // reset it to its original value when the tests are done.
      window.devicePixelRatio = 2;
      lumine.config.set("editor.fontSize", 16);
      lumine.config.set("editor.lineHeight", "27.2px");
      await conditionPromise(() => {
        return getComputedStyle(editorElement).lineHeight === "27px";
      });
      // The user has explicitly asked for a `line-height` of `27.2px`. When
      // there are two hardware pixels per software pixel, we can tolerate
      // values of 27px and 27.5px, but not 27.2px. Hence we round to the
      // nearest acceptable value.
      expect(getComputedStyle(editorElement).lineHeight).toBe("27px");
      expect(editor.getLineHeightInPixels()).not.toBe(initialLineHeight);
    });

    it("adjusts the line-height to a value that is appropriate for the display's pixel density (when the value is given as a bare number and needs rounding)", async () => {
      jasmine.useRealClock();
      const initialLineHeight = editor.getLineHeightInPixels();
      // It's weird that browsers expose this as a writable getter, but we'll
      // reset it to its original value when the tests are done.
      window.devicePixelRatio = 2;
      lumine.config.set("editor.fontSize", 16);
      lumine.config.set("editor.lineHeight", 1.7);
      await conditionPromise(() => {
        return getComputedStyle(editorElement).lineHeight === "27px";
      });
      // The ratio expressed would result in a line height of 27.2px. When
      // there are two hardware pixels per software pixel, we can tolerate
      // values of 27px and 27.5px, but not 27.2px. Hence we round to the
      // nearest acceptable value.
      expect(getComputedStyle(editorElement).lineHeight).toBe("27px");
      expect(editor.getLineHeightInPixels()).not.toBe(initialLineHeight);
    });

    // This last spec covers all cases where we opt out of adjusting the
    // `line-height` value. Since it can technically be any valid CSS
    // measurement, there are limits to our ability to adjust it.
    it("respects the specified 'editor.lineHeight' when the value is more exotic", async () => {
      jasmine.useRealClock();
      const initialLineHeight = editor.getLineHeightInPixels();
      // It's weird that browsers expose this as a writable getter, but we'll
      // reset it to its original value when the tests are done.
      window.devicePixelRatio = 2;
      lumine.config.set("editor.fontSize", 16);
      lumine.config.set("editor.lineHeight", "1.7em");
      await conditionPromise(() => {
        return getComputedStyle(editorElement).lineHeight === "27.2px";
      });
      // The ratio expressed would result in a line height of 27.2px. Since it
      // was specified in `em`, we don't try to normalize it to pixels, so
      // we'll allow the value even though it doesn't conform to the hardware
      // pixel grid.
      expect(getComputedStyle(editorElement).lineHeight).toBe("27.2px");
      expect(editor.getLineHeightInPixels()).not.toBe(initialLineHeight);
    });
  });

  describe("panel containers", () => {
    it("inserts panel container elements in the correct places in the DOM", () => {
      const workspaceElement = lumine.workspace.getElement();

      const leftContainer = workspaceElement.querySelector("lumine-panel-container.left");
      const rightContainer = workspaceElement.querySelector("lumine-panel-container.right");
      expect(leftContainer.nextSibling).toBe(workspaceElement.verticalAxis);
      expect(rightContainer.previousSibling).toBe(workspaceElement.verticalAxis);

      const topContainer = workspaceElement.querySelector("lumine-panel-container.top");
      const bottomContainer = workspaceElement.querySelector("lumine-panel-container.bottom");
      expect(topContainer.nextSibling).toBe(workspaceElement.paneContainer);
      expect(bottomContainer.previousSibling).toBe(workspaceElement.paneContainer);

      const headerContainer = workspaceElement.querySelector("lumine-panel-container.header");
      const footerContainer = workspaceElement.querySelector("lumine-panel-container.footer");
      expect(headerContainer.nextSibling).toBe(workspaceElement.horizontalAxis);
      expect(footerContainer.previousSibling).toBe(workspaceElement.horizontalAxis);

      const modalContainer = workspaceElement.querySelector("lumine-panel-container.modal");
      expect(modalContainer.parentNode).toBe(workspaceElement);
    });

    it("stretches header/footer panels to the workspace width", () => {
      const workspaceElement = lumine.workspace.getElement();
      jasmine.attachToDOM(workspaceElement);
      expect(workspaceElement.offsetWidth).toBeGreaterThan(0);

      const headerItem = document.createElement("div");
      lumine.workspace.addHeaderPanel({ item: headerItem });
      expect(headerItem.offsetWidth).toEqual(workspaceElement.offsetWidth);

      const footerItem = document.createElement("div");
      lumine.workspace.addFooterPanel({ item: footerItem });
      expect(footerItem.offsetWidth).toEqual(workspaceElement.offsetWidth);
    });

    it("shrinks horizontal axis according to header/footer panels height", () => {
      const workspaceElement = lumine.workspace.getElement();
      workspaceElement.style.height = "100px";
      const horizontalAxisElement = workspaceElement.querySelector(
        "lumine-workspace-axis.horizontal",
      );
      jasmine.attachToDOM(workspaceElement);

      const originalHorizontalAxisHeight = horizontalAxisElement.offsetHeight;
      expect(workspaceElement.offsetHeight).toBeGreaterThan(0);
      expect(originalHorizontalAxisHeight).toBeGreaterThan(0);

      const headerItem = document.createElement("div");
      headerItem.style.height = "10px";
      lumine.workspace.addHeaderPanel({ item: headerItem });
      expect(headerItem.offsetHeight).toBeGreaterThan(0);

      const footerItem = document.createElement("div");
      footerItem.style.height = "15px";
      lumine.workspace.addFooterPanel({ item: footerItem });
      expect(footerItem.offsetHeight).toBeGreaterThan(0);

      expect(horizontalAxisElement.offsetHeight).toEqual(
        originalHorizontalAxisHeight - headerItem.offsetHeight - footerItem.offsetHeight,
      );
    });
  });

  describe("splitting and copying an editor preserves the scroll position", () => {
    it("keeps the copied editor at the same visual position (diagnostic)", async () => {
      jasmine.useRealClock();
      const workspaceElement = lumine.workspace.getElement();
      workspaceElement.style.height = "400px";
      workspaceElement.style.width = "1000px";
      jasmine.attachToDOM(workspaceElement);

      lumine.config.set("language.softWrap", true);
      const editor = await lumine.workspace.open();
      const lines = [];
      for (let i = 0; i < 400; i++) lines.push(`line ${i} ` + "word ".repeat(30));
      editor.setText(lines.join("\n"));

      const sourceComponent = editor.getElement().component;
      await conditionPromise(
        () => sourceComponent.hasInitialMeasurements && sourceComponent.getMaxScrollTop() > 0,
      );
      await sourceComponent.getNextUpdatePromise();

      sourceComponent.setScrollTop(Math.round(sourceComponent.getMaxScrollTop() / 2));
      await sourceComponent.getNextUpdatePromise();

      const midPixel =
        sourceComponent.getScrollTop() + sourceComponent.getScrollContainerClientHeight() / 2;
      const midRow = sourceComponent.rowForPixelPosition(midPixel);
      const midBufferPosition = editor.bufferPositionForScreenPosition([midRow, 0]);

      lumine.workspace.getActivePane().splitRight({ copyActiveItem: true });
      const copyEditor = lumine.workspace.getActivePane().getActiveItem();
      const copyComponent = copyEditor.getElement().component;

      // Wait for the new pane to settle to roughly half the width.
      await conditionPromise(
        () =>
          copyComponent.hasInitialMeasurements &&
          copyComponent.getScrollContainerClientWidth() > 0 &&
          copyComponent.getScrollContainerClientWidth() < 600,
      );
      await copyComponent.getNextUpdatePromise();

      // The source pane reflows to the same half width in parallel and may
      // settle later than the copy; only once both panes agree on width and
      // wrapping are their absolute scroll positions comparable. Headless CI
      // windows don't reliably deliver ResizeObserver callbacks, so nudge both
      // components to re-measure on every poll, as a real resize event would.
      await conditionPromise(() => {
        sourceComponent.didResize();
        copyComponent.didResize();
        return (
          Math.abs(
            sourceComponent.getScrollContainerClientWidth() -
              copyComponent.getScrollContainerClientWidth(),
          ) <= 1 && editor.getScreenLineCount() === copyEditor.getScreenLineCount()
        );
      });

      const lineHeight = copyComponent.getLineHeight();
      const sourceRowAfter = editor.screenPositionForBufferPosition(midBufferPosition).row;
      const sourceOffsetAfter =
        sourceComponent.pixelPositionBeforeBlocksForRow(sourceRowAfter) -
        sourceComponent.getScrollTop();
      const copyRow = copyEditor.screenPositionForBufferPosition(midBufferPosition).row;
      const copyOffset =
        copyComponent.pixelPositionBeforeBlocksForRow(copyRow) - copyComponent.getScrollTop();

      // The copied editor lands on the same visual position as the source: the
      // anchored buffer row sits at the same viewport offset, and the overall
      // scroll matches (both panes now share the settled half width).
      expect(Math.abs(copyOffset - sourceOffsetAfter)).toBeLessThan(lineHeight);
      expect(Math.abs(copyComponent.getScrollTop() - sourceComponent.getScrollTop())).toBeLessThan(
        2 * lineHeight,
      );
    });
  });

  describe("destroying a large soft-wrapped editor while attached", () => {
    it("does not crash the renderer process (regression)", async () => {
      // Destroying an attached editor emits synchronous marker and decoration
      // events mid-teardown. With the synchronous updates used in specs,
      // rendering from those events repopulated the destroyed display layer's
      // spatial index and read the already-released buffer, crashing the
      // renderer process natively.
      jasmine.useRealClock();
      const workspaceElement = lumine.workspace.getElement();
      workspaceElement.style.height = "400px";
      workspaceElement.style.width = "1000px";
      jasmine.attachToDOM(workspaceElement);

      lumine.config.set("language.softWrap", true);
      const editor = await lumine.workspace.open();
      const lines = [];
      for (let i = 0; i < 400; i++) lines.push(`line ${i} ` + "word ".repeat(30));
      editor.setText(lines.join("\n"));

      const component = editor.getElement().component;
      await conditionPromise(
        () => component.hasInitialMeasurements && component.getMaxScrollTop() > 0,
      );
      await component.getNextUpdatePromise();
      expect(editor.getScreenLineCount()).toBeGreaterThan(400);

      editor.destroy();

      // Reaching this point without the renderer process crashing is the real
      // assertion of this spec.
      expect(editor.isDestroyed()).toBe(true);
    });
  });

  describe("the 'window:toggle-invisibles' command", () => {
    it("shows/hides invisibles in all open and future editors", () => {
      const workspaceElement = lumine.workspace.getElement();
      expect(lumine.config.get("language.showInvisibles")).toBe(false);
      lumine.commands.dispatch(workspaceElement, "window:toggle-invisibles");
      expect(lumine.config.get("language.showInvisibles")).toBe(true);
      lumine.commands.dispatch(workspaceElement, "window:toggle-invisibles");
      expect(lumine.config.get("language.showInvisibles")).toBe(false);
    });
  });

  describe("the 'git:colorize-toggle' command", () => {
    it("toggles git-status colorization for this window only", () => {
      const workspaceElement = lumine.workspace.getElement();
      expect(document.body.classList.contains("git-colorize-disabled")).toBe(false);
      lumine.commands.dispatch(workspaceElement, "git:colorize-toggle");
      expect(document.body.classList.contains("git-colorize-disabled")).toBe(true);
      lumine.commands.dispatch(workspaceElement, "git:colorize-toggle");
      expect(document.body.classList.contains("git-colorize-disabled")).toBe(false);
    });
  });

  describe("the 'window:run-package-specs' command", () => {
    it("runs the package specs for the active item's project path, or the first project path", () => {
      const workspaceElement = lumine.workspace.getElement();
      spyOn(ipcRenderer, "send");

      // No project paths. Don't try to run specs.
      lumine.commands.dispatch(workspaceElement, "window:run-package-specs");
      expect(ipcRenderer.send).not.toHaveBeenCalledWith("run-package-specs");

      const projectPaths = [temp.mkdirSync("dir1-"), temp.mkdirSync("dir2-")];
      lumine.project.setPaths(projectPaths);

      // No active item. Use first project directory.
      lumine.commands.dispatch(workspaceElement, "window:run-package-specs");
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        "run-package-specs",
        path.join(projectPaths[0], "spec"),
        {},
      );
      ipcRenderer.send.calls.reset();

      // Active item doesn't implement ::getPath(). Use first project directory.
      const item = document.createElement("div");
      lumine.workspace.getActivePane().activateItem(item);
      lumine.commands.dispatch(workspaceElement, "window:run-package-specs");
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        "run-package-specs",
        path.join(projectPaths[0], "spec"),
        {},
      );
      ipcRenderer.send.calls.reset();

      // Active item has no path. Use first project directory.
      item.getPath = () => null;
      lumine.commands.dispatch(workspaceElement, "window:run-package-specs");
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        "run-package-specs",
        path.join(projectPaths[0], "spec"),
        {},
      );
      ipcRenderer.send.calls.reset();

      // Active item has path. Use project path for item path.
      item.getPath = () => path.join(projectPaths[1], "a-file.txt");
      lumine.commands.dispatch(workspaceElement, "window:run-package-specs");
      expect(ipcRenderer.send).toHaveBeenCalledWith(
        "run-package-specs",
        path.join(projectPaths[1], "spec"),
        {},
      );
      ipcRenderer.send.calls.reset();
    });

    it("passes additional options to the spec window", () => {
      const workspaceElement = lumine.workspace.getElement();
      spyOn(ipcRenderer, "send");

      const projectPath = temp.mkdirSync("dir1-");
      lumine.project.setPaths([projectPath]);
      workspaceElement.runPackageSpecs({
        env: { LUMINE_GITHUB_BABEL_ENV: "coverage" },
      });

      expect(ipcRenderer.send).toHaveBeenCalledWith(
        "run-package-specs",
        path.join(projectPath, "spec"),
        { env: { LUMINE_GITHUB_BABEL_ENV: "coverage" } },
      );
    });
  });

  describe("ctrl+wheel scrolling over a text editor", () => {
    const FRAME = 1000 / 60;
    let workspaceElement, editor1, editor2, component1, component2;

    function stubAnimationFrames(component) {
      component.scrollAnimator.raf = () => 0;
      component.scrollAnimator.caf = () => {};
    }

    function driveAnimationToCompletion(component, maxFrames = 1000) {
      let frames = 0;
      while (component.scrollAnimator.isAnimating() && frames < maxFrames) {
        component.scrollAnimator.advance(FRAME);
        frames++;
      }
      expect(component.scrollAnimator.isAnimating()).toBe(false);
    }

    beforeEach(async () => {
      // conditionPromise below polls with real setTimeout ticks, which never
      // fire under the fake clock the harness installs by default.
      jasmine.useRealClock();
      workspaceElement = lumine.workspace.getElement();
      workspaceElement.style.height = "200px";
      workspaceElement.style.width = "600px";
      jasmine.attachToDOM(workspaceElement);

      editor1 = await lumine.workspace.open();
      editor1.setText("one\n".repeat(100));
      editor2 = await lumine.workspace.open(null, { split: "right" });
      editor2.setText("two\n".repeat(100));

      component1 = editor1.getElement().getComponent();
      component2 = editor2.getElement().getComponent();
      stubAnimationFrames(component1);
      stubAnimationFrames(component2);
      // Wait on the observable condition, not on getNextUpdatePromise(): if
      // every pending update has already flushed by this point, that promise
      // waits for an update that never comes and times the spec out.
      await conditionPromise(
        () => component1.hasInitialMeasurements && component2.hasInitialMeasurements,
      );
    });

    it("scrolls all visible center-pane editors together", () => {
      const event = new WheelEvent("wheel", {
        deltaY: 50,
        deltaMode: 0,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor1.getElement().dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      driveAnimationToCompletion(component1);
      driveAnimationToCompletion(component2);
      expect(component1.getScrollTop()).toBeGreaterThan(0);
      expect(component2.getScrollTop()).toBeGreaterThan(0);
      expect(component1.getScrollTop()).toBe(component2.getScrollTop());
    });

    it("scrolls only the hovered editor when the setting is disabled", () => {
      lumine.config.set("editor.ctrlWheelScrollsAllPanes", false);

      const event = new WheelEvent("wheel", {
        deltaY: 50,
        deltaMode: 0,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor1.getElement().dispatchEvent(event);

      driveAnimationToCompletion(component1);
      driveAnimationToCompletion(component2);
      expect(component1.getScrollTop()).toBeGreaterThan(0);
      expect(component2.getScrollTop()).toBe(0);
    });

    it("ignores ctrl+wheel events that don't originate from a text editor", () => {
      const event = new WheelEvent("wheel", {
        deltaY: 50,
        deltaMode: 0,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      workspaceElement.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(component1.getScrollTop()).toBe(0);
      expect(component2.getScrollTop()).toBe(0);
    });
  });
});
