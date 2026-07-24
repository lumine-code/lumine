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
import PackageLicenseView from "./package-license-view";
import PackageReadmeView from "./package-readme-view";
import PackageSnippetsView from "./package-snippets-view";
import SettingsPanel from "./settings-panel";
import { packageOrigin } from "./utils";

const NORMALIZE_PACKAGE_DATA_README_ERROR = "ERROR: No README data found!";

// The chapters of the detail view, in tab order. Each maps to a section that is
// appended to `refs.sections`; only one chapter is shown at a time, selected by
// the labeled tab buttons beside the action buttons.
const CHAPTER_ORDER = ["readme", "settings", "keymap", "grammars", "snippets", "license"];
const CHAPTER_META = {
  readme: { label: "README", icon: "icon-book" },
  settings: { label: "Settings", icon: "icon-gear" },
  keymap: { label: "Keybindings", icon: "icon-keyboard" },
  grammars: { label: "Grammars", icon: "icon-file-code" },
  snippets: { label: "Snippets", icon: "icon-code" },
  license: { label: "License", icon: "icon-law" },
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
    this.activeChapter = "readme";
    this.previewMode = false;
    etch.initialize(this);
    this.setupChapters();
    this.loadPackage();

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
    if (this.settingsPanel) {
      this.settingsPanel.destroy();
      this.settingsPanel = null;
    }

    if (this.keymapView) {
      this.keymapView.destroy();
      this.keymapView = null;
    }

    if (this.grammarsView) {
      this.grammarsView.destroy();
      this.grammarsView = null;
    }

    if (this.snippetsView) {
      this.snippetsView.destroy();
      this.snippetsView = null;
    }

    if (this.readmeView) {
      this.readmeView.destroy();
      this.readmeView = null;
    }

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

  setupChapters() {
    const clickHandler = (event) => {
      const button = event.target.closest("[data-chapter-tab]");
      if (!button || !this.refs.chapterTabs.contains(button)) return;
      this.setActiveChapter(button.dataset.chapterTab);
    };
    this.refs.chapterTabs.addEventListener("click", clickHandler);
    this.disposables.add(
      new Disposable(() => this.refs.chapterTabs.removeEventListener("click", clickHandler)),
    );

    // Sub-views are appended asynchronously (settings/keymap/grammars/snippets on
    // install, the README once fetched), so rebuild the chapter tabs whenever the
    // section list changes.
    this.sectionsObserver = new MutationObserver(() => this.rebuildChapters());
    this.sectionsObserver.observe(this.refs.sections, { childList: true, subtree: true });
    this.disposables.add(new Disposable(() => this.sectionsObserver.disconnect()));
  }

  // (Re)builds the labeled chapter tabs from the sections currently present and
  // shows only the active chapter. Idempotent: safe to call on every mutation.
  rebuildChapters() {
    if (!this.refs || !this.refs.chapterTabs) return;

    const elements = this.chapterElements();

    // While previewing a version other than the installed one, only the README
    // and License belong to that version (both are fetched for the previewed
    // commit); settings, keymaps, grammars, and snippets describe the installed
    // copy.
    const allowed = this.previewMode ? new Set(["readme", "license"]) : null;
    const chapters = CHAPTER_ORDER.filter((key) => {
      const element = elements.get(key);
      if (!element) return false;
      if (allowed && !allowed.has(key)) return false;
      return this.chapterHasContent(key, element);
    });

    if (!chapters.includes(this.activeChapter)) {
      this.activeChapter = chapters[0] || null;
    }

    this.refs.chapterTabs.innerHTML = "";
    for (const key of chapters) {
      const meta = CHAPTER_META[key];
      const button = document.createElement("button");
      button.type = "button";
      button.className = `btn btn-default icon ${meta.icon}`;
      button.classList.toggle("selected", key === this.activeChapter);
      button.dataset.chapterTab = key;
      button.innerHTML = meta.label;
      this.refs.chapterTabs.appendChild(button);
    }
    // README and License are always present, so the tab bar is always shown.
    this.refs.chapterTabs.style.display = chapters.length ? "" : "none";

    this.applyChapterVisibility(elements);
  }

  chapterElements() {
    const elements = new Map();
    for (const child of this.refs.sections.children) {
      const key = child.dataset && child.dataset.chapter;
      if (key) elements.set(key, child);
    }
    return elements;
  }

  applyChapterVisibility(elements = this.chapterElements()) {
    for (const [key, element] of elements) {
      element.style.display = key === this.activeChapter ? "" : "none";
    }
  }

  setActiveChapter(key) {
    if (!key || key === this.activeChapter) return;
    this.activeChapter = key;
    for (const button of this.refs.chapterTabs.querySelectorAll("[data-chapter-tab]")) {
      button.classList.toggle("selected", button.dataset.chapterTab === key);
    }
    this.applyChapterVisibility();
    // Start each chapter from the top.
    this.element.scrollTop = 0;
    // The sidebar TOC is only shown on the README chapter.
    this.publishTableOfContents();
  }

  // Whether a chapter's section actually has something to show, so we don't offer
  // an empty tab (e.g. a package with no settings, keybindings, or grammars).
  chapterHasContent(key, element) {
    switch (key) {
      case "settings":
        return !!element.querySelector(".control-group");
      case "keymap":
      case "snippets":
        return !!element.querySelector("tbody tr");
      case "grammars":
        return !!element.querySelector(".settings-panel");
      default:
        return true; // readme, license
    }
  }

  update() {}

  beforeShow(opts) {
    if (opts.back == null) {
      opts.back = "Install";
    }

    this.breadcrumbBackPanel = opts.back;
    this.refs.breadcrumb.textContent = this.breadcrumbBackPanel;

    // Every time the detail view is shown it starts on the README, unless the
    // opener asked for a specific chapter (the card's Settings button opens
    // straight on "settings"). `rebuildChapters` falls back to the README if the
    // requested chapter isn't available.
    this.activeChapter = opts.initialChapter || "readme";
    this.rebuildChapters();
  }

  show() {
    this.element.style.display = "";
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

              <div className="package-detail-actions">
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
                  <button ref="openButton" className="btn btn-default icon icon-link-external">
                    View Code
                  </button>
                </div>

                <div ref="chapterTabs" className="btn-group package-chapter-tabs" />
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
    // This renders the installed version, so leave any preview mode and allow the
    // License to be re-read/re-fetched for the current version.
    this.previewMode = false;
    this.licenseRequested = false;

    if (this.settingsPanel) {
      this.settingsPanel.destroy();
      this.settingsPanel = null;
    }

    if (this.keymapView) {
      this.keymapView.destroy();
      this.keymapView = null;
    }

    if (this.grammarsView) {
      this.grammarsView.destroy();
      this.grammarsView = null;
    }

    if (this.snippetsView) {
      this.snippetsView.destroy();
      this.snippetsView = null;
    }

    if (this.readmeView) {
      this.readmeView.destroy();
      this.readmeView = null;
    }

    if (this.licenseView) {
      this.licenseView.destroy();
      this.licenseView = null;
    }

    this.updateFileButtons();
    this.activateConfig();
    this.refs.startupTime.style.display = "none";

    const loadedPackage = this.getMatchingLoadedPackage();
    if (loadedPackage) {
      if (!atom.packages.isPackageDisabled(this.pack.name)) {
        this.settingsPanel = new SettingsPanel({ namespace: this.pack.name, includeTitle: false });
        this.keymapView = new PackageKeymapView(this.pack);
        this.settingsPanel.element.dataset.chapter = "settings";
        this.keymapView.element.dataset.chapter = "keymap";
        this.refs.sections.appendChild(this.settingsPanel.element);
        this.refs.sections.appendChild(this.keymapView.element);

        if (this.pack.path) {
          this.grammarsView = new PackageGrammarsView(this.pack.path);
          this.snippetsView = new PackageSnippetsView(this.pack, this.snippetsProvider);
          this.grammarsView.element.dataset.chapter = "grammars";
          this.snippetsView.element.dataset.chapter = "snippets";
          this.refs.sections.appendChild(this.grammarsView.element);
          this.refs.sections.appendChild(this.snippetsView.element);
        }

        this.refs.startupTime.innerHTML = `This ${this.type} added <span class='highlight'>${this.getStartupTime()}ms</span> to startup time.`;
        this.refs.startupTime.style.display = "";
      }
    }

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

    // README first: it is the default chapter, so it must be present before the
    // License (which always renders) triggers the first chapter rebuild.
    this.renderReadme();
    this.renderLicense();
  }

  // Renders the LICENSE inline as its own chapter. For the installed version it
  // reads the local file (`updateFileButtons` sets `this.licensePath`); for a
  // browsed or previewed version it lazily fetches the LICENSE for the resolved
  // commit, the same way the README is fetched.
  renderLicense() {
    const meta = this.pack.metadata || {};
    let content = null;
    let isMarkdown = false;
    let licenseSrc = null;

    const localAvailable =
      !this.previewMode &&
      this.licensePath &&
      fs.existsSync(this.licensePath) &&
      fs.statSync(this.licensePath).isFile();

    // Note: `meta.license` is the package.json SPDX identifier (e.g. "MIT"), not
    // the license text — the full text lives in `meta.licenseText`, either read
    // from the local file or fetched for the resolved commit.
    if (localAvailable) {
      try {
        content = fs.readFileSync(this.licensePath, { encoding: "utf8" });
        isMarkdown = /\.(md|markdown)$/i.test(this.licensePath);
        licenseSrc = this.licensePath;
      } catch {
        content = null;
      }
    } else if (meta.licenseText != null) {
      content = meta.licenseText;
      isMarkdown = meta.licenseIsMarkdown === true;
      licenseSrc = meta.licenseSource || null;
    } else if (!this.licenseRequested && meta.originKey && meta.resolvedSha) {
      this.licenseRequested = true;
      this.packageManager
        .getCatalogClient()
        .loadLicense(meta)
        .then((entry) => {
          if (!entry) return;
          meta.licenseText = entry.body;
          meta.licenseSource = entry.source;
          meta.licenseIsMarkdown = entry.isMarkdown === true;
          this.renderLicense();
        })
        .catch(() => {});
    }

    // The License chapter is always shown (a placeholder when there is no file)
    // so the README/License tabs are always available.
    const licenseView = new PackageLicenseView(content, isMarkdown, licenseSrc);
    licenseView.element.dataset.chapter = "license";
    if (this.licenseView) {
      this.licenseView.element.parentElement.replaceChild(
        licenseView.element,
        this.licenseView.element,
      );
      this.licenseView.destroy();
    } else {
      this.refs.sections.appendChild(licenseView.element);
    }
    this.licenseView = licenseView;
    this.rebuildChapters();
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
    // While a different version is selected, only the README and License are
    // shown (both re-fetched for that version). Set the flag before rendering so
    // the License reads the previewed commit rather than the local file.
    this.previewMode = pack.previewVersion === true;
    if (shaChanged) {
      meta.readme = undefined;
      meta.readmeSource = undefined;
      this.readmeRequested = false;
      meta.licenseText = undefined;
      meta.licenseSource = undefined;
      meta.licenseIsMarkdown = undefined;
      this.licenseRequested = false;
      this.renderReadme();
      this.renderLicense();
    }
    this.rebuildChapters();
    this.publishTableOfContents();
  }

  setConfigSectionsVisible(visible) {
    // Previewing a non-installed version restricts the chapters to the README and
    // License (both re-fetched for that version); rebuild the tab bar to match.
    this.previewMode = !visible;
    this.rebuildChapters();
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
    readmeView.element.dataset.chapter = "readme";
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
    this.rebuildChapters();
    this.publishTableOfContents();
  }

  // Publishes the current README's headers to the sidebar TOC. Only while this
  // detail view is the visible panel, so an async README load for a panel the
  // user has navigated away from does not hijack the sidebar.
  publishTableOfContents() {
    if (!this.settingsView || typeof this.settingsView.showTableOfContents !== "function") return;
    if (this.element.style.display === "none") return;

    // The TOC belongs to the README chapter only; hide it on any other chapter.
    if (this.activeChapter !== "readme") {
      this.settingsView.clearTableOfContents();
      return;
    }

    const readme = this.readmeView && this.readmeView.packageReadme;
    const headings = readme ? readme.querySelectorAll("h1, h2, h3, h4, h5, h6") : [];
    const entries = [];
    for (const heading of headings) {
      const label = heading.textContent.trim();
      if (!label) continue;
      entries.push({
        label,
        level: Number(heading.tagName.slice(1)) || 1,
        onClick: () => {
          this.setActiveChapter("readme");
          heading.scrollIntoView();
        },
      });
    }
    this.settingsView.showTableOfContents(entries);
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
