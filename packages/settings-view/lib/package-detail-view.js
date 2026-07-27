/** @babel */
/** @jsx etch.dom */

import path from "path";

import _ from "@lumine-code/underscore-plus";
import fs from "@lumine-code/fs-plus";
import { CompositeDisposable, Disposable } from "atom";
import etch from "@lumine-code/etch";

import PackageCard from "./package-card";
import PackageGrammarsView from "./package-grammars-view";
import PackageKeymapView from "./package-keymap-view";
import PackageReadmeView from "./package-readme-view";
import PackageSnippetsView from "./package-snippets-view";
import SettingsPanel from "./settings-panel";
import { packageOrigin } from "./utils";

const NORMALIZE_PACKAGE_DATA_README_ERROR = "ERROR: No README data found!";

// The sections of the detail view. Each is appended to `refs.sections` and they
// are all shown at once, as one long scrolling list; the sidebar table of
// contents is the navigation, listing every section (with the README's own
// headers nested under it).
const SECTION_META = {
  settings: { label: "Settings", icon: "icon-gear" },
  keymap: { label: "Keybindings", icon: "icon-keyboard" },
  grammars: { label: "Grammars", icon: "icon-file-code" },
  snippets: { label: "Snippets", icon: "icon-code" },
  readme: { label: "README", icon: "icon-book" },
};

export default class PackageDetailView {
  constructor(pack, settingsView, packageManager, snippetsProvider) {
    this.pack = pack;
    if (Array.isArray(pack.badges)) {
      // Badges are only available on the object when loading their data from the
      // API server. Once local the badge data is lost.
      // Plus we want to modify the original item to ensure further changes can take effect properly
      pack.metadata.badges = pack.badges;
    }
    this.settingsView = settingsView;
    this.packageManager = packageManager;
    this.snippetsProvider = snippetsProvider;
    this.disposables = new CompositeDisposable();
    this.previewMode = false;
    this.initialSection = null;
    etch.initialize(this);
    this.setupSections();
    this.loadPackage();
    this.subscribeToPackageEnablement();

    this.disposables.add(
      atom.commands.add(this.element, {
        "core:move-up": () => {
          this.scrollUp();
        },
        "core:move-down": () => {
          this.scrollDown();
        },
        "core:page-up": () => {
          this.pageUp();
        },
        "core:page-down": () => {
          this.pageDown();
        },
        "core:move-to-top": () => {
          this.scrollToTop();
        },
        "core:move-to-bottom": () => {
          this.scrollToBottom();
        },
      }),
    );

    const issueButtonClickHandler = (event) => {
      event.preventDefault();
      let bugUri = this.packageManager.getRepositoryBugUri(this.pack);
      if (bugUri) {
        atom.openExternal(bugUri);
      }
    };
    this.refs.issueButton.addEventListener("click", issueButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.issueButton.removeEventListener("click", issueButtonClickHandler);
      }),
    );

    const changelogButtonClickHandler = (event) => {
      event.preventDefault();
      if (this.changelogPath) {
        this.openMarkdownFile(this.changelogPath);
      }
    };
    this.refs.changelogButton.addEventListener("click", changelogButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.changelogButton.removeEventListener("click", changelogButtonClickHandler);
      }),
    );

    const licenseButtonClickHandler = (event) => {
      event.preventDefault();
      this.openLicense();
    };
    this.refs.licenseButton.addEventListener("click", licenseButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.licenseButton.removeEventListener("click", licenseButtonClickHandler);
      }),
    );

    const openButtonClickHandler = (event) => {
      event.preventDefault();
      if (fs.existsSync(this.pack.path)) {
        atom.open({ pathsToOpen: [this.pack.path] });
      }
    };
    this.refs.openButton.addEventListener("click", openButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.openButton.removeEventListener("click", openButtonClickHandler);
      }),
    );

    const learnMoreButtonClickHandler = (event) => {
      event.preventDefault();
      const repoUrl = this.packageManager.getRepositoryUrl(this.pack);
      if (repoUrl) {
        atom.openExternal(repoUrl);
      }
    };
    this.refs.learnMoreButton.addEventListener("click", learnMoreButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.learnMoreButton.removeEventListener("click", learnMoreButtonClickHandler);
      }),
    );

    const breadcrumbClickHandler = (event) => {
      event.preventDefault();
      this.settingsView.showPanel(this.breadcrumbBackPanel);
    };
    this.refs.breadcrumb.addEventListener("click", breadcrumbClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.breadcrumb.removeEventListener("click", breadcrumbClickHandler);
      }),
    );
  }

  completeInitialization() {
    this.hideLoadingMessage();
    if (this.refs.packageCard) {
      this.packageCard = this.refs.packageCard.packageCard;
    } else if (!this.packageCard) {
      // Had to load this from the network
      this.packageCard = new PackageCard(
        this.pack.metadata,
        this.settingsView,
        this.packageManager,
        {
          onSettingsView: true,
          isShadowed: this.pack.isShadowed,
          onPackUpdated: (updatedPack) => this.applySelectedRef(updatedPack),
        },
      );
      this.refs.packageCardParent.replaceChild(this.packageCard.element, this.refs.loadingMessage);
    }

    this.refs.startupTime.classList.remove("hidden");
    this.refs.buttons.classList.remove("hidden");
    this.activateConfig();
    this.populate();
    this.updateFileButtons();
    this.subscribeToPackageManager();
    this.renderReadme();
  }

  loadPackage() {
    const loadedPackage = this.getMatchingLoadedPackage();
    if (loadedPackage) {
      this.pack = loadedPackage;
      this.completeInitialization();
    } else if (this.pack.metadata) {
      // A same-named loaded package may be a bundled package or another
      // community origin. Keep the exact card metadata instead of crossing
      // package identities, and never query the legacy registry by name.
      this.completeInitialization();
    } else {
      this.showErrorMessage();
    }
  }

  getMatchingLoadedPackage() {
    const loadedPackage = atom.packages.getLoadedPackage(this.pack.name);
    if (!loadedPackage) return null;

    const requested = this.pack.metadata || this.pack;
    const requestedOrigin = packageOrigin(requested);
    const loadedOrigin = packageOrigin(loadedPackage.metadata);
    if (requestedOrigin) return requestedOrigin === loadedOrigin ? loadedPackage : null;

    const requestsBuiltin =
      this.pack.packageKind === "builtin" ||
      this.pack.isBuiltinDescriptor ||
      requested.packageKind === "builtin" ||
      requested.isBuiltinDescriptor;
    if (requestsBuiltin && loadedOrigin) return null;
    return loadedPackage;
  }

  hideLoadingMessage() {
    if (this.refs.loadingMessage) this.refs.loadingMessage.classList.add("hidden");
  }

  showErrorMessage() {
    this.hideLoadingMessage();
    this.refs.errorMessage.classList.remove("hidden");
  }

  hideErrorMessage() {
    this.refs.errorMessage.classList.add("hidden");
  }

  activateConfig() {
    // Package.activateConfig() is part of the Private package API and should not be used outside of core.
    if (this.getMatchingLoadedPackage() && !atom.packages.isPackageActive(this.pack.name)) {
      this.pack.activateConfig();
    }
  }

  destroy() {
    this.settingsPanel = this.destroySection(this.settingsPanel);
    this.keymapView = this.destroySection(this.keymapView);
    this.grammarsView = this.destroySection(this.grammarsView);
    this.snippetsView = this.destroySection(this.snippetsView);
    this.readmeView = this.destroySection(this.readmeView);

    if (this.packageCard) {
      this.packageCard.destroy();
      this.packageCard = null;
    }

    if (this.settingsView && typeof this.settingsView.clearTableOfContents === "function") {
      this.settingsView.clearTableOfContents();
    }

    this.disposables.dispose();
    return etch.destroy(this);
  }

  setupSections() {
    // Sub-views are appended asynchronously (settings/keymap/grammars/snippets on
    // install, the README once fetched), so refresh the section visibility and
    // the table of contents whenever the section list changes.
    this.sectionsObserver = new MutationObserver(() => this.updateSections());
    this.sectionsObserver.observe(this.refs.sections, { childList: true, subtree: true });
    this.disposables.add(new Disposable(() => this.sectionsObserver.disconnect()));
  }

  // Hides the sections that have nothing to show and republishes the table of
  // contents for the rest. Idempotent: safe to call on every mutation.
  updateSections() {
    if (!this.refs || !this.refs.sections) return;

    for (const [key, element] of this.sectionElements()) {
      element.style.display = this.sectionHasContent(key, element) ? "" : "none";
    }

    this.publishTableOfContents();
  }

  sectionElements() {
    const elements = new Map();
    for (const child of this.refs.sections.children) {
      const key = child.dataset && child.dataset.section;
      if (key) elements.set(key, child);
    }
    return elements;
  }

  // Whether a section actually has something to show, so the list doesn't carry
  // an empty heading (e.g. a package with no settings, keybindings, or grammars).
  sectionHasContent(key, element) {
    // While previewing a version other than the installed one, only the README
    // belongs to that version (it is fetched for the previewed commit); settings,
    // keymaps, grammars, and snippets describe the installed copy.
    if (this.previewMode && key !== "readme") return false;

    switch (key) {
      case "settings":
        return !!element.querySelector(".control-group");
      case "keymap":
      case "snippets":
        return !!element.querySelector("tbody tr");
      case "grammars":
        return !!element.querySelector(".settings-panel");
      default:
        return true; // readme
    }
  }

  update() {}

  beforeShow(opts) {
    if (opts.back == null) {
      opts.back = "Install";
    }

    this.breadcrumbBackPanel = opts.back;
    this.refs.breadcrumb.textContent = this.breadcrumbBackPanel;

    // The opener may ask for a section (the card's Settings button opens straight
    // on the Settings section). The scroll itself waits for `show()`, once the
    // view is laid out.
    this.initialSection = opts.initialSection || null;
    this.updateSections();
  }

  show() {
    this.element.style.display = "";

    const section = this.initialSection && this.sectionElements().get(this.initialSection);
    this.initialSection = null;
    if (section && section.style.display !== "none") {
      // A requested section wins over the scroll position this panel was left at,
      // which `setActivePanel` restores right after `show()`.
      delete this.scrollPosition;
      section.scrollIntoView();
    }

    this.publishTableOfContents();
  }

  focus() {
    this.element.focus();
  }

  render() {
    let packageCardView;
    if (this.pack && this.pack.metadata && this.pack.metadata.owner) {
      packageCardView = (
        <div ref="packageCardParent" className="row">
          <PackageCardComponent
            ref="packageCard"
            settingsView={this.settingsView}
            packageManager={this.packageManager}
            metadata={this.pack.metadata}
            options={{
              onSettingsView: true,
              isShadowed: this.pack.isShadowed,
              onPackUpdated: (updatedPack) => this.applySelectedRef(updatedPack),
            }}
          />
        </div>
      );
    } else {
      packageCardView = (
        <div ref="packageCardParent" className="row">
          <div
            ref="loadingMessage"
            className="alert alert-info icon icon-hourglass"
          >{`Loading ${this.pack.name}\u2026`}</div>
          <div ref="errorMessage" className="alert alert-danger icon icon-hourglass hidden">
            Failed to load {this.pack.name} - try again later.
          </div>
        </div>
      );
    }
    return (
      <div tabIndex="0" className="package-detail">
        <ol ref="breadcrumbContainer" className="native-key-bindings breadcrumb" tabIndex="-1">
          <li>
            <a ref="breadcrumb" />
          </li>
          <li className="active">
            <a ref="title" />
          </li>
        </ol>

        <div className="panels-item">
          <section className="section">
            <form className="section-container package-detail-view">
              <div className="container package-container">{packageCardView}</div>

              <div ref="buttons" className="btn-wrap-group hidden">
                <button ref="learnMoreButton" className="btn btn-default icon icon-link">
                  View on GitHub
                </button>
                <button ref="issueButton" className="btn btn-default icon icon-bug">
                  Report Issue
                </button>
                <button ref="changelogButton" className="btn btn-default icon icon-squirrel">
                  CHANGELOG
                </button>
                <button ref="licenseButton" className="btn btn-default icon icon-law">
                  LICENSE
                </button>
                <button ref="openButton" className="btn btn-default icon icon-link-external">
                  View Code
                </button>
              </div>

              <p
                ref="startupTime"
                className="text icon icon-dashboard startup-time hidden"
                tabIndex="-1"
              />

              <div ref="errors" />
            </form>
          </section>

          <div ref="sections" />
        </div>
      </div>
    );
  }

  populate() {
    this.refs.title.textContent = `${_.undasherize(_.uncamelcase(this.pack.name))}`;
    this.type = this.pack.metadata.theme ? "theme" : "package";
    this.updateInstalledState();
  }

  updateInstalledState() {
    // This renders the installed version, so leave any preview mode.
    this.previewMode = false;

    this.readmeView = this.destroySection(this.readmeView);
    this.updateFileButtons();
    this.updateConfigSections();

    const loadedPackage = this.getMatchingLoadedPackage();
    const sourceIsAvailable =
      loadedPackage &&
      loadedPackage.path &&
      ((loadedPackage.metadata.apmInstallSource &&
        loadedPackage.metadata.apmInstallSource.type === "git") ||
        !atom.packages.isBundledPackage(this.pack.name));
    if (sourceIsAvailable) {
      this.refs.openButton.style.display = "";
    } else {
      this.refs.openButton.style.display = "none";
    }

    this.renderReadme();
  }

  // A package only contributes settings, keybindings, grammars, and snippets
  // while it is installed at this name and enabled.
  packageIsEnabled() {
    return !!this.getMatchingLoadedPackage() && !atom.packages.isPackageDisabled(this.pack.name);
  }

  // Rebuilds the sections that describe the package as it runs here. A disabled
  // package contributes none of them, so they are dropped until it is enabled
  // again — and rebuilt from the freshly loaded package when it is.
  updateConfigSections() {
    this.settingsPanel = this.destroySection(this.settingsPanel);
    this.keymapView = this.destroySection(this.keymapView);
    this.grammarsView = this.destroySection(this.grammarsView);
    this.snippetsView = this.destroySection(this.snippetsView);

    this.activateConfig();
    this.refs.startupTime.style.display = "none";
    this.configSectionsBuilt = this.packageIsEnabled();

    if (this.configSectionsBuilt) {
      this.settingsPanel = new SettingsPanel({ namespace: this.pack.name, includeTitle: false });
      this.keymapView = new PackageKeymapView(this.pack);
      this.appendSection(this.settingsPanel.element, "settings");
      this.appendSection(this.keymapView.element, "keymap");

      if (this.pack.path) {
        this.grammarsView = new PackageGrammarsView(this.pack.path);
        this.snippetsView = new PackageSnippetsView(this.pack, this.snippetsProvider);
        this.appendSection(this.grammarsView.element, "grammars");
        this.appendSection(this.snippetsView.element, "snippets");
      }

      this.refs.startupTime.innerHTML = `This ${this.type} added <span class='highlight'>${this.getStartupTime()}ms</span> to startup time.`;
      this.refs.startupTime.style.display = "";
    }

    this.updateSections();
  }

  // The config sections always precede the README, which is the last section of
  // the list. It is appended after them on a full render, but is already in
  // place when only the config sections are rebuilt.
  appendSection(element, key) {
    element.dataset.section = key;
    this.refs.sections.insertBefore(element, this.readmeView ? this.readmeView.element : null);
  }

  // Drops a section's sub-view together with its element. The etch-based ones
  // remove their node on the next animation frame, which would leave a
  // torn-down section standing in the list — and in the table of contents —
  // until then.
  destroySection(view) {
    if (!view) return null;
    view.element.remove();
    view.destroy();
    return null;
  }

  // The detail view outlives the package being enabled or disabled — from its
  // own card, from the Packages list, or from the config file — so it keeps its
  // sections current instead of only being right when freshly opened.
  subscribeToPackageEnablement() {
    const refresh = () => this.updateEnablementState();
    this.disposables.add(
      atom.config.onDidChange("core.disabledPackages", refresh),
      atom.packages.onDidActivatePackage((pack) => {
        if (pack.name === this.pack.name) refresh();
      }),
      atom.packages.onDidDeactivatePackage((pack) => {
        if (pack.name === this.pack.name) refresh();
      }),
    );
  }

  updateEnablementState() {
    if (!this.pack.metadata) return;

    const loadedPackage = this.getMatchingLoadedPackage();
    const enabled = !!loadedPackage && !atom.packages.isPackageDisabled(this.pack.name);
    // Enabling arrives twice — as the `core.disabledPackages` change and again as
    // the activation — and every package's toggle is heard on the config change,
    // so do nothing unless this package's state or its loaded copy really moved.
    // A rebuild replaces the sections the reader is looking at.
    if (enabled === this.configSectionsBuilt && (!loadedPackage || loadedPackage === this.pack)) {
      return;
    }

    // A package the session started disabled is loaded only once it is enabled,
    // so adopt the real package before building anything from it.
    if (loadedPackage) this.pack = loadedPackage;
    this.updateConfigSections();
  }

  // Opens the package's LICENSE. The card only names the license (its SPDX id,
  // e.g. "MIT"), so the text itself lives one click away on GitHub: the catalog
  // records the exact blob URL whenever it fetches a license, and for a package
  // on disk the file name is known, so the URL can be built directly. A package
  // with no GitHub origin (a bundled or local package) opens its local file.
  async openLicense() {
    const meta = this.pack.metadata || {};
    const known = meta.licenseSource || this.licenseBlobUrl();
    if (known) {
      atom.openExternal(known);
      return;
    }

    if (this.licensePath) {
      this.openMarkdownFile(this.licensePath);
      return;
    }

    // Nothing local and no fetched license yet, so the file name is still unknown:
    // the catalog looks the LICENSE up for the resolved commit (and caches it) and
    // reports where it found it.
    const entry = await this.packageManager
      .getCatalogClient()
      .loadLicense(meta)
      .catch(() => null);
    if (entry && entry.source) {
      meta.licenseSource = entry.source;
      atom.openExternal(entry.source);
    } else {
      // The manifest names a license but the repository ships no file for it.
      atom.notifications.addWarning(`No LICENSE file found in ${this.pack.name}.`);
    }
  }

  // The GitHub blob URL of the local LICENSE file, at the commit the view shows.
  licenseBlobUrl() {
    if (!this.licensePath) return null;
    const meta = this.pack.metadata || {};
    const install = meta.apmInstallSource || {};
    const originKey = meta.originKey || install.origin || "";
    const sha = meta.resolvedSha || install.sha;
    if (!originKey.startsWith("github.com/") || !sha) return null;
    const repoPath = originKey.slice("github.com/".length);
    return `https://github.com/${repoPath}/blob/${sha}/${path.basename(this.licensePath)}`;
  }

  // The LICENSE button is only offered when it can lead somewhere: a local file,
  // a license already fetched, or a declared license on a known GitHub commit
  // (which the catalog can look up on demand).
  updateLicenseButton() {
    const meta = this.pack.metadata || {};
    const available =
      this.licensePath ||
      meta.licenseSource ||
      (meta.license && meta.originKey && meta.resolvedSha);
    this.refs.licenseButton.style.display = available ? "" : "none";
  }

  // The embedded card changed its selected ref. Reflect the new commit in the
  // detail view and re-fetch the README for that exact commit, since a README
  // belongs to the version it ships with.
  applySelectedRef(pack) {
    if (!this.pack || !this.pack.metadata) return;
    const meta = this.pack.metadata;
    // For an installed card the freshly selected commit is `latestSha`;
    // `resolvedSha` may still hold the installed commit.
    const sha = pack.latestSha || pack.resolvedSha || null;
    const shaChanged = !!sha && sha !== meta.resolvedSha;
    if (pack.selectedRef) meta.selectedRef = pack.selectedRef;
    if (pack.originKey) meta.originKey = pack.originKey;
    else if (!meta.originKey && meta.apmInstallSource)
      meta.originKey = meta.apmInstallSource.origin;
    if (pack.version != null) meta.version = pack.version;
    if (sha) meta.resolvedSha = sha;
    if (pack.name && pack.name !== this.pack.name) {
      this.pack.name = pack.name;
      meta.name = pack.name;
      this.refs.title.textContent = _.undasherize(_.uncamelcase(pack.name));
    }
    // Settings, keymaps, grammars, and snippets belong to the installed version.
    // While a different version is selected, only the README is shown, re-fetched
    // for that version.
    this.previewMode = pack.previewVersion === true;
    if (shaChanged) {
      meta.readme = undefined;
      meta.readmeSource = undefined;
      this.readmeRequested = false;
      // The LICENSE belongs to its commit too, so drop the URL of the old one.
      meta.licenseSource = undefined;
      this.renderReadme();
    }
    this.updateLicenseButton();
    this.updateSections();
  }

  setConfigSectionsVisible(visible) {
    // Previewing a non-installed version restricts the list to the README, which
    // is re-fetched for that version.
    this.previewMode = !visible;
    this.updateSections();
  }

  renderReadme() {
    let readme;
    if (
      this.pack.metadata.readme &&
      this.pack.metadata.readme.trim() !== NORMALIZE_PACKAGE_DATA_README_ERROR
    ) {
      readme = this.pack.metadata.readme;
    } else {
      readme = null;
    }

    if (
      !readme &&
      !this.readmeRequested &&
      this.pack.metadata.originKey &&
      this.pack.metadata.resolvedSha
    ) {
      this.readmeRequested = true;
      this.packageManager
        .getCatalogClient()
        .loadReadme(this.pack.metadata)
        .then((entry) => {
          if (!entry) return;
          this.pack.metadata.readme = entry.body;
          this.pack.metadata.readmeSource = entry.source;
          this.renderReadme();
        })
        .catch(() => {});
    }

    if (
      this.readmePath &&
      fs.existsSync(this.readmePath) &&
      fs.statSync(this.readmePath).isFile() &&
      !readme
    ) {
      readme = fs.readFileSync(this.readmePath, { encoding: "utf8" });
    }

    let readmeSrc, readmeIsLocal;

    if (this.pack.path) {
      // If package is installed, use installed path
      readmeSrc = this.readmePath || path.join(this.pack.path, "README.md");
      readmeIsLocal = true;
    } else {
      // If package isn't installed, use url path
      let repoUrl = this.packageManager.getRepositoryUrl(this.pack);
      readmeIsLocal = false;

      // Check if URL is undefined (i.e. package is unpublished)
      if (repoUrl) {
        readmeSrc = this.pack.metadata.readmeSource || repoUrl;
      }
    }

    const readmeView = new PackageReadmeView(readme, readmeSrc, readmeIsLocal);
    readmeView.element.dataset.section = "readme";
    if (this.readmeView) {
      this.readmeView.element.parentElement.replaceChild(
        readmeView.element,
        this.readmeView.element,
      );
      this.readmeView.destroy();
    } else {
      this.refs.sections.appendChild(readmeView.element);
    }
    this.readmeView = readmeView;
    this.updateSections();
  }

  // Publishes the sections on show — and the current README's own headers, nested
  // under it — to the sidebar TOC, which is how the long list is navigated. Only
  // while this detail view is the visible panel, so an async README load for a
  // panel the user has navigated away from does not hijack the sidebar.
  publishTableOfContents() {
    if (!this.settingsView || typeof this.settingsView.showTableOfContents !== "function") return;
    if (this.element.style.display === "none") return;

    const entries = [];
    for (const [key, element] of this.sectionElements()) {
      const meta = SECTION_META[key];
      if (!meta || element.style.display === "none") continue;
      entries.push({
        label: meta.label,
        icon: meta.icon,
        level: 1,
        onClick: () => element.scrollIntoView(),
      });
      if (key === "readme") entries.push(...this.readmeTableOfContents());
    }
    this.settingsView.showTableOfContents(entries);
  }

  // The README's own headers, nested one level below its section entry. Its top
  // headers still align with the section entries; only headers below them are
  // indented. Levels deeper than the sidebar indents share the last one rather
  // than running off it.
  readmeTableOfContents() {
    const readme = this.readmeView && this.readmeView.packageReadme;
    const headings = readme ? readme.querySelectorAll("h1, h2, h3, h4, h5, h6") : [];
    const entries = [];
    for (const heading of headings) {
      const label = heading.textContent.trim();
      if (!label) continue;
      entries.push({
        label,
        // A uniform sub-item marker, so every TOC row carries an icon and the
        // labels align with the section entries above.
        icon: "icon-chevron-right",
        level: Math.min((Number(heading.tagName.slice(1)) || 1) + 1, 6),
        onClick: () => heading.scrollIntoView(),
      });
    }
    return entries;
  }

  subscribeToPackageManager() {
    this.disposables.add(
      this.packageManager.on("theme-installed package-installed", ({ pack }) => {
        if (this.isSamePackage(pack)) {
          this.loadPackage();
          this.updateInstalledState();
        }
      }),
    );

    this.disposables.add(
      this.packageManager.on("theme-uninstalled package-uninstalled", ({ pack }) => {
        if (this.isSamePackage(pack)) {
          return this.updateInstalledState();
        }
      }),
    );

    this.disposables.add(
      this.packageManager.on("theme-updated package-updated", ({ pack }) => {
        if (this.isSamePackage(pack)) {
          this.loadPackage();
          this.updateFileButtons();
          this.populate();
        }
      }),
    );
  }

  isSamePackage(pack) {
    if (!pack) return false;
    const currentOrigin = packageOrigin(this.pack.metadata || this.pack);
    const eventOrigin = packageOrigin(pack.metadata || pack);
    if (currentOrigin && eventOrigin) return currentOrigin === eventOrigin;
    return this.pack.name === pack.name;
  }

  openMarkdownFile(path) {
    if (atom.packages.isPackageActive("markdown-preview")) {
      atom.workspace.open(encodeURI(`markdown-preview://${path}`));
    } else {
      atom.workspace.open(path);
    }
  }

  updateFileButtons() {
    this.changelogPath = null;
    this.licensePath = null;
    this.readmePath = null;

    const matchingLoadedPackage = this.getMatchingLoadedPackage();
    const packagePath =
      this.pack.path != null
        ? this.pack.path
        : matchingLoadedPackage && matchingLoadedPackage.path
          ? matchingLoadedPackage.path
          : null;
    if (!packagePath) {
      this.refs.changelogButton.style.display = "none";
      this.updateLicenseButton();
      return;
    }
    for (const child of fs.listSync(packagePath)) {
      switch (path.basename(child, path.extname(child)).toLowerCase()) {
        case "changelog":
        case "history":
          this.changelogPath = child;
          break;
        case "license":
        case "licence":
          this.licensePath = child;
          break;
        case "readme":
          this.readmePath = child;
          break;
      }

      if (this.readmePath && this.changelogPath && this.licensePath) {
        break;
      }
    }

    if (this.changelogPath) {
      this.refs.changelogButton.style.display = "";
    } else {
      this.refs.changelogButton.style.display = "none";
    }

    this.updateLicenseButton();
  }

  getStartupTime() {
    const loadTime = this.pack.loadTime != null ? this.pack.loadTime : 0;
    const activateTime = this.pack.activateTime != null ? this.pack.activateTime : 0;
    return loadTime + activateTime;
  }

  scrollUp() {
    this.element.scrollTop -= document.body.offsetHeight / 20;
  }

  scrollDown() {
    this.element.scrollTop += document.body.offsetHeight / 20;
  }

  pageUp() {
    this.element.scrollTop -= this.element.offsetHeight;
  }

  pageDown() {
    this.element.scrollTop += this.element.offsetHeight;
  }

  scrollToTop() {
    this.element.scrollTop = 0;
  }

  scrollToBottom() {
    this.element.scrollTop = this.element.scrollHeight;
  }
}

class PackageCardComponent {
  constructor(props) {
    this.packageCard = new PackageCard(
      props.metadata,
      props.settingsView,
      props.packageManager,
      props.options,
    );
    this.element = this.packageCard.element;
  }

  update() {}

  destroy() {}
}
