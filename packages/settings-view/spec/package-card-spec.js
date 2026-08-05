const fs = require("fs");
const os = require("os");
const path = require("path");
const PackageCard = require("../lib/package-card");
const PackageManager = require("../lib/package-manager");
const SettingsView = require("../lib/settings-view");

describe("PackageCard", function () {
  const setPackageStatusSpies = function (opts) {
    spyOn(PackageCard.prototype, "isInstalled").andReturn(opts.installed);
    spyOn(PackageCard.prototype, "isDisabled").andReturn(opts.disabled);
    spyOn(PackageCard.prototype, "hasSettings").andReturn(opts.hasSettings);
  };

  let [card, packageManager] = [];

  beforeEach(function () {
    packageManager = new PackageManager();
  });

  it("doesn't show the disable control for a theme", function () {
    setPackageStatusSpies({ installed: true, disabled: false });
    card = new PackageCard(
      { theme: "syntax", name: "test-theme" },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    expect(card.refs.enablementButton).not.toBeVisible();
  });

  it("doesn't show the status indicator for a theme", function () {
    setPackageStatusSpies({ installed: true, disabled: false });
    card = new PackageCard(
      { theme: "syntax", name: "test-theme" },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    expect(card.refs.statusIndicatorButton).not.toBeVisible();
  });

  it("doesn't show the settings button for a theme", function () {
    setPackageStatusSpies({ installed: true, disabled: false });
    card = new PackageCard(
      { theme: "syntax", name: "test-theme" },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    expect(card.refs.settingsButton).not.toBeVisible();
  });

  it("doesn't show the settings button on the settings view", function () {
    setPackageStatusSpies({ installed: true, disabled: false, hasSettings: true });
    card = new PackageCard({ name: "test-package" }, new SettingsView(), packageManager, {
      onSettingsView: true,
    });
    jasmine.attachToDOM(card.element);
    expect(card.refs.settingsButton).not.toBeVisible();
  });

  it("removes the settings button if a package has no settings", function () {
    setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
    card = new PackageCard({ name: "test-package" }, new SettingsView(), packageManager);
    jasmine.attachToDOM(card.element);
    expect(card.refs.settingsButton).not.toBeVisible();
  });

  it("removes the uninstall button if a package has is a bundled package", function () {
    setPackageStatusSpies({ installed: true, disabled: false, hasSettings: true });
    card = new PackageCard({ name: "search-panel" }, new SettingsView(), packageManager);
    jasmine.attachToDOM(card.element);
    expect(card.refs.uninstallButton).not.toBeVisible();
  });

  describe("display name for Git packages", function () {
    const gitUrlInfo = { project: "pulsar-invert-colors", type: "github" };

    it("labels a pre-install Git card with the repository project name", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        {
          name: "asiloisad/pulsar-invert-colors@0.4.0",
          repository: "asiloisad/pulsar-invert-colors",
          gitUrlInfo,
        },
        new SettingsView(),
        packageManager,
      );
      expect(card.refs.packageName.textContent).toBe("pulsar-invert-colors");
    });

    it("labels an installed package with its real package.json name", function () {
      setPackageStatusSpies({ installed: true, disabled: false });
      card = new PackageCard(
        {
          name: "invert-colors",
          repository: "asiloisad/pulsar-invert-colors",
          gitUrlInfo,
          apmInstallSource: { type: "git", source: "asiloisad/pulsar-invert-colors" },
        },
        new SettingsView(),
        packageManager,
      );
      expect(card.refs.packageName.textContent).toBe("invert-colors");
    });
  });

  it("loads the author avatar for a hydrated community card", function () {
    setPackageStatusSpies({ installed: false, disabled: false });
    const avatarCache = { avatar: jasmine.createSpy("avatar") };
    spyOn(packageManager, "getAvatarCache").andReturn(avatarCache);

    card = new PackageCard(
      {
        name: "sample-package",
        repository: "owner/sample-package",
        originKey: "github.com/owner/sample-package",
        status: "ready",
      },
      new SettingsView(),
      packageManager,
    );

    // The avatar comes from the author's GitHub avatar URL by owner login, not
    // the package registry, so catalog cards show it too.
    expect(avatarCache.avatar).toHaveBeenCalled();
    expect(avatarCache.avatar.mostRecentCall.args[0]).toBe("owner");
  });

  describe("the directory a package lives in", function () {
    it("is named beside the repository when it is not the package's own name", function () {
      setPackageStatusSpies({ installed: true, disabled: false });
      card = new PackageCard(
        { name: "invert-colors", directoryName: "pulsar-invert-colors" },
        new SettingsView(),
        packageManager,
      );
      expect(card.refs.packageDirectory.textContent).toBe("pulsar-invert-colors");
      expect(card.refs.packageDirectory.style.display).toBe("");
      // It says where this copy is, not where to go: the repository is the link.
      expect(card.refs.packageDirectory.tagName).toBe("SPAN");
      expect(card.refs.packageMessage.textContent).toBe("");
    });

    it("is named on a shadowed copy too", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      card = new PackageCard(
        {
          name: "invert-colors",
          directoryName: "zz-old-copy",
          isShadowed: true,
          shadowedBy: { name: "invert-colors", dirname: "invert-colors", tier: "community" },
        },
        new SettingsView(),
        packageManager,
      );
      expect(card.refs.packageDirectory.textContent).toBe("zz-old-copy");
      // Which copy loads is the dot's to say, and it says it once.
      expect(card.refs.packageMessage.textContent).toBe("");
      const badge = card.badgeViews.find((view) => view.badge.title === "Shadowed");
      expect(badge.badge.text).toContain("invert-colors");
    });

    it("says nothing when the directory matches the package name", function () {
      setPackageStatusSpies({ installed: true, disabled: false });
      card = new PackageCard(
        { name: "invert-colors", directoryName: "invert-colors" },
        new SettingsView(),
        packageManager,
      );
      expect(card.refs.packageDirectory.textContent).toBe("");
      expect(card.refs.packageDirectory.style.display).toBe("none");
    });

    it("says nothing for a card without directory information", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        { name: "some-package", repository: "owner/some-package" },
        new SettingsView(),
        packageManager,
      );
      expect(card.refs.packageDirectory.textContent).toBe("");
    });
  });

  describe("replacing a conflicting package", function () {
    it("offers Replace when a different package holds the name, and swaps on click", function () {
      setPackageStatusSpies({ installed: true, disabled: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "linter",
        version: "1.0.0",
        apmInstallSource: { type: "git", origin: "author-a/linter" },
      });
      const replaceSpy = spyOn(packageManager, "replace");

      card = new PackageCard(
        { name: "linter", repository: "author-b/linter", installSource: "author-b/linter" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);

      expect(card.refs.replaceButton).toBeVisible();
      expect(card.refs.installButton).not.toBeVisible();

      card.refs.replaceButton.click();

      expect(replaceSpy).toHaveBeenCalled();
      expect(replaceSpy.mostRecentCall.args[0].name).toBe("linter");
    });

    it("hides Replace for a normal installable package", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        { name: "solo", repository: "owner/solo", installSource: "owner/solo" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.replaceButton).not.toBeVisible();
    });

    it("never conflicts with itself when the card is built from the installed package", function () {
      // A hand-linked checkout can report identities that disagree between
      // sources (e.g. a stale Git remote vs an updated package.json), but a
      // card carrying the install path IS the installed package.
      setPackageStatusSpies({ installed: true, disabled: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "linter",
        version: "1.0.0",
        repository: "https://github.com/new-owner/linter",
      });
      card = new PackageCard(
        {
          name: "linter",
          version: "1.0.0",
          path: "/home/user/.editor/packages/linter",
          repository: "old-owner/linter",
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.replaceButton).not.toBeVisible();
      expect(card.refs.uninstallButton).toBeVisible();
    });
  });

  describe("Git ref selection", function () {
    it("lists every cached tag and the default branch as version choices", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        {
          name: "ref-package",
          repository: "owner/ref-package",
          installSource: "owner/ref-package",
          originKey: "github.com/owner/ref-package",
          status: "ready",
          engines: { lumine: "*" },
          selectedRef: { type: "latest", value: "v2.0.0" },
          resolvedSha: "a".repeat(40),
          refs: {
            latestStable: { name: "v2.0.0", sha: "a".repeat(40) },
            defaultBranch: "main",
            tags: [
              { name: "v2.0.0", sha: "a".repeat(40) },
              { name: "nightly", sha: "b".repeat(40) },
            ],
          },
        },
        new SettingsView(),
        packageManager,
      );
      const labels = Array.from(card.refs.versionValue.options, ({ textContent }) => textContent);
      expect(labels).toEqual(["@v2.0.0", "@nightly", "~main"]);
      expect(card.refs.versionValue.value).toBe("tag:v2.0.0");
    });

    it("blocks the native list, shows a spinner, and lists tags on open", async function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "lazy-refs",
        version: "1.0.0",
        repository: "owner/lazy-refs",
        apmInstallSource: {
          type: "git",
          origin: "github.com/owner/lazy-refs",
          selector: { type: "tag", value: "v1.0.0" },
          sha: "a".repeat(40),
          updatePolicy: "tag",
        },
      });
      const client = packageManager.getCatalogClient();
      const loadRefs = spyOn(client, "loadRefs").andCallFake((pack) =>
        Promise.resolve({
          ...pack,
          refs: { defaultBranch: "main", tags: [{ name: "v1.0.0", sha: "a".repeat(40) }] },
        }),
      );

      card = new PackageCard(
        {
          name: "lazy-refs",
          version: "1.0.0",
          repository: "owner/lazy-refs",
          originKey: "github.com/owner/lazy-refs",
          status: "ready",
          engines: { lumine: "*" },
          apmInstallSource: {
            type: "git",
            origin: "github.com/owner/lazy-refs",
            selector: { type: "tag", value: "v1.0.0" },
            sha: "a".repeat(40),
            updatePolicy: "tag",
          },
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      // Installed cards have no ref index until the dropdown is opened.
      expect(card.refs.versionValue.tagName).toBe("SELECT");
      expect(card.pack.refs).toBeUndefined();

      const preventDefault = jasmine.createSpy("preventDefault");
      await card.onVersionOpen({ preventDefault });

      // The stale (current-only) list was blocked and the full tag list fetched.
      expect(preventDefault).toHaveBeenCalled();
      expect(loadRefs).toHaveBeenCalled();
      const labels = Array.from(card.refs.versionValue.options, ({ textContent }) => textContent);
      expect(labels).toContain("@v1.0.0");
      expect(labels).toContain("~main");
      // The spinner is hidden again once loading finishes.
      expect(card.refs.versionSpinner).toHaveClass("hidden");
    });

    it("reflects the installed branch, not the catalog tag, in the version selector", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "invert-colors",
        version: "0.5.0",
        repository: "asiloisad/pulsar-invert-colors",
        apmInstallSource: {
          type: "git",
          origin: "github.com/asiloisad/pulsar-invert-colors",
          selector: { type: "branch", value: "master" },
          sha: "a".repeat(40),
          updatePolicy: "branch",
        },
      });
      card = new PackageCard(
        {
          name: "invert-colors",
          version: "0.5.0",
          repository: "asiloisad/pulsar-invert-colors",
          originKey: "github.com/asiloisad/pulsar-invert-colors",
          status: "ready",
          selectedRef: { type: "latest", value: "v0.5.0" },
          resolvedSha: "b".repeat(40),
          refs: {
            latestStable: { name: "v0.5.0", sha: "b".repeat(40) },
            defaultBranch: "master",
            headSha: "a".repeat(40),
            tags: [{ name: "v0.5.0", sha: "b".repeat(40) }],
          },
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.versionValue.value).toBe("branch:master");
    });

    it("offers an update on the browse card when the installed branch HEAD advanced", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "invert-colors",
        version: "0.5.0",
        repository: "asiloisad/pulsar-invert-colors",
        apmInstallSource: {
          type: "git",
          origin: "github.com/asiloisad/pulsar-invert-colors",
          selector: { type: "branch", value: "master" },
          sha: "a".repeat(40),
          updatePolicy: "branch",
        },
      });
      card = new PackageCard(
        {
          name: "invert-colors",
          version: "0.5.0",
          repository: "asiloisad/pulsar-invert-colors",
          originKey: "github.com/asiloisad/pulsar-invert-colors",
          status: "ready",
          engines: { lumine: "*" },
          selectedRef: { type: "latest", value: "v0.5.0" },
          resolvedSha: "a".repeat(40),
          // A prior update check recorded that master advanced.
          latestSha: "b".repeat(40),
          refs: {
            defaultBranch: "master",
            headSha: "b".repeat(40),
            tags: [{ name: "v0.5.0", sha: "c".repeat(40) }],
          },
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.versionValue.value).toBe("branch:master");
      expect(card.refs.updateButton).toBeVisible();
      expect(card.refs.updateButton.textContent).toContain("Update to");
    });

    it("blocks a ref whose manifest renamed an already-installed origin", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      let installed = {
        name: "old-package-name",
        originKey: "github.com/owner/repo",
      };
      spyOn(packageManager, "findInstalledPackageByOrigin").andCallFake(() => installed);
      spyOn(packageManager, "install");
      card = new PackageCard(
        {
          name: "new-package-name",
          repository: "owner/repo",
          originKey: "github.com/owner/repo",
          status: "ready",
          engines: { lumine: "*" },
          resolvedSha: "a".repeat(40),
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);

      expect(card.refs.installButton).toBeVisible();
      expect(card.refs.installButton).toHaveClass("disabled");
      expect(card.refs.replaceButton).not.toBeVisible();
      expect(card.refs.originRenameWarning.textContent).toContain("old-package-name");
      expect(card.refs.originRenameWarning.textContent).toContain("new-package-name");
      card.refs.installButton.click();
      expect(packageManager.install).not.toHaveBeenCalled();

      installed = null;
      packageManager.emitPackageEvent("uninstalled", {
        name: "old-package-name",
        originKey: "github.com/owner/repo",
      });
      expect(card.refs.installButton).not.toHaveClass("disabled");
      expect(card.refs.originRenameWarning).not.toBeVisible();
    });
  });

  it("marks Pulsar-sourced packages with a purple dot", function () {
    setPackageStatusSpies({ installed: false, disabled: false });
    card = new PackageCard(
      { name: "hydrogen", repository: "nteract/hydrogen", source: "pulsar" },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    const dot = card.refs.badges.querySelector(".package-badge-dot");
    expect(dot).not.toBeNull();
    expect(dot.classList.contains("badge-dot-pulsar")).toBe(true);
  });

  it("shows the owner/repo reference so same-named packages are distinguishable", function () {
    setPackageStatusSpies({ installed: false, disabled: false });
    card = new PackageCard(
      { name: "twin", repository: "https://github.com/author-two/twin.git" },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    expect(card.refs.repoLink.textContent).toBe("author-two/twin");
  });

  it("shows complete catalog provenance and selector conflicts", function () {
    setPackageStatusSpies({ installed: false, disabled: false });
    card = new PackageCard(
      {
        name: "twin",
        repository: "author/twin",
        originKey: "github.com/author/twin",
        status: "ready",
        catalogSelectors: [
          { catalogSource: "first/catalog", selector: { type: "latest", value: null } },
          { catalogSource: "second/catalog", selector: { type: "branch", value: "Next" } },
        ],
        selectorConflict: true,
      },
      new SettingsView(),
      packageManager,
    );

    // Catalog provenance now lives in the repository hover tooltip.
    const tooltip = card.catalogTooltipLines().join(" ");
    expect(tooltip).toContain("first/catalog");
    expect(tooltip).toContain("second/catalog (branch:Next)");
    expect(tooltip).toContain("first catalog wins");
  });

  it("lists every source (including Pulsar) with bold labels in the repo tooltip", function () {
    setPackageStatusSpies({ installed: false, disabled: false });
    card = new PackageCard(
      {
        name: "twin",
        repository: "author/twin",
        originKey: "github.com/author/twin",
        status: "ready",
        catalogSelectors: [
          { catalogSource: "owner/catalog", selector: { type: "latest", value: null } },
          { catalogSource: "pulsar", selector: { type: "latest", value: null } },
        ],
      },
      new SettingsView(),
      packageManager,
    );

    const tooltip = card.catalogTooltipLines().join(" ");
    expect(tooltip).toContain("<strong>Origin:</strong>");
    expect(tooltip).toContain("<strong>Catalogs:</strong>");
    expect(tooltip).toContain("owner/catalog");
    expect(tooltip).toContain("Pulsar registry");
  });

  it("disables install with a hover note when no compatible version exists", function () {
    setPackageStatusSpies({ installed: false, disabled: false });
    spyOn(packageManager, "loadCompatiblePackageVersion").andCallFake((name, cb) => cb(null, {}));
    card = new PackageCard(
      {
        name: "test-engines-package",
        repository: "owner/test-engines-package",
        engines: { lumine: ">=100.0.0" },
      },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    expect(card.refs.installButton).toBeVisible();
    expect(card.refs.installButton).toHaveClass("disabled");
    expect(card.installBlocked).toBe(true);
    expect(card.installNoteTooltip).toBeTruthy();
    expect(card.refs.packageMessage.textContent).toBe("");
  });

  it("greys Install for an incompatible catalog card but keeps the version switchable", function () {
    setPackageStatusSpies({ installed: false, disabled: false });
    spyOn(packageManager, "loadCompatiblePackageVersion");
    card = new PackageCard(
      {
        name: "invert-colors",
        version: "0.5.0",
        repository: "asiloisad/pulsar-invert-colors",
        originKey: "github.com/asiloisad/pulsar-invert-colors",
        status: "ready",
        engines: { lumine: ">=100.0.0" },
        selectedRef: { type: "latest", value: "v0.5.0" },
        resolvedSha: "a".repeat(40),
        refs: {
          defaultBranch: "main",
          headSha: "a".repeat(40),
          tags: [{ name: "v0.5.0", sha: "a".repeat(40) }],
        },
      },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    expect(card.refs.installButton).toBeVisible();
    expect(card.refs.installButton).toHaveClass("disabled");
    expect(card.installBlocked).toBe(true);
    // The version selector still works, and the legacy registry is not queried.
    expect(card.refs.versionValue.tagName).toBe("SELECT");
    expect(packageManager.loadCompatiblePackageVersion).not.toHaveBeenCalled();
  });

  describe("the Git install version label", function () {
    const gitCard = (apmInstallSource) => {
      setPackageStatusSpies({ installed: true, disabled: false });
      const built = new PackageCard(
        {
          name: "git-package",
          version: "6.0.0",
          repository: "owner/git-package",
          apmInstallSource,
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(built.element);
      return built;
    };

    it("shows @tag when installed from a tag", function () {
      card = gitCard({
        type: "git",
        selector: { type: "tag", value: "6.0.0" },
        version: "6.0.0",
        sha: "abcdef1234567890",
      });
      expect(card.refs.versionValue.value).toBe("tag:6.0.0");
      expect(card.refs.versionValue.textContent).toBe("@6.0.0");
    });

    it("shows @tag when installed from the latest tag", function () {
      card = gitCard({
        type: "git",
        selector: { type: "latest", value: "6.0.0" },
        version: "6.0.0",
        sha: "abcdef1234567890",
      });
      expect(card.refs.versionValue.textContent).toBe("@6.0.0");
    });

    it("shows #<commit>~branch when installed from a branch", function () {
      card = gitCard({
        type: "git",
        selector: { type: "branch", value: "develop" },
        sha: "abcdef1234567890",
      });
      expect(card.refs.versionValue.value).toBe("branch:develop");
      expect(card.refs.versionValue.textContent).toBe("#abcdef12~develop");
    });

    it("shows #<commit> when installed from a commit", function () {
      card = gitCard({
        type: "git",
        selector: { type: "commit", value: "abcdef1234567890" },
        sha: "abcdef1234567890",
      });
      expect(card.refs.versionValue.textContent).toBe("#abcdef12");
    });

    it("shows #<commit> for a legacy install without a selector", function () {
      card = gitCard({ type: "git", sha: "abcdef1234567890" });
      expect(card.refs.versionValue.textContent).toBe("#abcdef12");
    });
  });

  describe("when a different package with the same name is being installed", function () {
    const emitFor = (event) =>
      packageManager.emitter.emit(event, {
        pack: { name: "hydrogen-next", installSource: "lumine-code/hydrogen-next" },
      });

    beforeEach(function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        {
          name: "hydrogen-next",
          version: "4.14.1",
          repository: "asiloisad/pulsar-hydrogen-next",
          engines: { lumine: "*" },
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
    });

    it("disables this card's install button instead of showing the spinner", function () {
      emitFor("package-installing");
      expect(card.refs.installButton).toHaveClass("disabled");
      expect(card.refs.installButton).not.toHaveClass("is-installing");
      expect(card.installBlocked).toBe(true);
    });

    it("does not claim a same-named event that carries no origin", function () {
      // The event pack has no recorded origin while this card does; a shared name
      // alone must not make this card show its own install spinner for what is an
      // unrelated (e.g. bundled or hand-placed) package.
      packageManager.emitter.emit("package-installing", { pack: { name: "hydrogen-next" } });
      expect(card.refs.installButton).toHaveClass("disabled");
      expect(card.refs.installButton).not.toHaveClass("is-installing");
      expect(card.installBlocked).toBe(true);
    });

    it("reverts to installable if that install fails", function () {
      emitFor("package-installing");
      expect(card.refs.installButton).toHaveClass("disabled");

      emitFor("package-install-failed");
      expect(card.refs.installButton).not.toHaveClass("disabled");
      expect(card.installBlocked).toBe(false);
    });

    it("moves to the conflict state if that install succeeds", function () {
      emitFor("package-installing");
      jasmine.unspy(PackageCard.prototype, "isInstalled");
      spyOn(PackageCard.prototype, "isInstalled").andReturn(true);
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "hydrogen-next",
        apmInstallSource: { type: "git", source: "lumine-code/hydrogen-next" },
      });

      emitFor("package-installed");
      expect(card.refs.installButton).toHaveClass("disabled");
      expect(card.refs.uninstallButton).not.toBeVisible();
      expect(card.installNoteTooltip).toBeTruthy();
    });
  });

  describe("when an installed package only shares its name with the card's package", function () {
    it("identifies the install by apmInstallSource, not the package.json repository", function () {
      // A fork installed from lumine-code/hydrogen-next whose package.json still
      // points repository at the upstream it was forked from. A card for that
      // upstream must still be treated as a *different* package (conflict), and
      // only the card matching the real install source is "installed".
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: true });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "hydrogen-next",
        repository: "https://github.com/asiloisad/pulsar-hydrogen-next",
        apmInstallSource: {
          type: "git",
          source: "lumine-code/hydrogen-next",
          repository: "lumine-code/hydrogen-next",
        },
      });

      const upstreamCard = new PackageCard(
        { name: "hydrogen-next", repository: "asiloisad/pulsar-hydrogen-next" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(upstreamCard.element);
      expect(upstreamCard.refs.installButton).toHaveClass("disabled");
      expect(upstreamCard.installNoteTooltip).toBeTruthy();

      card = new PackageCard(
        { name: "hydrogen-next", repository: "lumine-code/hydrogen-next" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.uninstallButton).toBeVisible();
      expect(card.refs.installButton).not.toHaveClass("disabled");

      upstreamCard.destroy();
    });

    it("offers Replace instead of Install, with an explanatory tooltip", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: true });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "shared-name",
        repository: "https://github.com/someone-else/shared-name.git",
      });
      card = new PackageCard(
        { name: "shared-name", repository: "catalog-owner/shared-name" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.installButton).not.toBeVisible();
      expect(card.refs.replaceButton).toBeVisible();
      expect(card.refs.uninstallButton).not.toBeVisible();
      expect(card.refs.settingsButton).not.toBeVisible();
      expect(card.installNoteTooltip).toBeTruthy();
    });

    it("does not install while in the conflict state", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: true });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "shared-name",
        repository: "https://github.com/someone-else/shared-name.git",
      });
      spyOn(packageManager, "install");
      card = new PackageCard(
        { name: "shared-name", repository: "catalog-owner/shared-name" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      card.refs.installButton.click();
      expect(packageManager.install).not.toHaveBeenCalled();
    });

    it("re-enables the install button once the origin no longer conflicts", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: true });
      const metadataSpy = spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "shared-name",
        repository: "https://github.com/someone-else/shared-name.git",
      });
      card = new PackageCard(
        { name: "shared-name", repository: "catalog-owner/shared-name" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.installButton).toHaveClass("disabled");

      // The conflicting package is uninstalled; the origin no longer clashes.
      metadataSpy.andReturn({
        name: "shared-name",
        repository: "https://github.com/catalog-owner/shared-name.git",
      });
      card.updateInterfaceState();
      expect(card.refs.installButton).not.toHaveClass("disabled");
      expect(card.installNoteTooltip).toBe(null);
    });

    it("shows the regular installed state when the origins match", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "shared-name",
        repository: "https://github.com/catalog-owner/shared-name.git",
      });
      card = new PackageCard(
        { name: "shared-name", repository: "catalog-owner/shared-name@1.2.0" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.uninstallButton).toBeVisible();
      expect(card.refs.packageMessage.textContent).toBe("");
    });

    it("offers Replace when the name matches a bundled package from another origin", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "search-panel",
        repository: "https://github.com/lumine-code/lumine.git",
      });
      card = new PackageCard(
        { name: "search-panel", repository: "impostor-dev/search-panel" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.installButton).not.toBeVisible();
      expect(card.refs.replaceButton).toBeVisible();
      expect(card.refs.replaceButton.textContent).toBe("Replace");
      expect(card.installNoteTooltip).toBeTruthy();
    });

    it("keeps the Uninstall button on a community package overriding a bundled name", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(atom.packages, "isBundledPackage").andCallFake((name) => name === "fuzzy-explorer");
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn(null);
      card = new PackageCard(
        {
          name: "fuzzy-explorer",
          version: "0.3.4",
          repository: "asiloisad/pulsar-fuzzy-explorer",
          path: "/tmp/.lumine/packages/fuzzy-explorer",
          apmInstallSource: {
            type: "git",
            origin: "github.com/asiloisad/pulsar-fuzzy-explorer",
            sha: "a".repeat(40),
            selector: { type: "tag", value: "v0.3.4" },
          },
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.uninstallButton).toBeVisible();
      expect(card.element).not.toHaveClass("is-shadowed");
    });

    it("renders an overridden bundled package as a greyed-out informational card", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: true });
      spyOn(atom.packages, "isBundledPackage").andReturn(true);
      card = new PackageCard(
        {
          name: "fuzzy-explorer",
          version: "0.3.4",
          repository: "lumine-code/lumine",
          packageKind: "builtin",
          isShadowed: true,
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.element).toHaveClass("is-shadowed");
      // Settings + Disable are shown but inert; no Install/Update/Uninstall/Override.
      expect(card.refs.settingsButton).toBeVisible();
      expect(card.refs.settingsButton.disabled).toBe(true);
      expect(card.refs.enablementButton).toBeVisible();
      expect(card.refs.enablementButton.disabled).toBe(true);
      expect(card.refs.installButton).not.toBeVisible();
      expect(card.refs.uninstallButton).not.toBeVisible();
      // A reported update must not turn the informational card into an updater.
      card.displayAvailableUpdate("1.0.0");
      expect(card.refs.updateButton).not.toBeVisible();
    });

    it("blocks Override until the conflicting community card validates", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "search-panel",
        repository: "https://github.com/lumine-code/lumine.git",
      });
      card = new PackageCard(
        {
          name: "search-panel",
          repository: "impostor-dev/search-panel",
          originKey: "github.com/impostor-dev/search-panel",
          status: "error",
          error: "Manifest validation failed.",
        },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);

      expect(card.refs.installButton).toBeVisible();
      expect(card.refs.installButton).toHaveClass("disabled");
      expect(card.refs.replaceButton).not.toBeVisible();
      expect(card.installNote).toContain("Manifest validation failed");
    });

    it("does not open the installed package's settings from a conflicting card", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: true });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "shared-name",
        repository: "https://github.com/someone-else/shared-name.git",
      });
      const settingsView = new SettingsView();
      spyOn(settingsView, "showPanel");
      card = new PackageCard(
        { name: "shared-name", repository: "catalog-owner/shared-name" },
        settingsView,
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      card.element.click();
      expect(settingsView.showPanel).not.toHaveBeenCalled();
    });

    it("offers an update when the same package is installed with an older version", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "shared-name",
        version: "1.0.0",
        repository: "https://github.com/user/shared-name.git",
        apmInstallSource: { type: "git", source: "user/shared-name", sha: "abc123def456" },
      });
      card = new PackageCard(
        { name: "shared-name", version: "1.2.0", repository: "user/shared-name" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.updateButton).toBeVisible();
      expect(card.refs.updateButton.textContent).toContain("Update to 1.2.0");
      expect(card.refs.installButton).not.toBeVisible();
      expect(card.pack.apmInstallSource.source).toBe("user/shared-name");
    });

    it("shows no update when the installed version matches the catalog version", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "shared-name",
        version: "1.2.0",
        repository: "https://github.com/user/shared-name.git",
        apmInstallSource: { type: "git", source: "user/shared-name", sha: "abc123def456" },
      });
      card = new PackageCard(
        { name: "shared-name", version: "1.2.0", repository: "user/shared-name" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.updateButton).not.toBeVisible();
      expect(card.refs.uninstallButton).toBeVisible();
    });

    it("treats an installed package without origin information as the same package", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({ name: "shared-name" });
      card = new PackageCard(
        { name: "shared-name", repository: "catalog-owner/shared-name" },
        new SettingsView(),
        packageManager,
      );
      jasmine.attachToDOM(card.element);
      expect(card.refs.uninstallButton).toBeVisible();
      expect(card.refs.packageMessage.textContent).toBe("");
    });
  });

  it("displays the new version in the update button", function () {
    setPackageStatusSpies({ installed: true, disabled: false, hasSettings: true });
    card = new PackageCard(
      { name: "search-panel", version: "1.0.0", latestVersion: "1.2.0" },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    expect(card.refs.updateButton).toBeVisible();
    expect(card.refs.updateButton.textContent).toContain("Update to 1.2.0");
  });

  it("displays the new version in the update button when the package is disabled", function () {
    setPackageStatusSpies({ installed: true, disabled: true, hasSettings: true });
    card = new PackageCard(
      { name: "search-panel", version: "1.0.0", latestVersion: "1.2.0" },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    expect(card.refs.updateButton).toBeVisible();
    expect(card.refs.updateButton.textContent).toContain("Update to 1.2.0");
  });

  it("offers Update and previews the selected version's description on an installed card", function () {
    setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
    spyOn(packageManager, "inspectPackageUpdate").andReturn(
      Promise.resolve({ name: "git-package", version: "2.0.0", description: "Two point oh" }),
    );
    card = new PackageCard(
      {
        name: "git-package",
        version: "1.0.0",
        description: "One point oh",
        repository: "owner/git-package",
        apmInstallSource: {
          type: "git",
          origin: "github.com/owner/git-package",
          selector: { type: "tag", value: "v1.0.0" },
          sha: "a".repeat(40),
        },
        refs: {
          defaultBranch: "main",
          headSha: "c".repeat(40),
          tags: [
            { name: "v2.0.0", sha: "b".repeat(40) },
            { name: "v1.0.0", sha: "a".repeat(40) },
          ],
        },
      },
      new SettingsView(),
      packageManager,
    );
    jasmine.attachToDOM(card.element);
    expect(card.refs.packageDescription.textContent).toBe("One point oh");

    card.applyInstalledVersionSelection({ type: "tag", value: "v2.0.0" });

    // Synchronously flips to an update targeting the selected commit.
    expect(card.refs.updateButton).toBeVisible();
    expect(card.refs.updateButton.textContent).toContain("Update to 2.0.0");
    expect(card.pack.latestSha).toBe("b".repeat(40));
    const previewArgs = packageManager.inspectPackageUpdate.mostRecentCall.args;
    expect(previewArgs[1]).toBe("b".repeat(40));
    expect(previewArgs[2]).toEqual({ type: "tag", value: "v2.0.0" });

    // The description is previewed from the selected version's manifest.
    waitsFor(() => card.refs.packageDescription.textContent === "Two point oh");

    runs(() => {
      // Selecting the installed version again clears the update and restores it.
      card.applyInstalledVersionSelection({ type: "tag", value: "v1.0.0" });
      expect(card.refs.updateButton).not.toBeVisible();
      expect(card.refs.packageDescription.textContent).toBe("One point oh");
    });
  });

  it("shows a badge", function () {
    const pack = {
      badges: [
        {
          link: "https://example.com",
          title: "Archived",
          text: "Source code has been archived",
          type: "warn",
        },
      ],
      name: "something",
      version: "1.0.0",
      latestVersion: "1.0.0",
    };
    card = new PackageCard(pack, new SettingsView(), packageManager);

    spyOn(atom, "openExternal");
    jasmine.attachToDOM(card.element);
    const badge = card.element.querySelector(".package-badge-dot");
    expect(badge).toExist();
    expect(badge).toHaveClass("badge-dot-warn");
    badge?.click();
    expect(atom.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  describe("when the package is not installed", function () {
    it("shows the settings, uninstall, and disable buttons", function () {
      const pack = {
        name: "some-package",
        version: "0.1.0",
        repository: "http://github.com/omgwow/some-package",
      };
      card = new PackageCard(pack, new SettingsView(), packageManager);

      jasmine.attachToDOM(card.element);

      expect(card.refs.installButtonGroup).toBeVisible();
      expect(card.refs.updateButtonGroup).not.toBeVisible();
      expect(card.refs.packageActionButtonGroup).not.toBeVisible();
    });

    it("can be installed if currently not installed", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      spyOn(packageManager, "install");

      card = new PackageCard(
        { name: "test-package", engines: { lumine: "*" } },
        new SettingsView(),
        packageManager,
      );
      expect(card.refs.installButton.style.display).not.toBe("none");
      expect(card.refs.uninstallButton.style.display).toBe("none");
      card.refs.installButton.click();
      expect(packageManager.install).toHaveBeenCalled();
    });

    it("can be installed if currently not installed and package latest release engine match atom version", function () {
      spyOn(packageManager, "install");
      spyOn(packageManager, "loadCompatiblePackageVersion").andCallFake(
        function (packageName, callback) {
          const pack = {
            name: packageName,
            version: "0.1.0",
            engines: {
              lumine: ">0.50.0",
            },
          };

          return callback(null, pack);
        },
      );

      setPackageStatusSpies({ installed: false, disabled: false });

      card = new PackageCard(
        {
          name: "test-package",
          version: "0.1.0",
          engines: {
            lumine: ">0.50.0",
          },
        },
        new SettingsView(),
        packageManager,
      );

      // In that case there's no need to make a request to get all the versions
      expect(packageManager.loadCompatiblePackageVersion).not.toHaveBeenCalled();

      expect(card.refs.installButton.style.display).not.toBe("none");
      expect(card.refs.uninstallButton.style.display).toBe("none");
      card.refs.installButton.click();
      expect(packageManager.install).toHaveBeenCalled();
      expect(packageManager.install.mostRecentCall.args[0]).toEqual({
        name: "test-package",
        version: "0.1.0",
        engines: {
          lumine: ">0.50.0",
        },
      });
    });

    it("can be installed with a previous version whose engine match the current atom version", function () {
      spyOn(packageManager, "install");
      spyOn(packageManager, "loadCompatiblePackageVersion").andCallFake(
        function (packageName, callback) {
          const pack = {
            name: packageName,
            version: "0.0.1",
            engines: {
              lumine: ">0.50.0",
            },
          };

          return callback(null, pack);
        },
      );

      setPackageStatusSpies({ installed: false, disabled: false });

      card = new PackageCard(
        {
          name: "test-package",
          version: "0.1.0",
          engines: {
            lumine: ">99.0.0",
          },
        },
        new SettingsView(),
        packageManager,
      );

      expect(card.refs.installButton.style.display).not.toBe("none");
      expect(card.refs.installButton).not.toHaveClass("disabled");
      expect(card.refs.uninstallButton.style.display).toBe("none");
      expect(card.refs.versionValue.textContent).toBe("0.0.1");
      expect(card.refs.versionValue).toHaveClass("text-warning");
      // The compatibility note is shown as a hover tooltip, not inline text.
      expect(card.installBlocked).toBe(false);
      expect(card.installNoteTooltip).toBeTruthy();
      card.refs.installButton.click();
      expect(packageManager.install).toHaveBeenCalled();
      expect(packageManager.install.mostRecentCall.args[0]).toEqual({
        name: "test-package",
        version: "0.0.1",
        engines: {
          lumine: ">0.50.0",
        },
      });
    });

    it("can't be installed if there is no version compatible with the current atom version", function () {
      spyOn(packageManager, "loadCompatiblePackageVersion").andCallFake(
        function (packageName, callback) {
          const pack = { name: packageName };

          return callback(null, pack);
        },
      );

      setPackageStatusSpies({ installed: false, disabled: false });

      const pack = {
        name: "test-package",
        engines: {
          lumine: ">=99.0.0",
        },
      };
      card = new PackageCard(pack, new SettingsView(), packageManager);
      jasmine.attachToDOM(card.element);

      // Install stays visible but disabled, with the reason shown on hover.
      expect(card.refs.installButton).toBeVisible();
      expect(card.refs.installButton).toHaveClass("disabled");
      expect(card.installBlocked).toBe(true);
      expect(card.installNoteTooltip).toBeTruthy();
      expect(card.refs.packageActionButtonGroup).not.toBeVisible();
      expect(card.refs.versionValue).toHaveClass("text-error");
    });
  });

  describe("when the package is installed", function () {
    beforeEach(function () {
      atom.packages.loadPackage(path.join(__dirname, "fixtures", "package-with-config"));
      return waitsFor(() => atom.packages.isPackageLoaded("package-with-config") === true);
    });

    it("can be disabled if installed", function () {
      setPackageStatusSpies({ installed: true, disabled: false });
      spyOn(atom.packages, "disablePackage").andReturn(true);

      card = new PackageCard({ name: "test-package" }, new SettingsView(), packageManager);
      expect(card.refs.enablementButton.querySelector(".disable-text").textContent).toBe("Disable");
      card.refs.enablementButton.click();
      expect(atom.packages.disablePackage).toHaveBeenCalled();
    });

    it("can be updated", function () {
      const pack = atom.packages.getLoadedPackage("package-with-config");
      pack.latestVersion = "1.1.0";
      pack.latestSha = "abcdef1234567890";
      pack.apmInstallSource = {
        type: "git",
        source: "example/package-with-config",
        sha: pack.latestSha,
      };
      let packageUpdated = false;

      packageManager.on("package-updated", () => (packageUpdated = true));
      // installGitHubPackage resolves with the installed package's metadata,
      // which carries the apmInstallSource (and thus the origin) — mirror that so
      // the "updated" event is recognized as this card's own package.
      spyOn(packageManager, "installGitHubPackage").andReturn(
        Promise.resolve({
          name: "package-with-config",
          apmInstallSource: { type: "git", source: "example/package-with-config" },
        }),
      );

      const originalLoadPackage = atom.packages.loadPackage;
      spyOn(atom.packages, "loadPackage").andCallFake(() =>
        originalLoadPackage.call(
          atom.packages,
          path.join(__dirname, "fixtures", "package-with-config"),
        ),
      );

      card = new PackageCard(pack, new SettingsView(), packageManager);
      jasmine.attachToDOM(card.element);
      expect(card.refs.updateButton).toBeVisible();

      card.update().catch(() => {});

      waitsFor(() => packageUpdated);

      runs(() => expect(card.refs.updateButton).not.toBeVisible());
    });

    it("keeps the update button visible if the update failed", function () {
      const pack = atom.packages.getLoadedPackage("package-with-config");
      pack.latestVersion = "1.1.0";
      pack.latestSha = "abcdef1234567890";
      pack.apmInstallSource = {
        type: "git",
        source: "example/package-with-config",
        sha: pack.latestSha,
      };
      let updateFailed = false;

      packageManager.on("package-update-failed", () => (updateFailed = true));
      spyOn(packageManager, "installGitHubPackage").andReturn(Promise.reject(new Error("boom")));

      const originalLoadPackage = atom.packages.loadPackage;
      spyOn(atom.packages, "loadPackage").andCallFake(() =>
        originalLoadPackage.call(
          atom.packages,
          path.join(__dirname, "fixtures", "package-with-config"),
        ),
      );

      card = new PackageCard(pack, new SettingsView(), packageManager);
      jasmine.attachToDOM(card.element);
      expect(card.refs.updateButton).toBeVisible();

      card.update();

      waitsFor(() => updateFailed);

      runs(() => expect(card.refs.updateButton).toBeVisible());
    });

    it("does not error when attempting to update without any update available", function () {
      // While this cannot be done through the package card UI,
      // updates can still be triggered through the Updates panel's Update All button
      // https://github.com/atom/settings-view/issues/879

      const pack = atom.packages.getLoadedPackage("package-with-config");

      const originalLoadPackage = atom.packages.loadPackage;
      spyOn(atom.packages, "loadPackage").andCallFake(() =>
        originalLoadPackage.call(
          atom.packages,
          path.join(__dirname, "fixtures", "package-with-config"),
        ),
      );

      card = new PackageCard(pack, new SettingsView(), packageManager);
      jasmine.attachToDOM(card.element);
      expect(card.refs.updateButton).not.toBeVisible();

      waitsForPromise(() => card.update());

      runs(() => expect(card.refs.updateButton).not.toBeVisible());
    });

    it("will stay disabled after an update", function () {
      const pack = atom.packages.getLoadedPackage("package-with-config");
      pack.latestVersion = "1.1.0";
      pack.latestSha = "abcdef1234567890";
      pack.apmInstallSource = {
        type: "git",
        source: "example/package-with-config",
        sha: pack.latestSha,
      };
      let packageUpdated = false;

      packageManager.on("package-updated", () => (packageUpdated = true));
      // See "can be updated": the resolved pack keeps its apmInstallSource/origin.
      spyOn(packageManager, "installGitHubPackage").andReturn(
        Promise.resolve({
          name: "package-with-config",
          apmInstallSource: { type: "git", source: "example/package-with-config" },
        }),
      );

      const originalLoadPackage = atom.packages.loadPackage;
      spyOn(atom.packages, "loadPackage").andCallFake(() =>
        originalLoadPackage.call(
          atom.packages,
          path.join(__dirname, "fixtures", "package-with-config"),
        ),
      );

      pack.disable();
      card = new PackageCard(pack, new SettingsView(), packageManager);
      expect(atom.packages.isPackageDisabled("package-with-config")).toBe(true);
      card.update();

      waitsFor(() => packageUpdated);

      runs(() => expect(atom.packages.isPackageDisabled("package-with-config")).toBe(true));
    });

    it("is uninstalled when the uninstallButton is clicked", function () {
      setPackageStatusSpies({ installed: true, disabled: false });

      let [uninstallCallback] = [];
      spyOn(packageManager, "install").andCallThrough();
      spyOn(packageManager, "uninstall").andCallFake(function (pack, callback) {
        packageManager.emitPackageEvent("uninstalling", pack);
        uninstallCallback = function () {
          if (typeof callback === "function") {
            callback();
          }
          packageManager.emitPackageEvent("uninstalled", pack);
        };
      });

      const pack = atom.packages.getLoadedPackage("package-with-config");
      card = new PackageCard(pack, new SettingsView(), packageManager);
      jasmine.attachToDOM(card.element);

      expect(card.refs.uninstallButton).toBeVisible();
      expect(card.refs.enablementButton).toBeVisible();
      card.refs.uninstallButton.click();

      expect(card.refs.uninstallButton.disabled).toBe(true);
      expect(card.refs.enablementButton.disabled).toBe(true);
      expect(card.refs.uninstallButton).toHaveClass("is-uninstalling");

      expect(packageManager.uninstall).toHaveBeenCalled();
      expect(packageManager.uninstall.mostRecentCall.args[0].name).toEqual("package-with-config");

      jasmine.unspy(PackageCard.prototype, "isInstalled");
      spyOn(PackageCard.prototype, "isInstalled").andReturn(false);
      uninstallCallback(0, "", "");

      waits(1);
      runs(function () {
        expect(card.refs.uninstallButton.disabled).toBe(false);
        expect(card.refs.uninstallButton).not.toHaveClass("is-uninstalling");
        expect(card.refs.installButtonGroup).toBeVisible();
        expect(card.refs.updateButtonGroup).not.toBeVisible();
        expect(card.refs.packageActionButtonGroup).not.toBeVisible();
      });
    });

    it("shows the settings, uninstall, and enable buttons when disabled", function () {
      atom.config.set("package-with-config.setting", "something");
      const pack = atom.packages.getLoadedPackage("package-with-config");
      spyOn(atom.packages, "isPackageDisabled").andReturn(true);
      card = new PackageCard(pack, new SettingsView(), packageManager);
      jasmine.attachToDOM(card.element);

      expect(card.refs.updateButtonGroup).not.toBeVisible();
      expect(card.refs.installButtonGroup).not.toBeVisible();

      expect(card.refs.settingsButton).toBeVisible();
      expect(card.refs.uninstallButton).toBeVisible();
      expect(card.refs.enablementButton).toBeVisible();
      expect(card.refs.enablementButton.textContent).toBe("Enable");
    });

    it("shows the settings, uninstall, and disable buttons", function () {
      atom.config.set("package-with-config.setting", "something");
      const pack = atom.packages.getLoadedPackage("package-with-config");
      card = new PackageCard(pack, new SettingsView(), packageManager);

      jasmine.attachToDOM(card.element);

      expect(card.refs.updateButtonGroup).not.toBeVisible();
      expect(card.refs.installButtonGroup).not.toBeVisible();

      expect(card.refs.settingsButton).toBeVisible();
      expect(card.refs.uninstallButton).toBeVisible();
      expect(card.refs.enablementButton).toBeVisible();
      expect(card.refs.enablementButton.textContent).toBe("Disable");
    });

    it("does not show the settings button when there are no settings", function () {
      const pack = atom.packages.getLoadedPackage("package-with-config");
      spyOn(PackageCard.prototype, "hasSettings").andReturn(false);
      card = new PackageCard(pack, new SettingsView(), packageManager);

      jasmine.attachToDOM(card.element);

      expect(card.refs.settingsButton).not.toBeVisible();
      expect(card.refs.uninstallButton).toBeVisible();
      expect(card.refs.enablementButton).toBeVisible();
      expect(card.refs.enablementButton.textContent).toBe("Disable");
    });
  });

  describe("when a catalog record failed hydration for an installed package", function () {
    // The bare record a failed fetch leaves in the catalog: no manifest fields.
    const brokenRecord = () => ({
      name: "x-pkg",
      originKey: "github.com/lumine-code/x-pkg",
      repository: "lumine-code/x-pkg",
      installSource: "lumine-code/x-pkg",
      unverifiedName: true,
      status: "error",
      error: "Package repository origin does not match install origin.",
    });

    beforeEach(function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      spyOn(PackageCard.prototype, "getInstalledMetadata").andReturn({
        name: "x-pkg",
        version: "1.2.3",
        description: "Colors the cursor.",
        license: "MIT",
        repository: "https://github.com/lumine-code/x-pkg",
      });
    });

    it("fills the card from the installed package's metadata", function () {
      card = new PackageCard(brokenRecord(), new SettingsView(), packageManager);
      jasmine.attachToDOM(card.element);

      expect(card.refs.packageDescription.textContent).toBe("Colors the cursor.");
      expect(card.refs.versionValue.textContent).toBe("1.2.3");
      expect(card.element.querySelector(".package-license").textContent).toBe("MIT");
    });

    it("does not adopt local metadata for a same-named package from another origin", function () {
      PackageCard.prototype.getInstalledMetadata.andReturn({
        name: "x-pkg",
        version: "9.9.9",
        description: "An unrelated package.",
        apmInstallSource: { type: "git", origin: "github.com/someone-else/x-pkg" },
      });
      card = new PackageCard(brokenRecord(), new SettingsView(), packageManager);
      jasmine.attachToDOM(card.element);

      expect(card.refs.packageDescription.textContent).toBe("");
      expect(card.refs.versionValue.textContent).toBe("");
    });
  });

  describe("status dot", function () {
    it("shows an error dot for a record whose catalog fetch failed", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        {
          name: "x-pkg",
          originKey: "github.com/lumine-code/x-pkg",
          repository: "lumine-code/x-pkg",
          status: "error",
          error: "boom",
        },
        new SettingsView(),
        packageManager,
      );
      const dot = card.refs.badges.querySelector(".package-badge-dot");
      expect(dot).not.toBeNull();
      expect(dot.classList.contains("badge-dot-error")).toBe(true);
    });

    it("shows a warning dot for a stale record", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        {
          name: "x-pkg",
          originKey: "github.com/lumine-code/x-pkg",
          repository: "lumine-code/x-pkg",
          version: "1.0.0",
          status: "stale",
          error: "boom",
        },
        new SettingsView(),
        packageManager,
      );
      const dot = card.refs.badges.querySelector(".package-badge-dot");
      expect(dot).not.toBeNull();
      expect(dot.classList.contains("badge-dot-stale")).toBe(true);
    });

    it("shows a purple dot for a Pulsar-registry listing", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        { name: "x-pkg", repository: "owner/x-pkg", version: "1.0.0", source: "pulsar" },
        new SettingsView(),
        packageManager,
      );
      const dot = card.refs.badges.querySelector(".package-badge-dot");
      expect(dot).not.toBeNull();
      expect(dot.classList.contains("badge-dot-pulsar")).toBe(true);
    });

    it("shows no dot for a healthy record", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        { name: "x-pkg", repository: "owner/x-pkg", version: "1.0.0", status: "ready" },
        new SettingsView(),
        packageManager,
      );
      expect(card.refs.badges.querySelector(".package-badge-dot")).toBeNull();
    });

    it("shows a warning dot for an install-origin mismatch", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      card = new PackageCard(
        {
          name: "x-pkg",
          repository: "owner/x-pkg",
          version: "1.0.0",
          originWarning: "Package repository origin is missing or mismatched.",
        },
        new SettingsView(),
        packageManager,
      );
      const badge = card.badgeViews.find((view) => view.badge.title === "Origin");
      expect(badge).toBeTruthy();
      expect(badge.badge.type).toBe("origin");
      expect(badge.badge.text).toContain("missing or mismatched");
    });

    it("shows the selector-conflict dot when catalogs disagree", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        {
          name: "x-pkg",
          repository: "owner/x-pkg",
          version: "1.0.0",
          status: "ready",
          selectorConflict: true,
        },
        new SettingsView(),
        packageManager,
      );
      const badge = card.badgeViews.find((view) => view.badge.title === "Selector conflict");
      expect(badge).toBeTruthy();
      expect(badge.badge.type).toBe("selector");
    });

    it("shows the shadowed dot naming the copy that loads instead", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      card = new PackageCard(
        {
          name: "x-pkg",
          repository: "owner/x-pkg",
          version: "1.0.0",
          isShadowed: true,
          shadowedBy: { name: "x-pkg", dirname: "my-checkout", tier: "dev" },
        },
        new SettingsView(),
        packageManager,
      );
      const badge = card.badgeViews.find((view) => view.badge.title === "Shadowed");
      expect(badge).toBeTruthy();
      expect(badge.badge.type).toBe("shadowed");
      expect(badge.badge.text).toContain("my-checkout");
    });

    it("shows the source dot on a bundled package running from the source checkout", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      card = new PackageCard(
        {
          name: "tabs",
          version: "1.0.0",
          tier: "bundled",
          // What the loader reports while the editor runs from its repository
          // rather than from a build.
          isBundled: false,
          path: path.join("checkout", "packages", "tabs"),
        },
        new SettingsView(),
        packageManager,
      );
      const badge = card.badgeViews.find((view) => view.badge.title === "From the source checkout");
      expect(badge).toBeTruthy();
      expect(badge.badge.type).toBe("source");
      expect(badge.badge.text).toContain(path.join("packages", "tabs"));
    });

    it("shows no source dot for a bundled package in a build", function () {
      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      card = new PackageCard(
        { name: "tabs", version: "1.0.0", tier: "bundled", isBundled: true },
        new SettingsView(),
        packageManager,
      );
      expect(
        card.badgeViews.find((view) => view.badge.title === "From the source checkout"),
      ).toBeUndefined();
    });

    it("treats a record hydrated from the Pulsar registry as Pulsar-sourced", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        {
          name: "x-pkg",
          repository: "owner/x-pkg",
          version: "1.0.0",
          status: "ready",
          catalogSources: ["pulsar"],
        },
        new SettingsView(),
        packageManager,
      );
      const dot = card.refs.badges.querySelector(".package-badge-dot");
      expect(dot).not.toBeNull();
      expect(dot.classList.contains("badge-dot-pulsar")).toBe(true);
    });

    it("shows every applicable dot at once", function () {
      setPackageStatusSpies({ installed: false, disabled: false });
      card = new PackageCard(
        {
          name: "x-pkg",
          repository: "owner/x-pkg",
          version: "1.0.0",
          status: "stale",
          error: "boom",
          source: "pulsar",
          selectorConflict: true,
        },
        new SettingsView(),
        packageManager,
      );
      const titles = card.badgeViews.map((view) => view.badge.title);
      expect(titles).toEqual(["Stale", "Selector conflict", "Pulsar registry"]);
    });
  });

  describe("symlink dot", function () {
    let tmpDir = null;

    afterEach(function () {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    });

    it("shows an 'Installed as symlink' dot for a linked install", function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "card-symlink-"));
      const target = path.join(tmpDir, "x-pkg-src");
      fs.mkdirSync(target);
      const link = path.join(tmpDir, "x-pkg");
      // A junction, so the spec needs no elevated rights on Windows.
      fs.symlinkSync(target, link, "junction");

      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      card = new PackageCard(
        { name: "x-pkg", version: "1.0.0", repository: "owner/x-pkg", path: link },
        new SettingsView(),
        packageManager,
      );

      const badge = card.badgeViews.find((view) => view.badge.title === "Installed as symlink");
      expect(badge).toBeTruthy();
      expect(card.refs.badges.querySelectorAll(".package-badge-dot").length).toBe(1);
    });

    it("shows no symlink dot for a real install directory", function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "card-symlink-"));
      const dir = path.join(tmpDir, "x-pkg");
      fs.mkdirSync(dir);

      setPackageStatusSpies({ installed: true, disabled: false, hasSettings: false });
      card = new PackageCard(
        { name: "x-pkg", version: "1.0.0", repository: "owner/x-pkg", path: dir },
        new SettingsView(),
        packageManager,
      );

      expect(card.badgeViews.some((view) => view.badge.title === "Installed as symlink")).toBe(
        false,
      );
    });
  });
});
