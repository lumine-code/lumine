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

  it("shows every section at once and lists them in the table of contents", () => {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    const settingsView = new SettingsView();
    const showToc = spyOn(settingsView, "showTableOfContents").andCallThrough();
    view = new PackageDetailView(pack, settingsView, packageManager, SnippetsProvider);

    // Sections stack in one long scrolling list, so nothing is hidden…
    const settingsSection = view.refs.sections.querySelector('[data-section="settings"]');
    const readmeSection = view.refs.sections.querySelector('[data-section="readme"]');
    expect(settingsSection.style.display).toBe("");
    expect(readmeSection.style.display).toBe("");

    // …except a section with nothing in it: this package registers no keybindings.
    expect(view.refs.sections.querySelector('[data-section="keymap"]').style.display).toBe("none");

    // The sidebar table of contents is the navigation: one entry per section, in
    // list order, and clicking it scrolls there.
    const sections = showToc.mostRecentCall.args[0].filter((entry) => entry.level === 1);
    expect(sections.map((entry) => entry.label)).toEqual(["Settings", "README"]);
    const scrollIntoView = spyOn(settingsSection, "scrollIntoView");
    sections[0].onClick();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("keeps every section listed when the sections refresh", () => {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    const settingsView = new SettingsView();
    const showToc = spyOn(settingsView, "showTableOfContents").andCallThrough();
    view = new PackageDetailView(pack, settingsView, packageManager, SnippetsProvider);

    view.updateInstalledState();

    const settingsSection = view.refs.sections.querySelector('[data-section="settings"]');
    expect(settingsSection.style.display).toBe("");
    const labels = showToc.mostRecentCall.args[0].map((entry) => entry.label);
    expect(labels).toContain("Settings");
    expect(labels).toContain("README");
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

    const readmeSection = view.refs.sections.querySelector('[data-section="readme"]');
    const settingsSection = view.refs.sections.querySelector('[data-section="settings"]');
    // The settings belong to the installed version, so they are listed for it.
    expect(settingsSection.style.display).toBe("");

    // Previewing a different version restricts the list to just the README: the
    // config sections describe the installed copy, so they are hidden.
    view.applySelectedRef({ previewVersion: true });
    expect(readmeSection.style.display).not.toBe("none");
    expect(settingsSection.style.display).toBe("none");

    // Returning to the installed version brings the config sections back.
    view.applySelectedRef({ previewVersion: false });
    expect(settingsSection.style.display).toBe("");
  });

  it("names the license on the card and links the LICENSE button to GitHub", function () {
    const sha = "a".repeat(40);
    const metadata = {
      name: "pkg-with-license",
      version: "1.0.0",
      repository: "owner/pkg-with-license",
      owner: "owner",
      engines: { atom: "*" },
      originKey: `github.com/owner/pkg-with-license`,
      resolvedSha: sha,
      readme: "# pkg-with-license",
      // The SPDX id is all the card shows; the text itself stays on GitHub.
      license: "MIT",
      licenseSource: `https://github.com/owner/pkg-with-license/blob/${sha}/LICENSE`,
    };
    view = new PackageDetailView(
      { ...metadata, metadata },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );

    expect(view.packageCard.element.querySelector(".package-license").textContent).toBe("MIT");
    // The license is no longer a section of its own in the list.
    expect(view.refs.sections.querySelector('[data-section="license"]')).toBeNull();

    expect(view.refs.licenseButton.style.display).not.toBe("none");
    spyOn(atom, "openExternal");
    view.refs.licenseButton.click();
    expect(atom.openExternal).toHaveBeenCalledWith(metadata.licenseSource);
  });

  it("asks the catalog where the LICENSE is only once the button is clicked", function () {
    const client = packageManager.getCatalogClient();
    const source = `https://github.com/owner/pkg-lazy-license/blob/${"b".repeat(40)}/LICENSE.md`;
    const loadLicense = spyOn(client, "loadLicense").andReturn(
      Promise.resolve({ body: "MIT License…", source }),
    );
    spyOn(client, "loadReadme").andReturn(Promise.resolve(null));
    spyOn(atom, "openExternal");

    const metadata = {
      name: "pkg-lazy-license",
      version: "1.0.0",
      repository: "owner/pkg-lazy-license",
      owner: "owner",
      engines: { atom: "*" },
      originKey: "github.com/owner/pkg-lazy-license",
      resolvedSha: "b".repeat(40),
      readme: "# pkg-lazy-license",
      license: "MIT",
    };
    view = new PackageDetailView(
      { ...metadata, metadata },
      new SettingsView(),
      packageManager,
      SnippetsProvider,
    );

    // Merely opening the package fetches nothing: the SPDX id is on the card and
    // the file name is only needed when the button is used.
    expect(loadLicense).not.toHaveBeenCalled();
    expect(view.refs.licenseButton.style.display).not.toBe("none");

    waitsForPromise(() => view.openLicense());
    runs(() => {
      expect(loadLicense).toHaveBeenCalled();
      expect(atom.openExternal).toHaveBeenCalledWith(source);
    });
  });

  it("hides the LICENSE button for a package with no license at all", function () {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    expect(view.licensePath).toBeNull();
    expect(view.refs.licenseButton.style.display).toBe("none");
  });

  it("scrolls to the Settings section when the Settings button opens it", () => {
    atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
    const pack = atom.packages.getLoadedPackage("package-with-config");
    view = new PackageDetailView(pack, new SettingsView(), packageManager, SnippetsProvider);

    // Opening via the card's Settings button scrolls straight to that section,
    // beating the scroll position the panel was last left at.
    const settingsSection = view.refs.sections.querySelector('[data-section="settings"]');
    const scrollIntoView = spyOn(settingsSection, "scrollIntoView");
    view.scrollPosition = 120;
    view.beforeShow({ initialSection: "settings" });
    view.show();
    expect(scrollIntoView.callCount).toBe(1);
    expect(view.scrollPosition).toBeUndefined();

    // Any other open leaves the list where the reader left it.
    view.scrollPosition = 120;
    view.beforeShow({});
    view.show();
    expect(scrollIntoView.callCount).toBe(1);
    expect(view.scrollPosition).toBe(120);
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

  it("nests the README headers under its entry in the table of contents", function () {
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
    const entries = showToc.mostRecentCall.args[0];

    // The README section heads the list, and its own headers follow, indented
    // one level below it.
    expect(entries[0].label).toBe("README");
    expect(entries[0].level).toBe(1);
    const header = (label) => entries.find((entry) => entry.label.includes(label));
    expect(header("Title").level).toBe(2);
    expect(header("Features").level).toBe(3);
    expect(header("Usage").level).toBe(3);

    // Every entry carries an icon: the sections their own, the headers a
    // uniform marker.
    expect(entries.every((entry) => entry.icon)).toBe(true);
    expect(header("Features").icon).toBe("icon-chevron-right");

    // Clicking a header scrolls to it in the list.
    const heading = view.readmeView.packageReadme.querySelector("h2");
    const scrollIntoView = spyOn(heading, "scrollIntoView");
    header("Features").onClick();
    expect(scrollIntoView).toHaveBeenCalled();
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
