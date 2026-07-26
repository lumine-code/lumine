const path = require("path");
const { Disposable } = require("atom");

const getIconServices = require("../lib/get-icon-services");

describe("icon services", () => {
  let iconServices, tab, DefaultFileIcons;

  beforeEach(() => {
    iconServices = getIconServices();
    // The default is private to get-icon-services; capture it before any
    // provider replaces it so identity assertions still work.
    DefaultFileIcons = iconServices.fileIcons;

    waitsForPromise(() => atom.workspace.open(path.join(__dirname, "fixtures", "sample.js")));

    waitsForPromise(() => atom.packages.activatePackage("tabs"));

    runs(() => {
      tab = atom.workspace.getElement().querySelector(".tab");
      expect(tab.itemTitle.className).toBe("title");
    });
  });

  afterEach(() => {
    iconServices.resetElementIcons();
    iconServices.resetFileIcons();
  });

  describe("icons.class", () => {
    it("has a default handler", () => {
      expect(iconServices.fileIcons).toBe(DefaultFileIcons);
    });

    it("shows no icons by default", () => {
      expect(DefaultFileIcons.iconClassForPath("foo.bar")).toEqual("");
      expect(DefaultFileIcons.iconClassForPath("README.md")).toEqual("");
      expect(DefaultFileIcons.iconClassForPath("foo.zip")).toEqual("");
      expect(DefaultFileIcons.iconClassForPath("foo.png")).toEqual("");
      expect(DefaultFileIcons.iconClassForPath("foo.pdf")).toEqual("");
      expect(DefaultFileIcons.iconClassForPath("foo.exe")).toEqual("");
    });

    it("falls back to the core icon classes in the MRU switcher", () => {
      const forCaller = (filePath) =>
        DefaultFileIcons.iconClassForPath(filePath, "tabs-mru-switcher");
      expect(forCaller("foo.zip")).toEqual(atom.ui.iconClassForPath("foo.zip"));
      expect(forCaller("foo.png")).toEqual(["icon-file-media"]);
      expect(forCaller("foo.pdf")).toEqual(["icon-file-pdf"]);
      expect(forCaller(null)).toEqual("icon-file-text");
    });

    it("repaints when the provider reports its classes changed", () => {
      let notify;
      const provider = {
        iconClassForPath: () => "first",
        onDidChange(callback) {
          notify = callback;
          return new Disposable(() => (notify = null));
        },
      };
      const disposable = atom.packages.serviceHub.provide("icons.class", "1.0.0", provider);
      expect(tab.itemTitle.className).toBe("title icon first");

      provider.iconClassForPath = () => "second";
      notify();
      expect(tab.itemTitle.className).toBe("title icon second");

      disposable.dispose();
      expect(notify).toBe(null);
    });

    it("allows a service to replace the default", () => {
      const provider = { iconClassForPath: () => "foo bar" };
      const disposable = atom.packages.serviceHub.provide("icons.class", "1.0.0", provider);
      expect(iconServices.fileIcons).toBe(provider);
      expect(tab.itemTitle.className).toBe("title icon foo bar");
      disposable.dispose();
      expect(iconServices.fileIcons).toBe(DefaultFileIcons);
      expect(tab.itemTitle.className).toBe("title");
    });

    it("accepts an array of strings as icon-classes", () => {
      const provider = { iconClassForPath: () => ["foo", "bar"] };
      const disposable = atom.packages.serviceHub.provide("icons.class", "1.0.0", provider);
      expect(iconServices.fileIcons).toBe(provider);
      expect(tab.itemTitle.className).toBe("title icon foo bar");
      disposable.dispose();
      expect(iconServices.fileIcons).toBe(DefaultFileIcons);
      expect(tab.itemTitle.className).toBe("title");
    });
  });

  describe("icons.element", () => {
    it("has no default handler", () => {
      expect(iconServices.elementIcons).toBe(null);
    });

    it("uses the element-icon service if available", () => {
      const provider = (element) => {
        element.classList.add("foo", "bar");
        return new Disposable(() => {
          element.classList.remove("foo", "bar", "icon");
        });
      };
      const disposable = atom.packages.serviceHub.provide("icons.element", "1.0.0", provider);
      expect(iconServices.elementIcons).toBe(provider);
      expect(tab.itemTitle.className).toBe("title icon foo bar");
      disposable.dispose();
      expect(iconServices.elementIcons).toBe(null);
    });
  });

  describe("when both services are provided", () => {
    it("gives priority to the element-icon service", () => {
      const basicProvider = { iconClassForPath: () => "foo" };
      const elementProvider = (element) => {
        element.classList.add("bar");
        return new Disposable(() => {
          element.classList.remove("bar");
        });
      };
      atom.packages.serviceHub.provide("icons.class", "1.0.0", basicProvider);
      atom.packages.serviceHub.provide("icons.element", "1.0.0", elementProvider);
      expect(iconServices.fileIcons).toBe(basicProvider);
      expect(iconServices.elementIcons).toBe(elementProvider);
      expect(tab.itemTitle.className).toBe("title icon bar");
    });
  });
});
