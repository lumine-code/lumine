const temp = require("@lumine-code/temp").track();
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const StyleManager = require("../src/style-manager");

describe("StyleManager", () => {
  let [styleManager, addEvents, removeEvents, updateEvents] = [];

  beforeEach(() => {
    styleManager = new StyleManager({
      configDirPath: temp.mkdirSync("lumine-config"),
    });
    addEvents = [];
    removeEvents = [];
    updateEvents = [];
    styleManager.onDidAddStyleElement((event) => {
      addEvents.push(event);
    });
    styleManager.onDidRemoveStyleElement((event) => {
      removeEvents.push(event);
    });
    styleManager.onDidUpdateStyleElement((event) => {
      updateEvents.push(event);
    });
  });

  afterEach(() => {
    try {
      temp.cleanupSync();
    } catch {
      // Do nothing
    }
  });

  describe("::getUserStyleSheetPath()", () => {
    let configDirPath;

    beforeEach(() => {
      configDirPath = temp.mkdirSync("lumine-config-styles");
      styleManager.initialize({ configDirPath });
    });

    it("uses styles.css for a new user stylesheet", () => {
      expect(styleManager.getUserStyleSheetPath()).toBe(path.join(configDirPath, "styles.css"));
    });

    it("uses an existing styles.css", () => {
      const cssStylesheetPath = path.join(configDirPath, "styles.css");
      fs.writeFileSync(cssStylesheetPath, "body { color: var(--text-color); }");

      expect(styleManager.getUserStyleSheetPath()).toBe(fs.realpathSync(cssStylesheetPath));
    });
  });

  describe("::addStyleSheet(source, params)", () => {
    it("adds a style sheet based on the given source and returns a disposable allowing it to be removed", () => {
      const disposable = styleManager.addStyleSheet("a {color: red}");
      expect(addEvents.length).toBe(1);
      expect(addEvents[0].textContent).toBe("a {color: red}");
      const styleElements = styleManager.getStyleElements();
      expect(styleElements.length).toBe(1);
      expect(styleElements[0].textContent).toBe("a {color: red}");
      disposable.dispose();
      expect(removeEvents.length).toBe(1);
      expect(removeEvents[0].textContent).toBe("a {color: red}");
      expect(styleManager.getStyleElements().length).toBe(0);
    });

    describe("when a sourcePath parameter is specified", () => {
      it("ensures a maximum of one style element for the given source path, updating a previous if it exists", () => {
        styleManager.addStyleSheet("a {color: red}", {
          sourcePath: "/foo/bar",
        });
        expect(addEvents.length).toBe(1);
        expect(addEvents[0].getAttribute("source-path")).toBe("/foo/bar");

        const disposable2 = styleManager.addStyleSheet("a {color: blue}", {
          sourcePath: "/foo/bar",
        });
        expect(addEvents.length).toBe(1);
        expect(updateEvents.length).toBe(1);
        expect(updateEvents[0].getAttribute("source-path")).toBe("/foo/bar");
        expect(updateEvents[0].textContent).toBe("a {color: blue}");
        disposable2.dispose();

        addEvents = [];
        styleManager.addStyleSheet("a {color: yellow}", {
          sourcePath: "/foo/bar",
        });
        expect(addEvents.length).toBe(1);
        expect(addEvents[0].getAttribute("source-path")).toBe("/foo/bar");
        expect(addEvents[0].textContent).toBe("a {color: yellow}");
      });
    });

    describe("when a priority parameter is specified", () => {
      it("inserts the style sheet based on the priority", () => {
        styleManager.addStyleSheet("a {color: red}", { priority: 1 });
        styleManager.addStyleSheet("a {color: blue}", { priority: 0 });
        styleManager.addStyleSheet("a {color: green}", { priority: 2 });
        styleManager.addStyleSheet("a {color: yellow}", { priority: 1 });
        expect(styleManager.getStyleElements().map((elt) => elt.textContent)).toEqual([
          "a {color: blue}",
          "a {color: red}",
          "a {color: yellow}",
          "a {color: green}",
        ]);
      });
    });
  });
});
