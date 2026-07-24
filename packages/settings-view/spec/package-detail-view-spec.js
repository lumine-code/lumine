const fs = require("fs");
const path = require("path");

const PackageDetailView = require("../lib/package-detail-view");
const PackageManager = require("../lib/package-manager");
const SettingsView = require("../lib/settings-view");
const SnippetsProvider = {
  getSnippets() {
    return {};
  },
};

describe("PackageDetailView", function () {
  let packageManager = null;
  let view = null;

  const createClientSpy = () => jasmine.createSpyObj("client", ["package", "avatar"]);

  beforeEach(function () {
    packageManager = new PackageManager();
    view = null;
  });

  const loadPackageFromRemote = function (packageName, opts) {
    if (opts == null) {
      opts = {};
    }
    packageManager.client = createClientSpy();
    const packageData = require(path.join(__dirname, "fixtures", packageName, "package.json"));
    packageData.readme = fs.readFileSync(
      path.join(__dirname, "fixtures", packageName, "README.md"),
      "utf8",
    );
    view = new PackageDetailView(
      { ...packageData, name: packageName, metadata: packageData },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );
    return view.beforeShow(opts);
  };

  const loadCustomPackageFromRemote = function (packageName, opts) {
    if (opts == null) {
      opts = {};
    }
    packageManager.client = createClientSpy();
    const packageData = require(path.join(__dirname, "fixtures", packageName, "package.json"));
    view = new PackageDetailView(
      { ...packageData, name: packageName, metadata: packageData },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );
    return view.beforeShow(opts);
  };

  it("renders a package when provided in `initialize`", function () {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    // Perhaps there are more things to assert here.
    expect(view.refs.title.textContent).toBe("Package With Config");
  });

  it("renders labeled chapter tabs and shows one chapter at a time", () => {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    const chapterLabels = {
      readme: "README",
      settings: "Settings",
      keymap: "Keybindings",
      grammars: "Grammars",
      snippets: "Snippets",
      license: "License",
    };
    const tabs = view.refs.chapterTabs.querySelectorAll("[data-chapter-tab]");
    expect(tabs.length).toBeGreaterThan(1);
    for (const tab of tabs) {
      expect(tab.tagName).toBe("BUTTON");
      expect(tab).toHaveClass("icon");
      expect(tab.textContent).toBe(chapterLabels[tab.dataset.chapterTab]); // icon + label
    }

    // README is the default chapter: its section is shown, the others hidden,
    // and exactly one tab is selected.
    expect(view.activeChapter).toBe("readme");
    expect(view.refs.chapterTabs.querySelectorAll(".selected").length).toBe(1);

    const readmeSection = view.refs.sections.querySelector('[data-chapter="readme"]');
    const settingsSection = view.refs.sections.querySelector('[data-chapter="settings"]');
    expect(readmeSection.style.display).toBe("");
    expect(settingsSection.style.display).toBe("none");

    // Switching to the Settings tab reveals only that chapter.
    view.refs.chapterTabs.querySelector('[data-chapter-tab="settings"]').click();
    expect(view.activeChapter).toBe("settings");
    expect(settingsSection.style.display).toBe("");
    expect(readmeSection.style.display).toBe("none");
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="settings"]')).toHaveClass(
      "selected",
    );
  });

  it("keeps the active chapter when the sections refresh", () => {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    view.refs.chapterTabs.querySelector('[data-chapter-tab="settings"]').click();
    expect(view.activeChapter).toBe("settings");

    view.updateInstalledState();

    expect(view.activeChapter).toBe("settings");
    const settingsSection = view.refs.sections.querySelector('[data-chapter="settings"]');
    expect(settingsSection.style.display).toBe("");
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="settings"]')).toHaveClass(
      "selected",
    );
  });

  it("renders an installed package README with its file path", function () {
    const packagePath = path.join(__dirname, "fixtures", "package-with-readme");
    atom.packages.loadPackage(packagePath);
    const pack = atom.packages.getLoadedPackage("package-with-readme");
    const render = spyOn(atom.ui.markdown, "render").andCallThrough();

    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    expect(render).toHaveBeenCalled();
    expect(render.mostRecentCall.args[1].filePath).toBe(path.join(packagePath, "README.md"));
  });

  it("shows only the README while a version other than the installed one is selected", function () {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    const readmeSection = view.refs.sections.querySelector('[data-chapter="readme"]');
    const settingsSection = view.refs.sections.querySelector('[data-chapter="settings"]');
    // The Settings chapter is available for the installed version.
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="settings"]')).not.toBeNull();

    // Previewing a different version restricts the view to just the README: the
    // config chapters are removed and their sections hidden.
    view.applySelectedRef({ previewVersion: true });
    expect(view.activeChapter).toBe("readme");
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="settings"]')).toBeNull();
    expect(readmeSection.style.display).not.toBe("none");
    expect(settingsSection.style.display).toBe("none");

    // Returning to the installed version brings the config chapters back.
    view.applySelectedRef({ previewVersion: false });
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="settings"]')).not.toBeNull();
  });

  it("renders a License chapter and keeps it while previewing another version", function () {
    const metadata = {
      name: "pkg-with-license",
      version: "1.0.0",
      repository: "owner/pkg-with-license",
      owner: "owner",
      engines: { atom: "*" },
      originKey: "github.com/owner/pkg-with-license",
      resolvedSha: "a".repeat(40),
      readme: "# pkg-with-license",
      // `license` is the package.json SPDX id and must NOT be shown as the body;
      // the full text lives in `licenseText`.
      license: "MIT",
      licenseText: "MIT License\n\nPermission is hereby granted, free of charge...",
      licenseIsMarkdown: false,
    };
    view = new PackageDetailView(
      { ...metadata, metadata },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );

    // The license text is already on the metadata, so the chapter renders now.
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="license"]')).not.toBeNull();
    const licenseSection = view.refs.sections.querySelector('[data-chapter="license"]');
    expect(licenseSection).not.toBeNull();
    // Shows the full license text, not the bare SPDX identifier.
    expect(licenseSection.textContent).toContain("Permission is hereby granted");
    expect(licenseSection.querySelector(".package-license-text").textContent).not.toBe("MIT");

    // README and License both belong to the version, so both survive a preview.
    view.applySelectedRef({ previewVersion: true });
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="readme"]')).not.toBeNull();
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="license"]')).not.toBeNull();
  });

  it("lazily fetches the LICENSE for a browsed version", function () {
    const client = packageManager.getCatalogClient();
    const loadLicense = spyOn(client, "loadLicense").andReturn(Promise.resolve(null));
    spyOn(client, "loadReadme").andReturn(Promise.resolve(null));

    const metadata = {
      name: "pkg-lazy-license",
      version: "1.0.0",
      repository: "owner/pkg-lazy-license",
      owner: "owner",
      engines: { atom: "*" },
      originKey: "github.com/owner/pkg-lazy-license",
      resolvedSha: "b".repeat(40),
      readme: "# pkg-lazy-license",
      // A bare SPDX `license` must not suppress fetching the real LICENSE text.
      license: "MIT",
    };
    view = new PackageDetailView(
      { ...metadata, metadata },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );

    // No local file and no cached text, so the LICENSE is fetched for the commit.
    expect(loadLicense).toHaveBeenCalled();
  });

  it("opens on README by default and on Settings when the Settings button asks", () => {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    // Opening via the card's Settings button jumps straight to the Settings chapter.
    view.beforeShow({ initialChapter: "settings" });
    expect(view.activeChapter).toBe("settings");
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="settings"]')).toHaveClass(
      "selected",
    );

    // Any other open resets to the default README chapter.
    view.beforeShow({});
    expect(view.activeChapter).toBe("readme");
  });

  it("keeps the overridden bundled card shadowed in its detail view", function () {
    const metadata = {
      name: "shadowed-pkg",
      version: "1.0.0",
      description: "A bundled package overridden by a community install.",
      repository: "https://github.com/lumine-code/lumine",
    };
    view = new PackageDetailView(
      { ...metadata, name: "shadowed-pkg", metadata, isShadowed: true, packageKind: "builtin" },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );

    // The embedded card must reflect the shadow state even though its metadata
    // (the shared bundled object) doesn't carry the flag — it comes via options.
    expect(view.packageCard.isShadowed).toBe(true);
    expect(view.packageCard.element).toHaveClass("is-shadowed");
    // No Override/Replace action on a shadowed card.
    expect(view.packageCard.element.querySelector(".replace-button")).toBeNull();
  });

  it("always offers README and License chapters, even without a LICENSE file", function () {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="readme"]')).not.toBeNull();
    expect(view.refs.chapterTabs.querySelector('[data-chapter-tab="license"]')).not.toBeNull();
    // The tab bar is shown even though this package ships no LICENSE file.
    expect(view.refs.chapterTabs.style.display).not.toBe("none");
  });

  it("publishes the README headers to the sidebar table of contents", function () {
    const settingsView = new SettingsView();
    const showToc = spyOn(settingsView, "showTableOfContents").andCallThrough();
    const metadata = {
      name: "toc-pkg",
      version: "1.0.0",
      repository: "owner/toc-pkg",
      owner: "owner",
      engines: { atom: "*" },
      readme: "# Title\n\nintro\n\n## Features\n\n- a\n\n## Usage\n\ntext",
    };
    view = new PackageDetailView(
      { ...metadata, metadata },
      settingsView,
      packageManager,
      SnippetsProvider,
    );

    expect(showToc).toHaveBeenCalled();
    const labels = showToc.mostRecentCall.args[0].map((entry) => entry.label);
    expect(labels.some((label) => label.includes("Features"))).toBe(true);
    expect(labels.some((label) => label.includes("Usage"))).toBe(true);

    // Switching away from the README chapter clears the TOC.
    const clearToc = spyOn(settingsView, "clearTableOfContents").andCallThrough();
    view.setActiveChapter("license");
    expect(clearToc).toHaveBeenCalled();
  });

  it("does not call the atom.io api for package metadata when present", function () {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    packageManager.client = createClientSpy();
    view = new PackageDetailView(
      { name: "package-with-config" },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );

    // The package is already loaded locally, so no registry request is made.
    expect(packageManager.client.package.callCount).toBe(0);
  });

  it("uses hydrated metadata without calling the legacy API by name", function () {
    loadPackageFromRemote("package-with-readme");
    expect(view.refs.loadingMessage).not.toBe(null);
    expect(view.refs.loadingMessage.classList.contains("hidden")).toBe(true);
    expect(packageManager.client.package).not.toHaveBeenCalled();
  });

  it("does not expose a loaded package through a same-named card from another origin", function () {
    const packagePath = path.join(__dirname, "fixtures", "package-with-config");
    atom.packages.loadPackage(packagePath);
    const metadata = {
      name: "package-with-config",
      version: "1.0.0",
      repository: "https://github.com/different/package-with-config",
      originKey: "github.com/different/package-with-config",
      resolvedSha: "a".repeat(40),
      engines: { atom: "*" },
    };

    view = new PackageDetailView(
      { ...metadata, metadata },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );

    expect(view.pack.metadata.repository).toBe(metadata.repository);
    expect(view.readmePath).toBeNull();
    expect(view.refs.openButton.style.display).toBe("none");
    expect(view.refs.sections.querySelector(".settings-panel")).toBeNull();
  });

  it("shows an error when an unknown package has no metadata, without querying the registry", function () {
    packageManager.client = createClientSpy();

    view = new PackageDetailView(
      { name: "nonexistent-package" },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );

    expect(packageManager.client.package).not.toHaveBeenCalled();
    expect(view.refs.errorMessage.classList.contains("hidden")).not.toBe(true);
    expect(view.refs.loadingMessage.classList.contains("hidden")).toBe(true);
    expect(view.element.querySelectorAll(".package-card").length).toBe(0);
  });

  it("renders the README successfully after a call to the atom.io api", function () {
    loadPackageFromRemote("package-with-readme");
    expect(view.packageCard).toBeDefined();
    expect(view.packageCard.refs.packageName.textContent).toBe("package-with-readme");
    expect(view.element.querySelectorAll(".package-readme").length).toBe(1);
  });

  it("renders the README successfully with sanitized html", function () {
    loadPackageFromRemote("package-with-readme");
    expect(view.element.querySelectorAll(".package-readme script").length).toBe(0);
    expect(view.element.querySelectorAll(".package-readme iframe").length).toBe(0);
    expect(
      view.element.querySelectorAll('.package-readme input[type="checkbox"][disabled]').length,
    ).toBe(2);
    expect(
      view.element.querySelector('img[alt="AbsoluteImage"]').getAttribute("data-external-src"),
    ).toBe("https://example.com/static/image.jpg");
    expect(view.element.querySelector('img[alt="AbsoluteImage"]').getAttribute("src")).toBeNull();
    expect(
      view.element.querySelector('img[alt="RelativeImage"]').getAttribute("data-external-src"),
    ).toBe("https://github.com/example/package-with-readme/raw/HEAD/static/image.jpg");
    expect(view.element.querySelector('img[alt="Base64Image"]').getAttribute("src")).toBe(
      "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
    );
  });

  it("renders the README when the package path is undefined", function () {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-readme"));
    const pack = atom.packages.getLoadedPackage("package-with-readme");
    delete pack.path;
    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    expect(view.packageCard).toBeDefined();
    expect(view.packageCard.refs.packageName.textContent).toBe("package-with-readme");
    expect(view.element.querySelectorAll(".package-readme").length).toBe(1);
  });

  it("triggers a report issue button click and checks that the fallback repository issue tracker URL was opened", function () {
    loadCustomPackageFromRemote("package-without-bugs-property");
    spyOn(atom, "openExternal");
    view.refs.issueButton.click();
    expect(atom.openExternal).toHaveBeenCalledWith(
      "https://github.com/example/package-without-bugs-property/issues/new",
    );
  });

  it("triggers a report issue button click and checks that the bugs URL string was opened", function () {
    loadCustomPackageFromRemote("package-with-bugs-property-url-string");
    spyOn(atom, "openExternal");
    view.refs.issueButton.click();
    expect(atom.openExternal).toHaveBeenCalledWith("https://example.com/custom-issue-tracker/new");
  });

  it("triggers a report issue button click and checks that the bugs URL was opened", function () {
    loadCustomPackageFromRemote("package-with-bugs-property-url");
    spyOn(atom, "openExternal");
    view.refs.issueButton.click();
    expect(atom.openExternal).toHaveBeenCalledWith("https://example.com/custom-issue-tracker/new");
  });

  it("triggers a report issue button click and checks that the bugs email link was opened", function () {
    loadCustomPackageFromRemote("package-with-bugs-property-email");
    spyOn(atom, "openExternal");
    view.refs.issueButton.click();
    expect(atom.openExternal).toHaveBeenCalledWith("mailto:issues@example.com");
  });

  it("should show 'Install' as the first breadcrumb by default", function () {
    loadPackageFromRemote("package-with-readme");
    expect(view.refs.breadcrumb.textContent).toBe("Install");
  });
});
