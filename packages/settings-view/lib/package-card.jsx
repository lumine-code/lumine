/** @jsx etch.dom */
/** @jsxFrag etch.Fragment */
const { CompositeDisposable, Disposable } = require("atom");
const etch = require("@lumine-code/etch");
const BadgeView = require("./badge-view");
const fs = require("fs");
const path = require("path");
const semver = require("semver");

const {
  ownerFromRepository,
  repoUrlFromRepository,
  repoReferenceFromRepository,
  licenseLabelFromMetadata,
  packageOrigin,
  packagePanelKey,
  getInstalledPackageMetadata,
} = require("./utils");

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

function stripLeadingV(value) {
  return /^v\d/.test(value) ? value.slice(1) : value;
}

function updatePolicyForVersionSelector(selector) {
  return selector.type === "branch" || selector.type === "default" ? "branch" : "pinned";
}

module.exports = class PackageCard {
  constructor(pack, settingsView, packageManager, options = {}) {
    this.pack = pack;
    this.settingsView = settingsView;
    this.packageManager = packageManager;
    this.disposables = new CompositeDisposable();

    // It might be useful to either wrap this.pack in a class that has a
    // ::validate method, or add a method here. At the moment I think all cases
    // of malformed package metadata are handled here and in ::content but belt
    // and suspenders, you know
    this.avatarCache = this.packageManager.getAvatarCache();
    // A catalog record that failed hydration carries no manifest. When the
    // package is installed anyway, its local package.json knows everything the
    // card shows, so fill the gaps from it rather than presenting a bare card.
    this.adoptInstalledMetadata();
    this.type = this.pack.theme ? "theme" : "package";
    this.name = this.pack.name;
    this.onSettingsView = options.onSettingsView;
    this.onPackUpdated = options.onPackUpdated;
    // The shadow flag arrives on the pack for a list card, or via options for the
    // detail view's embedded card — whose metadata is the shared bundled object
    // and must not be mutated.
    this.isShadowed = !!(this.pack.isShadowed || options.isShadowed);

    if (this.pack.latestVersion !== this.pack.version) {
      this.newVersion = this.pack.latestVersion;
    }

    if (this.pack.apmInstallSource && this.pack.apmInstallSource.type === "git") {
      if (this.pack.apmInstallSource.sha !== this.pack.latestSha) {
        this.newSha = this.pack.latestSha;
      }
    }

    this.adoptInstalledState();

    etch.initialize(this);

    this.handlePackageEvents();
    this.handleButtonEvents(options);
    this.loadCachedMetadata();
    this.addBadges();

    this.hasCompatibleVersion = true;

    // The informational card for a bundled package currently overridden by a
    // community install: greyed out, with a single "Override" indicator and no
    // Update/Settings/Disable/Uninstall.
    if (this.isShadowed) {
      this.setupShadowedCard();
      return;
    }

    // themes have no status and cannot be dis/enabled
    if (this.type === "theme") {
      this.refs.statusIndicator.remove();
      this.refs.enablementButton.remove();
    }

    // Only strip the install/uninstall buttons for the genuine bundled instance.
    // A community package that overrides a bundled name is a real install and
    // keeps its Settings/Disable/Uninstall buttons.
    if (this.isBundledInstance()) {
      this.refs.installButtonGroup.remove();
      this.refs.uninstallButton.remove();
    }

    if (!this.newVersion && !this.newSha) {
      this.refs.updateButtonGroup.style.display = "none";
    }

    this.updateInterfaceState();
  }

  // True when this card represents the bundled instance itself (a normally
  // loaded bundled package or the shadow descriptor), as opposed to a community
  // package that overrides a bundled name — which is a real install and keeps
  // its buttons.
  isBundledInstance() {
    if (this.pack.packageKind === "builtin") return true;
    if (this.pack.apmInstallSource) return false;
    if (this.installedOriginDiffers()) return false;
    return atom.packages.isBundledPackage(this.pack.name);
  }

  // A directory whose package name is owned by another directory. It is on
  // disk but never loads, so its dot says which copy loads instead of it and
  // the card offers nothing that would act on that copy: settings, the enable
  // toggle, and updates all belong to the name, which this copy does not own.
  // Removing the directory is the one thing that only applies here, so a copy
  // the user can delete keeps its Uninstall button.
  setupShadowedCard() {
    this.element.classList.add("is-shadowed");
    this.refs.updateButtonGroup.remove();
    this.refs.installButtonGroup.remove();
    this.refs.statusIndicator.remove();
    this.refs.settingsButton.disabled = true;
    this.refs.enablementButton.disabled = true;
    if (!this.hasSettings()) this.refs.settingsButton.style.display = "none";

    // Bundled packages ship with the editor and cannot be removed.
    if (this.pack.tier === "bundled" || this.isBundledInstance()) {
      this.refs.uninstallButton.remove();
    }

    this.updateDirectoryLabel();
  }

  // Where the copy that owns this card's package name lives, phrased for a
  // sentence: "the dev package in my-checkout", "another directory (foo)".
  shadowedByDescription() {
    const winner = this.pack.shadowedBy;
    if (!winner) return "another copy of this package";
    const tierLabel = {
      dev: "the dev package",
      community: "the community package",
      bundled: "the bundled package",
    };
    const label = tierLabel[winner.tier] || "the copy";
    return winner.dirname ? `${label} in ${winner.dirname}` : label;
  }

  render() {
    // Before install, a Git card's `name` is the raw source (e.g.
    // "owner/repo@1.0.0"), so fall back to the repository's project name for a
    // clean label. Once installed we know the real package.json name, which can
    // differ from the repository name (repo "pulsar-invert-colors" ships package
    // "invert-colors"), so prefer it.
    const knowsRealName = this.pack.apmInstallSource != null || this.isInstalled();
    const displayName =
      (this.pack.gitUrlInfo && !knowsRealName ? this.pack.gitUrlInfo.project : this.pack.name) ||
      "";
    const repoReference = repoReferenceFromRepository(this.pack.repository);
    // The license is named here and only here; its text is one click away behind
    // the detail view's LICENSE button.
    const licenseLabel = licenseLabelFromMetadata(this.pack);
    const description = this.pack.description || "";
    const cardClasses = "package-card col-lg-8";

    return (
      <div className={cardClasses}>
        <div className="body">
          <h4 className="card-name">
            <a className="package-name" ref="packageName">
              {displayName}
            </a>
            <span className="package-version">
              {this.canSelectVersion() ? (
                <span className="package-version-control">
                  <select
                    ref="versionValue"
                    className="btn btn-xs value package-version-select"
                    value={this.selectedVersionValue()}
                    disabled={this.pack.status === "validating"}
                    onclick={(event) => event.stopPropagation()}
                    onmousedown={this.onVersionOpen.bind(this)}
                    onkeydown={this.onVersionKeyDown.bind(this)}
                    onchange={this.didChangeRef.bind(this)}
                  >
                    {this.versionOptions()}
                  </select>
                  <span
                    ref="versionSpinner"
                    className="package-version-spinner hidden"
                    title="Loading versions…"
                  />
                </span>
              ) : (
                <span ref="versionValue" className="value">
                  {this.pack.version == null ? "" : String(this.pack.version)}
                </span>
              )}
            </span>
            {licenseLabel ? (
              <span className="package-license" title="License">
                {licenseLabel}
              </span>
            ) : null}
            <span ref="badges" className="package-badges"></span>
          </h4>
          <span ref="packageDescription" className="package-description">
            {description}
          </span>
          <span
            ref="originRenameWarning"
            className="package-catalog-status status-stale"
            style={{ display: "none" }}
          />
          <div ref="packageMessage" className="package-message" />
        </div>

        <div className="meta">
          <div ref="metaUserContainer" className="meta-user">
            <a ref="avatarLink">
              {/* A transparent gif so there is no "broken border" */}
              <img
                ref="avatar"
                className="avatar"
                src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
              />
            </a>
            {repoReference ? (
              <a ref="repoLink" className="package-repo">
                {repoReference}
              </a>
            ) : null}
            {/* Where this copy lives, when that is not the package's own name.
                It sits with the repository because both answer "where is this
                from", and outside the link because a directory is not part of
                the repository's address. */}
            <span
              ref="packageDirectory"
              className="package-directory icon icon-file-directory"
              style={{ display: "none" }}
            />
          </div>
          <div className="meta-controls">
            <div className="btn-toolbar">
              <div ref="updateButtonGroup" className="btn-group">
                <button
                  type="button"
                  className="btn btn-info icon icon-cloud-download install-button"
                  ref="updateButton"
                >
                  Update
                </button>
              </div>
              <div ref="installButtonGroup" className="btn-group">
                <button
                  type="button"
                  className="btn btn-info icon icon-cloud-download install-button"
                  ref="installButton"
                >
                  Install
                </button>
                <button
                  type="button"
                  className="btn btn-warning icon icon-sync replace-button"
                  ref="replaceButton"
                  style={{ display: "none" }}
                >
                  Replace
                </button>
              </div>
              <div ref="packageActionButtonGroup" className="btn-group">
                <button type="button" className="btn icon icon-gear settings" ref="settingsButton">
                  Settings
                </button>
                <button
                  type="button"
                  className="btn icon icon-trashcan uninstall-button"
                  ref="uninstallButton"
                >
                  Uninstall
                </button>
                <button
                  type="button"
                  className="btn icon icon-playback-pause enablement"
                  ref="enablementButton"
                >
                  <span className="disable-text">Disable</span>
                </button>
                <button
                  type="button"
                  className="btn status-indicator"
                  tabIndex="-1"
                  ref="statusIndicator"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // A version selector is shown for anything with a Git origin: catalog cards
  // (which already carry refs) and installed Git packages (which lazily list
  // their tags on demand). Bundled/local packages keep a plain version label.
  canSelectVersion() {
    if (this.isShadowed) return false;
    if (this.pack.refs) return true;
    return !!(this.pack.apmInstallSource && this.pack.apmInstallSource.type === "git");
  }

  // The ref the version selector currently reflects: an explicitly selected ref,
  // otherwise the installed receipt's ref.
  currentSelector() {
    if (this.pack.selectedRef) return this.pack.selectedRef;
    const install = this.pack.apmInstallSource;
    if (install && install.selector) return install.selector;
    // A legacy Git install with no recorded selector is shown as its commit.
    if (install && install.type === "git" && install.sha) {
      return { type: "commit", value: install.sha };
    }
    return null;
  }

  selectedVersionValue() {
    const selector = this.currentSelector();
    if (!selector) return "";
    if (selector.type === "tag" || selector.type === "latest") return `tag:${selector.value}`;
    if (selector.type === "branch" || selector.type === "default")
      return `branch:${selector.value}`;
    if (selector.type === "commit") return `commit:${selector.value}`;
    return "";
  }

  // The list-item label for a selector, using the same notation as an install
  // source: @tag, ~branch, #commit. A branch that is installed also shows its
  // pinned commit as "#<sha>~branch", since a new commit may arrive on it.
  labelForSelector(selector) {
    if (!selector) return this.pack.version == null ? "" : String(this.pack.version);
    if (selector.type === "tag" || selector.type === "latest") return `@${selector.value}`;
    if (selector.type === "commit") return `#${String(selector.value || "").substr(0, 8)}`;
    if (selector.type === "branch" || selector.type === "default") {
      const install = this.pack.apmInstallSource;
      const installed = install && install.selector;
      const tracksThisBranch =
        installed &&
        (installed.type === "branch" || installed.type === "default") &&
        installed.value === selector.value;
      if (tracksThisBranch && install.sha) {
        return `#${install.sha.substr(0, 8)}~${selector.value}`;
      }
      return `~${selector.value}`;
    }
    return String(selector.value || "");
  }

  selectedVersionLabel() {
    return this.labelForSelector(this.currentSelector());
  }

  // Every catalog a package is available from, including the Pulsar registry
  // when it also surfaced the same repository.
  catalogSourcesText() {
    const label = (source) => (source === "pulsar" ? "Pulsar registry" : source);
    const selectors = this.pack.catalogSelectors || [];
    if (selectors.length) {
      return selectors
        .map(({ catalogSource, selector }) => {
          const ref =
            !selector || selector.type === "latest"
              ? "latest/default"
              : `${selector.type}:${selector.value}`;
          return `${label(catalogSource)} (${ref})`;
        })
        .join(" · ");
    }
    return (this.pack.catalogSources || []).map(label).join(" · ");
  }

  // The catalog details shown on hover over the repository reference: origin,
  // resolved commit, selected ref, catalog provenance, and validation status.
  // Field labels are bold; the content is left-aligned via the tooltip class.
  catalogTooltipLines() {
    const install = this.pack.apmInstallSource || {};
    const lines = [];
    const field = (fieldLabel, value) => {
      if (value == null || value === "") return;
      lines.push(`<strong>${escapeHtml(fieldLabel)}</strong> ${escapeHtml(String(value))}`);
    };
    field("Origin:", this.pack.originKey || install.origin);
    const sha = this.pack.resolvedSha || install.sha;
    if (sha) field("Commit:", sha.slice(0, 8));
    const selector = this.currentSelector();
    if (selector && selector.value) field("Ref:", `${selector.type} ${selector.value}`);
    field("Catalogs:", this.catalogSourcesText());
    if (this.pack.selectorConflict) {
      lines.push(escapeHtml("Selector conflict; the first catalog wins."));
    }
    if (this.pack.status && this.pack.status !== "ready") field("Status:", this.pack.status);
    if (this.pack.error) lines.push(escapeHtml(this.pack.error));
    return lines;
  }

  catalogTooltipEntries() {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      title: () => this.catalogTooltipLines()[index],
    }));
    entries[0].html = true;
    entries[0].class = "package-catalog-tooltip";
    return entries;
  }

  versionOptionEntries() {
    const refs = this.pack.refs || {};
    const entries = [];
    for (const tag of refs.tags || []) {
      entries.push([`tag:${tag.name}`, this.labelForSelector({ type: "tag", value: tag.name })]);
    }
    if (refs.defaultBranch) {
      entries.push([
        `branch:${refs.defaultBranch}`,
        this.labelForSelector({ type: "branch", value: refs.defaultBranch }),
      ]);
    }
    const current = this.selectedVersionValue();
    if (current && !entries.some(([value]) => value === current)) {
      entries.unshift([current, this.selectedVersionLabel()]);
    }
    if (!entries.length) {
      const label = this.pack.version == null ? "—" : String(this.pack.version);
      entries.push([current || "version:current", label]);
    }
    return entries;
  }

  versionOptions() {
    return this.versionOptionEntries().map(([value, label]) => (
      <option value={value}>{label}</option>
    ));
  }

  // Installed cards start without a ref list. Rather than open the native
  // dropdown onto the current-only list and mutate it underneath the user, block
  // the open, show a spinner while the origin's tags and default branch are
  // listed via ls-remote, then open the completed list.
  async onVersionOpen(event) {
    if (this.pack.refs) return; // refs already loaded → let it open natively
    if (event) event.preventDefault(); // don't open the stale (current-only) list
    await this.loadVersionRefs();
    const select = this.refs.versionValue;
    if (!select || select.tagName !== "SELECT") return;
    select.focus();
    try {
      // Open the now-complete list if the user gesture is still valid.
      select.showPicker();
    } catch {
      // The gesture expired during a slow fetch; the list is ready and the next
      // click opens it.
    }
  }

  onVersionKeyDown(event) {
    if (this.pack.refs) return;
    const opensList =
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === " " ||
      event.key === "Spacebar";
    if (opensList) this.onVersionOpen(event);
  }

  // Lists the origin's tags and default branch and rebuilds the <option>s in
  // place — a full re-render would undo the card's imperative button/state
  // adjustments. Deduped so concurrent opens share one fetch.
  loadVersionRefs() {
    if (this.pack.refs) return Promise.resolve();
    if (this.refsLoadingPromise) return this.refsLoadingPromise;
    this.setVersionLoading(true);
    this.refsLoadingPromise = (async () => {
      try {
        this.pack = await this.packageManager.getCatalogClient().loadRefs(this.pack);
        this.refreshVersionOptions();
      } catch {
        // Leave the version as-is if the refs cannot be listed.
      } finally {
        this.setVersionLoading(false);
        this.refsLoadingPromise = null;
      }
    })();
    return this.refsLoadingPromise;
  }

  setVersionLoading(loading) {
    const spinner = this.refs.versionSpinner;
    if (spinner) spinner.classList.toggle("hidden", !loading);
  }

  refreshVersionOptions() {
    const select = this.refs.versionValue;
    if (!select || select.tagName !== "SELECT") return;
    select.innerHTML = "";
    for (const [value, label] of this.versionOptionEntries()) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = this.selectedVersionValue();
  }

  async didChangeRef(event) {
    event.stopPropagation();
    const raw = event.target.value;
    const separator = raw.indexOf(":");
    if (separator === -1) return;
    const type = raw.slice(0, separator);
    const value = raw.slice(separator + 1);
    if (type !== "tag" && type !== "branch" && type !== "commit") return;
    const selector = { type, value };
    if (this.isInstalled() && !this.installedOriginDiffers()) {
      this.applyInstalledVersionSelection(selector);
    } else {
      await this.selectRef(selector);
    }
  }

  // On an installed card, choosing a ref other than the installed one turns the
  // primary action into "Update to X" targeting that exact commit. Choosing the
  // installed ref again clears the pending update.
  applyInstalledVersionSelection(selector) {
    const refs = this.pack.refs || {};
    let sha = null;
    if (selector.type === "tag") {
      const tag = (refs.tags || []).find((entry) => entry.name === selector.value);
      sha = tag ? tag.sha : null;
    } else if (selector.type === "branch") {
      sha = refs.defaultBranch === selector.value ? refs.headSha : null;
    } else if (selector.type === "commit") {
      sha = selector.value;
    }
    const install = this.pack.apmInstallSource || {};
    const installedSha = install.sha;
    if (this.installedDescription === undefined) {
      this.installedDescription = this.pack.description || "";
    }
    this.pack.selectedRef = selector;
    if (sha && installedSha && sha.toLowerCase() === installedSha.toLowerCase()) {
      this.newVersion = null;
      this.newSha = null;
      this.pack.latestSha = installedSha;
      this.pack.resolvedRef = null;
      this.pack.updatePolicy = undefined;
      // Back on the installed version: cancel any pending preview and restore.
      this.pack.previewVersion = false;
      this.manifestPreviewId = (this.manifestPreviewId || 0) + 1;
      this.setDescription(this.installedDescription);
    } else {
      this.pack.latestSha = sha;
      this.pack.resolvedRef = selector;
      this.pack.updatePolicy = updatePolicyForVersionSelector(selector);
      this.pack.previewVersion = true;
      if (selector.type === "tag") {
        this.newVersion = stripLeadingV(selector.value);
        this.newSha = null;
      } else {
        this.newSha = sha || null;
        this.newVersion = null;
      }
      this.previewSelectedManifest(sha, selector);
    }
    if (this.onPackUpdated) this.onPackUpdated(this.pack);
    this.updateInterfaceState();
  }

  setDescription(text) {
    this.pack.description = text;
    if (this.refs.packageDescription) this.refs.packageDescription.textContent = text || "";
  }

  // Fetch the selected commit's manifest so the description reflects the chosen
  // version rather than the installed one. Best-effort: a network or validation
  // failure leaves the current description in place, and a newer selection
  // supersedes an in-flight fetch.
  async previewSelectedManifest(sha, selector) {
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return;
    const requestId = (this.manifestPreviewId = (this.manifestPreviewId || 0) + 1);
    try {
      const metadata = await this.packageManager.inspectPackageUpdate(this.pack, sha, selector);
      if (this.destroyed || requestId !== this.manifestPreviewId || !metadata) return;
      if (metadata.description != null) this.setDescription(metadata.description);
    } catch {
      // Keep the current description if the selected manifest can't be read.
    }
  }

  async selectRef(selector) {
    this.pack = { ...this.pack, status: "validating", error: null };
    await etch.update(this);
    try {
      this.pack = await this.packageManager.getCatalogClient().selectRef(this.pack, selector);
    } catch (error) {
      this.pack = { ...this.pack, status: "error", error: error.message };
    }
    this.name = this.pack.name;
    if (this.onPackUpdated) this.onPackUpdated(this.pack);
    await etch.update(this);
    this.updateInterfaceState();
  }

  locateCompatiblePackageVersion(callback) {
    this.packageManager.loadCompatiblePackageVersion(this.pack.name, (err, pack) => {
      if (err != null) {
        console.error(err);
      }

      const packageVersion = pack.version;

      // A compatible version exist, we activate the install button and
      // set this.installablePack so that the install action installs the
      // compatible version of the package.
      if (packageVersion) {
        if (this.refs.versionValue.tagName !== "SELECT") {
          this.refs.versionValue.textContent = packageVersion;
        }
        if (packageVersion !== this.pack.version) {
          this.refs.versionValue.classList.add("text-warning");
          this.compatibleVersionNote = `Version ${packageVersion} is the latest that is compatible with your Lumine version, not the newest available.`;
        } else {
          this.compatibleVersionNote = null;
        }

        this.installablePack = pack;
        this.hasCompatibleVersion = true;
      } else {
        this.hasCompatibleVersion = false;
        this.compatibleVersionNote = null;
        this.refs.versionValue.classList.add("text-error");
        console.error(
          `No available version compatible with the installed Lumine version: ${atom.getVersion()}`,
        );
      }

      callback();
    });
  }

  handleButtonEvents(options) {
    if (options && options.onSettingsView) {
      this.refs.settingsButton.style.display = "none";
    } else {
      const openDetail = (initialSection) => {
        // The installed package merely shares its name — don't link to it.
        if (this.originConflict) return;
        this.settingsView.showPanel(packagePanelKey(this.pack), {
          back: options ? options.back : null,
          pack: this.pack,
          initialSection,
        });
      };

      // Clicking the card opens the detail view at the top; the Settings button
      // opens it scrolled to the Settings section.
      const cardClickHandler = (event) => {
        event.stopPropagation();
        openDetail();
      };
      this.element.addEventListener("click", cardClickHandler);
      this.disposables.add(
        new Disposable(() => {
          this.element.removeEventListener("click", cardClickHandler);
        }),
      );

      const settingsClickHandler = (event) => {
        event.stopPropagation();
        openDetail("settings");
      };
      this.refs.settingsButton.addEventListener("click", settingsClickHandler);
      this.disposables.add(
        new Disposable(() => {
          this.refs.settingsButton.removeEventListener("click", settingsClickHandler);
        }),
      );
    }

    const installButtonClickHandler = (event) => {
      event.stopPropagation();
      this.install();
    };
    this.refs.installButton.addEventListener("click", installButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.installButton.removeEventListener("click", installButtonClickHandler);
      }),
    );

    const replaceButtonClickHandler = (event) => {
      event.stopPropagation();
      this.replace();
    };
    this.refs.replaceButton.addEventListener("click", replaceButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.replaceButton.removeEventListener("click", replaceButtonClickHandler);
      }),
    );

    const uninstallButtonClickHandler = (event) => {
      event.stopPropagation();
      this.uninstall();
    };
    this.refs.uninstallButton.addEventListener("click", uninstallButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.uninstallButton.removeEventListener("click", uninstallButtonClickHandler);
      }),
    );

    const updateButtonClickHandler = (event) => {
      event.stopPropagation();

      // Capture the version labels before updating: the "updated" event clears
      // newVersion/newSha, and a tag-tracked git update has no latestSha, so
      // branch on which kind of update this is rather than assuming a sha.
      let oldVersion = "";
      let newVersion = "";
      if (this.newSha) {
        const installedSha = this.pack.apmInstallSource && this.pack.apmInstallSource.sha;
        oldVersion = installedSha ? installedSha.substr(0, 8) : "";
        newVersion = this.newSha.substr(0, 8);
      } else if (this.newVersion) {
        oldVersion =
          (this.pack.apmInstallSource && this.pack.apmInstallSource.version) ||
          this.pack.version ||
          "";
        newVersion = this.newVersion;
      }
      const detail = oldVersion && newVersion ? `${oldVersion} -> ${newVersion}` : "";

      this.update().then(() => {
        const notification = atom.notifications.addSuccess(
          `Restart Lumine to complete the update of \`${this.pack.name}\`.`,
          {
            dismissable: true,
            buttons: [
              {
                text: "Restart now",
                onDidClick() {
                  return atom.restartApplication();
                },
              },
              {
                text: "I'll do it later",
                onDidClick() {
                  notification.dismiss();
                },
              },
            ],
            detail,
          },
        );
      });
    };
    this.refs.updateButton.addEventListener("click", updateButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.updateButton.removeEventListener("click", updateButtonClickHandler);
      }),
    );

    const packageNameClickHandler = (event) => {
      event.stopPropagation();
      const repoUrl = repoUrlFromRepository(this.pack.repository);
      if (repoUrl) {
        atom.openExternal(repoUrl);
      }
    };
    if (this.refs.repoLink) {
      this.refs.repoLink.addEventListener("click", packageNameClickHandler);
      this.disposables.add(
        new Disposable(() => {
          this.refs.repoLink.removeEventListener("click", packageNameClickHandler);
        }),
      );
      // Catalog provenance, origin, resolved commit, and validation status live
      // in a hover tooltip rather than cluttering the card. A function title
      // keeps it current as the selected ref changes.
      this.disposables.add(
        atom.tooltips.addComposite(this.refs.repoLink, this.catalogTooltipEntries()),
      );
    }
    this.refs.packageName.addEventListener("click", packageNameClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.packageName.removeEventListener("click", packageNameClickHandler);
      }),
    );

    const packageAuthorClickHandler = (event) => {
      event.stopPropagation();
      const owner = ownerFromRepository(this.pack.repository);
      if (owner) {
        atom.openExternal(`https://github.com/${owner}`);
      }
    };
    this.refs.avatarLink.addEventListener("click", packageAuthorClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.avatarLink.removeEventListener("click", packageAuthorClickHandler);
      }),
    );

    const enablementButtonClickHandler = (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (this.isDisabled()) {
        atom.packages.enablePackage(this.pack.name);
      } else {
        atom.packages.disablePackage(this.pack.name);
      }
    };
    this.refs.enablementButton.addEventListener("click", enablementButtonClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.enablementButton.removeEventListener("click", enablementButtonClickHandler);
      }),
    );

    const packageMessageClickHandler = (event) => {
      const target = event.target.closest("a");
      if (target) {
        event.stopPropagation();
        event.preventDefault();
        if (target.href && target.href.startsWith("lumine:")) {
          atom.workspace.open(target.href);
        }
      }
    };
    this.refs.packageMessage.addEventListener("click", packageMessageClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.packageMessage.removeEventListener("click", packageMessageClickHandler);
      }),
    );
  }

  destroy() {
    this.destroyed = true;
    if (this.installNoteTooltip) {
      this.installNoteTooltip.dispose();
      this.installNoteTooltip = null;
    }
    if (this.badgeViews) {
      for (const badgeView of this.badgeViews) badgeView.destroy();
      this.badgeViews = [];
    }
    this.disposables.dispose();
    return etch.destroy(this);
  }

  loadCachedMetadata() {
    if (repoUrlFromRepository(this.pack.repository) === atom.branding.urlCoreRepo) {
      // Don't hit the web for our bundled packages. Just use the local image.
      let avatarPath = path.join(process.resourcesPath, "lumine.png");
      if (!fs.existsSync(avatarPath)) {
        avatarPath = path.join(
          atom.getLoadSettings().resourcePath,
          "resources",
          "app-icons",
          "lumine.png",
        );
      }
      this.refs.avatar.src = `file://${avatarPath}`;
    } else {
      // The avatar is fetched from the author's GitHub avatar URL by owner
      // login, never the package registry, so it is safe for catalog cards too.
      const owner = ownerFromRepository(this.pack.repository);
      if (!owner) return;
      this.avatarCache.avatar(owner, (err, avatarPath) => {
        if (!err && avatarPath) {
          this.refs.avatar.src = `file://${avatarPath}`;
        }
      });
    }
  }

  updateInterfaceState() {
    // The shadow card is static; nothing to reconcile.
    if (this.isShadowed) return;
    this.applyVersionDisplay();

    this.updateSettingsState();
    this.updateInstalledState();
    this.updateDisabledState();
    this.updateDirectoryLabel();
  }

  // Keeps the version indicator current whether it is a plain label or the
  // tags/branch <select>.
  applyVersionDisplay() {
    const el = this.refs.versionValue;
    if (!el) return;
    if (el.tagName === "SELECT") {
      el.value = this.selectedVersionValue();
    } else {
      el.textContent =
        (this.installablePack ? this.installablePack.version : null) || this.pack.version || "";
    }
  }

  // Names the directory this copy lives in, beside the repository it came from,
  // when the directory is called something other than the package. A directory
  // name carries no meaning of its own — the package.json "name" is the
  // identity — so it is shown, not warned about.
  updateDirectoryLabel() {
    const label = this.refs.packageDirectory;
    if (!label) return;

    const directoryName = this.pack.directoryName;
    if (directoryName && this.pack.name && directoryName !== this.pack.name) {
      label.textContent = directoryName;
      label.style.display = "";
    } else {
      label.textContent = "";
      label.style.display = "none";
    }
  }

  updateSettingsState() {
    if (this.hasSettings() && !this.onSettingsView) {
      this.refs.settingsButton.style.display = "";
    } else {
      this.refs.settingsButton.style.display = "none";
    }
  }

  addBadges() {
    this.badgeViews = [];
    const badges = this.statusBadges();
    if (Array.isArray(this.pack.badges)) {
      // This safety check is especially needed, as any cached package
      // data will not contain the badges field
      badges.push(...this.pack.badges);
    }
    for (const badge of badges) {
      const badgeView = new BadgeView(badge);
      this.badgeViews.push(badgeView);
      this.refs.badges.appendChild(badgeView.element);
    }
  }

  // The card's own status dots, shown ahead of any registry badges. States can
  // coexist (e.g. a stale record from the Pulsar registry, installed as a
  // symlink), so each state has its own colour rather than sharing a severity
  // with the others: the colour is what a dot is recognised by, and it means
  // the same thing on every card, in every theme. Each dot carries its details
  // in a hover tooltip.
  statusBadges() {
    const badges = [];
    if (this.pack.status === "error") {
      badges.push({
        type: "error",
        title: "Problem",
        text: this.pack.error || "This package could not be loaded from its catalog.",
      });
    } else if (this.pack.status === "stale") {
      badges.push({
        type: "stale",
        title: "Stale",
        text: this.pack.error || "The newest catalog fetch failed; showing the last good data.",
      });
    } else if (this.pack.status === "validating") {
      badges.push({
        type: "validating",
        title: "Validating",
        text: "The package's manifest is being fetched and validated.",
      });
    }
    if (this.isShadowed) {
      badges.push({
        type: "shadowed",
        title: "Shadowed",
        text: `“${this.pack.name}” is provided by ${this.shadowedByDescription()}, which loads instead of this copy.`,
      });
    }
    if (this.pack.originWarning) {
      badges.push({ type: "origin", title: "Origin", text: this.pack.originWarning });
    }
    if (this.pack.selectorConflict) {
      badges.push({
        type: "selector",
        title: "Selector conflict",
        text: "The catalogs disagree about which version to track; the first one wins.",
      });
    }
    if (this.isPulsarSourced()) {
      badges.push({
        type: "pulsar",
        title: "Pulsar registry",
        text: "Listed by the Pulsar package registry.",
      });
    }
    const sourceCheckoutBadge = this.sourceCheckoutBadge();
    if (sourceCheckoutBadge) badges.push(sourceCheckoutBadge);
    const symlinkBadge = this.symlinkBadge();
    if (symlinkBadge) badges.push(symlinkBadge);
    return badges;
  }

  // A dot for a bundled package the editor is running out of its own source
  // checkout rather than out of a build. The package ships with Lumine, but the
  // files being loaded are the ones on disk in the repository, so editing them
  // changes what runs.
  sourceCheckoutBadge() {
    if (this.pack.tier !== "bundled" || this.pack.isBundled !== false) return null;
    return {
      type: "source",
      title: "From the source checkout",
      text: this.pack.path || "Loaded from the repository, not from a build.",
    };
  }

  // A Pulsar-registry result carries `source: "pulsar"` directly from the
  // search client, or "pulsar" among its catalog sources once it has been
  // hydrated into a catalog-shaped record.
  isPulsarSourced() {
    if (this.pack.source === "pulsar") return true;
    return (this.pack.catalogSources || []).includes("pulsar");
  }

  // A dot for a package whose install directory is a symbolic link — a
  // development install pointing at a working copy elsewhere. The tooltip
  // names the link's target.
  symlinkBadge() {
    const linkPath = this.installedPackagePath();
    if (!linkPath) return null;
    try {
      if (!fs.lstatSync(linkPath).isSymbolicLink()) return null;
      return { type: "symlink", title: "Installed as symlink", text: fs.realpathSync(linkPath) };
    } catch {
      return null;
    }
  }

  // The directory the installed package occupies — the symlink itself for
  // linked installs — whether or not this card was built from the installed
  // metadata.
  installedPackagePath() {
    if (this.pack.path) return this.pack.path;
    if (!this.isInstalled() || this.installedOriginDiffers()) return null;
    return this.packageManager.installedPackagePath(this.pack);
  }

  // Section: disabled state updates

  updateDisabledState() {
    if (this.isDisabled()) {
      this.displayDisabledState();
    } else if (this.element.classList.contains("disabled")) {
      this.displayEnabledState();
    }
  }

  displayEnabledState() {
    this.element.classList.remove("disabled");
    if (this.type === "theme") {
      this.refs.enablementButton.style.display = "none";
    }
    this.refs.enablementButton.querySelector(".disable-text").textContent = "Disable";
    this.refs.enablementButton.classList.add("icon-playback-pause");
    this.refs.enablementButton.classList.remove("icon-playback-play");
    this.refs.statusIndicator.classList.remove("is-disabled");
  }

  displayDisabledState() {
    this.element.classList.add("disabled");
    this.refs.enablementButton.querySelector(".disable-text").textContent = "Enable";
    this.refs.enablementButton.classList.add("icon-playback-play");
    this.refs.enablementButton.classList.remove("icon-playback-pause");
    this.refs.statusIndicator.classList.add("is-disabled");
    this.refs.enablementButton.disabled = false;
  }

  // Section: installed state updates

  updateInstalledState() {
    if (this.isInstalled()) {
      if (this.installedOriginDiffers()) {
        this.displayConflictingOriginState();
        return;
      }
      this.clearConflictingOriginState();
      this.displayInstalledState();
    } else {
      this.clearConflictingOriginState();
      this.displayNotInstalledState();
    }
  }

  // Annotates the Install button with a hover note explaining a caveat. When
  // `blocking` is true the button is also shown disabled (install is not
  // possible); otherwise it stays usable and the note is purely informational.
  setInstallNote(message, blocking) {
    this.installBlocked = !!blocking;
    this.refs.installButton.classList.toggle("disabled", !!blocking);
    if (this.installNote !== message) {
      if (this.installNoteTooltip) {
        this.installNoteTooltip.dispose();
        this.installNoteTooltip = null;
      }
      if (message) {
        this.installNoteTooltip = atom.tooltips.add(this.refs.installButtonGroup, {
          title: message,
        });
      }
      this.installNote = message;
    }
  }

  clearInstallNote() {
    this.installBlocked = false;
    this.installNote = null;
    this.refs.installButton.classList.remove("disabled");
    if (this.installNoteTooltip) {
      this.installNoteTooltip.dispose();
      this.installNoteTooltip = null;
    }
  }

  incompatibleMessage() {
    const engine = this.pack.engines && this.pack.engines.lumine;
    if (!engine) {
      return "This package declares no engines.lumine range, so it predates the engines rename and needs republishing before it can be installed.";
    }
    return `No version of this package is compatible with your Lumine version. It requires ${engine}.`;
  }

  validationBlockingMessage() {
    if (!this.pack.originKey || !this.pack.status || this.pack.status === "ready") return null;
    return this.pack.error || "Package metadata is still being validated.";
  }

  // The installed package merely shares its name with this card's package.
  // Keep Install visible but disabled — installing would overwrite the
  // unrelated package — and explain why on hover. Uninstall/settings stay
  // hidden so they can't act on the unrelated package.
  displayConflictingOriginState() {
    this.clearOriginRenameWarning();
    this.originConflict = true;
    this.refs.updateButtonGroup.style.display = "none";
    this.refs.packageActionButtonGroup.style.display = "none";
    this.refs.installButtonGroup.style.display = "";

    const validationError = this.validationBlockingMessage();
    if (validationError) {
      this.refs.installButton.style.display = "";
      this.refs.replaceButton.style.display = "none";
      this.setInstallNote(validationError, true);
      return;
    }

    if (atom.packages.isBundledPackage(this.pack.name)) {
      // The name belongs to a bundled package, which cannot be uninstalled — so
      // Replace is impossible. Keep a disabled Install with the reason.
      this.refs.installButton.style.display = "none";
      this.refs.replaceButton.style.display = "";
      this.refs.replaceButton.textContent = "Replace";
      this.setInstallNote(
        `Installing this package will shadow the bundled “${this.pack.name}” package.`,
        false,
      );
      return;
    }

    // A plain Install would overwrite the unrelated package, so offer only
    // Replace; the reason is on hover.
    this.refs.installButton.style.display = "none";
    this.refs.replaceButton.style.display = "";
    this.refs.replaceButton.textContent = "Replace";
    this.setInstallNote(
      `A different package named “${this.pack.name}” is already installed. Replace uninstalls it and installs this one.`,
      true,
    );
  }

  clearConflictingOriginState() {
    if (!this.originConflict) return;
    this.originConflict = false;
    this.clearInstallNote();
  }

  // Fills the manifest fields a failed hydration left missing — version,
  // description, license — from the locally installed package's metadata.
  // Fields the record does carry stay untouched.
  adoptInstalledMetadata() {
    if (this.pack.version || !this.isInstalled() || this.installedOriginDiffers()) return;
    const metadata = this.getInstalledMetadata();
    if (!metadata) return;
    for (const key of ["version", "description", "license", "licenses", "theme"]) {
      if (this.pack[key] == null && metadata[key] != null) {
        this.pack[key] = metadata[key];
      }
    }
  }

  // When the card's package is already installed from the same origin, adopt
  // the installed package's install source and offer an update if this card
  // describes a newer version.
  adoptInstalledState() {
    if (!this.pack.version || !this.pack.repository || !this.isInstalled()) return;
    const metadata = this.getInstalledMetadata();
    if (!metadata || this.installedOriginDiffers()) return;
    if (metadata.apmInstallSource && !this.pack.apmInstallSource) {
      this.pack.apmInstallSource = metadata.apmInstallSource;
    }
    // Reflect the INSTALLED ref in the version selector rather than the catalog's
    // default. Otherwise a package installed from a branch or a non-latest tag
    // shows the catalog's latest tag as if that were installed.
    const install = this.pack.apmInstallSource;
    const installedSelector = install && install.selector;
    if (installedSelector) {
      this.pack.selectedRef = installedSelector;
      this.pack.previewVersion = false;
    }
    // A branch/commit update recorded on the (cached) catalog entry — its
    // latestSha differs from the installed commit — is offered on the browse
    // card too, so an advanced master branch shows "Update" without opening the
    // Updates tab. The receipt is adopted above, after the constructor's own
    // newSha check, so it is repeated here.
    if (
      install &&
      install.type === "git" &&
      this.pack.latestSha &&
      install.sha !== this.pack.latestSha
    ) {
      this.newSha = this.pack.latestSha;
    }
    if (
      semver.valid(metadata.version) &&
      semver.valid(this.pack.version) &&
      semver.gt(this.pack.version, metadata.version)
    ) {
      this.newVersion = this.pack.version;
    }
  }

  getInstalledMetadata() {
    return getInstalledPackageMetadata(this.pack.name);
  }

  // True when this card's package shares its NAME with an installed package but
  // comes from a different ORIGIN (source path) — i.e. installing this one would
  // collide with an unrelated same-named package that is already installed.
  installedOriginDiffers() {
    // A pack with a local install path was read from the install slot itself,
    // so this card IS the installed package — never a same-name collision.
    if (this.pack.path) return false;
    const cardOrigin = packageOrigin(this.pack);
    if (!cardOrigin) return false;
    const installedOrigin = packageOrigin(this.getInstalledMetadata());
    return !!installedOrigin && installedOrigin !== cardOrigin;
  }

  displayInstalledState() {
    this.clearOriginRenameWarning();
    this.clearInstallNote();
    if (this.newVersion || this.newSha) {
      this.refs.updateButtonGroup.style.display = "";
      if (this.newVersion) {
        this.refs.updateButton.textContent = `Update to ${this.newVersion}`;
      } else if (this.newSha) {
        this.refs.updateButton.textContent = `Update to ${this.newSha.substr(0, 8)}`;
      }
    } else {
      this.refs.updateButtonGroup.style.display = "none";
    }

    this.refs.installButtonGroup.style.display = "none";
    this.refs.packageActionButtonGroup.style.display = "";
    this.refs.uninstallButton.style.display = "";
  }

  displayNotInstalledState() {
    this.refs.uninstallButton.style.display = "none";
    const atomVersion = this.packageManager.normalizeVersion(atom.getVersion());
    if (!this.packageManager.satisfiesVersion(atomVersion, this.pack)) {
      // Incompatible engine: keep the card in the list with a disabled Install.
      // A catalog card can switch to another ref (whose engine may match), so it
      // does not hunt the legacy registry for an older compatible version.
      this.hasCompatibleVersion = false;
      this.setNotInstalledStateButtons();
      if (!this.pack.originKey) {
        this.locateCompatiblePackageVersion(() => {
          this.setNotInstalledStateButtons();
        });
      }
    } else {
      this.setNotInstalledStateButtons();
    }
  }

  setNotInstalledStateButtons() {
    // Replace only applies in the conflict state; a plain not-installed card
    // shows a normal Install and no Replace.
    this.refs.replaceButton.style.display = "none";
    this.refs.installButton.style.display = "";
    const validationError = this.validationBlockingMessage();
    const renamedInstall = validationError ? null : this.installedSameOriginInOtherSlot();
    this.updateOriginRenameWarning(renamedInstall);
    if (validationError) {
      this.setInstallNote(validationError, true);
      this.refs.installButtonGroup.style.display = "";
      this.refs.updateButtonGroup.style.display = "none";
    } else if (renamedInstall) {
      this.setInstallNote(this.originRenameMessage(renamedInstall), true);
      this.refs.installButtonGroup.style.display = "";
      this.refs.updateButtonGroup.style.display = "none";
    } else if (!this.hasCompatibleVersion) {
      // No compatible version: show a disabled Install with the reason on hover.
      this.setInstallNote(this.incompatibleMessage(), true);
      this.refs.installButtonGroup.style.display = "";
      this.refs.updateButtonGroup.style.display = "none";
    } else if (this.newVersion || this.newSha) {
      this.clearInstallNote();
      this.refs.updateButtonGroup.style.display = "";
      this.refs.installButtonGroup.style.display = "none";
    } else {
      // Usable Install, optionally with an informational compatibility note.
      this.setInstallNote(this.shadowedInstallNote() || this.compatibleVersionNote || null, false);
      this.refs.updateButtonGroup.style.display = "none";
      this.refs.installButtonGroup.style.display = "";
    }
    this.refs.packageActionButtonGroup.style.display = "none";
  }

  // Installing puts a package in the community directory, which a dev checkout
  // of the same name outranks. The install still succeeds and the files are
  // there, but the dev copy keeps loading — say so before the click, not after.
  shadowedInstallNote() {
    const owner = atom.packages.getAvailablePackage(this.pack.name);
    if (!owner || owner.tier !== "dev") return null;
    return (
      `Your dev package in “${owner.dirname}” provides “${this.pack.name}”, ` +
      "so it will keep loading instead of this one."
    );
  }

  installedSameOriginInOtherSlot() {
    const originKey = packageOrigin(this.pack);
    if (!originKey || !this.packageManager.findInstalledPackageByOrigin) return null;
    const installed = this.packageManager.findInstalledPackageByOrigin(originKey);
    return installed && installed.name !== this.pack.name ? installed : null;
  }

  originRenameMessage(installed) {
    return (
      `This repository is already installed as “${installed.name}”. ` +
      `Uninstall it before installing a ref named “${this.pack.name}”.`
    );
  }

  updateOriginRenameWarning(installed) {
    if (!installed) {
      this.clearOriginRenameWarning();
      return;
    }
    this.refs.originRenameWarning.textContent = this.originRenameMessage(installed);
    this.refs.originRenameWarning.style.display = "";
  }

  clearOriginRenameWarning() {
    if (!this.refs.originRenameWarning) return;
    this.refs.originRenameWarning.textContent = "";
    this.refs.originRenameWarning.style.display = "none";
  }

  displayGitPackageInstallInformation() {
    this.refs.metaUserContainer.remove();
    const { gitUrlInfo } = this.pack;
    if (!gitUrlInfo) {
      this.refs.packageDescription.textContent = this.pack.repository || this.pack.name;
    } else if (gitUrlInfo.default === "shortcut") {
      this.refs.packageDescription.textContent = gitUrlInfo.https();
    } else {
      this.refs.packageDescription.textContent = gitUrlInfo.toString();
    }
    this.refs.installButton.classList.remove("icon-cloud-download");
    this.refs.installButton.classList.add("icon-git-commit");
    this.refs.updateButton.classList.remove("icon-cloud-download");
    this.refs.updateButton.classList.add("icon-git-commit");
  }

  displayAvailableUpdate(newVersion) {
    if (this.isShadowed) return;
    this.newVersion = newVersion;
    this.updateInterfaceState();
  }

  handlePackageEvents() {
    this.disposables.add(
      atom.packages.onDidDeactivatePackage((pack) => {
        if (pack.name === this.pack.name) {
          this.updateDisabledState();
        }
      }),
    );

    this.disposables.add(
      atom.packages.onDidActivatePackage((pack) => {
        if (pack.name === this.pack.name) {
          this.updateDisabledState();
        }
      }),
    );

    this.disposables.add(
      atom.config.onDidChange("core.disabledPackages", () => {
        this.updateDisabledState();
      }),
    );

    this.subscribeToPackageEvent("package-installing theme-installing", (pack) => {
      if (this.isSameOriginEvent(pack)) {
        this.updateInterfaceState();
        this.refs.installButton.disabled = true;
        this.refs.installButton.classList.add("is-installing");
      } else {
        // A different package with the same name is being installed; this one
        // can't be installed until that finishes, so show it disabled — not the
        // "installing" spinner.
        this.setInstallNote(`Installing “${pack.name}”…`, true);
      }
    });

    this.subscribeToPackageEvent("package-updating theme-updating", (pack) => {
      if (!this.isSameOriginEvent(pack)) return;
      this.updateInterfaceState();
      this.refs.updateButton.disabled = true;
      this.refs.updateButton.classList.add("is-installing");
    });

    this.subscribeToPackageEvent("package-uninstalling theme-uninstalling", (pack) => {
      if (!this.isSameOriginEvent(pack)) return;
      this.updateInterfaceState();
      this.refs.enablementButton.disabled = true;
      this.refs.uninstallButton.disabled = true;
      this.refs.uninstallButton.classList.add("is-uninstalling");
    });

    this.subscribeToPackageEvent(
      "package-installed package-install-failed theme-installed theme-install-failed",
      (pack) => {
        // A different same-named install finished: re-evaluate — this card is
        // now either in conflict (it succeeded) or installable again (it failed).
        if (!this.isSameOriginEvent(pack)) {
          this.updateInterfaceState();
          return;
        }
        const loadedPack = atom.packages.getLoadedPackage(this.pack.name);
        const version = loadedPack && loadedPack.metadata ? loadedPack.metadata.version : null;
        if (version) {
          this.pack.version = version;
        }
        this.refs.installButton.disabled = false;
        this.refs.installButton.classList.remove("is-installing");
        this.updateInterfaceState();
      },
    );

    this.subscribeToPackageEvent("package-updated theme-updated", (pack) => {
      if (!this.isSameOriginEvent(pack)) {
        this.updateInterfaceState();
        return;
      }
      const loadedPack = atom.packages.getLoadedPackage(this.pack.name);
      const metadata = loadedPack ? loadedPack.metadata : null;
      if (metadata && metadata.version) {
        this.pack.version = metadata.version;
      }

      if (metadata && metadata.apmInstallSource) {
        this.pack.apmInstallSource = metadata.apmInstallSource;
      }

      this.newVersion = null;
      this.newSha = null;
      this.refs.updateButton.disabled = false;
      this.refs.updateButton.classList.remove("is-installing");
      this.updateInterfaceState();
    });

    this.subscribeToPackageEvent("package-update-failed theme-update-failed", (pack) => {
      if (!this.isSameOriginEvent(pack)) return;
      this.refs.updateButton.disabled = false;
      this.refs.updateButton.classList.remove("is-installing");
      this.updateInterfaceState();
    });

    this.subscribeToPackageEvent(
      "package-uninstalled package-uninstall-failed theme-uninstalled theme-uninstall-failed",
      (pack) => {
        if (!this.isSameOriginEvent(pack)) {
          this.updateInterfaceState();
          return;
        }
        this.newVersion = null;
        this.newSha = null;
        this.refs.enablementButton.disabled = false;
        this.refs.uninstallButton.disabled = false;
        this.refs.uninstallButton.classList.remove("is-uninstalling");
        this.updateInterfaceState();
      },
    );
  }

  // Returns whether the event is about this card's origin rather than a
  // different package that merely shares its name.
  isSameOriginEvent(pack) {
    const cardOrigin = packageOrigin(this.pack);
    const eventOrigin = packageOrigin(pack);
    if (cardOrigin && eventOrigin) return cardOrigin === eventOrigin;
    // At least one side has no recorded origin. They are the same package only
    // when NEITHER does — a local/unpublished package, already matched by name in
    // subscribeToPackageEvent. If one side has an origin and the other does not,
    // a shared name is a coincidence (e.g. a community card and a same-named
    // bundled or hand-placed package), so one must not drive the other's state.
    return !cardOrigin && !eventOrigin;
  }

  isInstalled() {
    return this.packageManager.isPackageInstalled(this.pack.name);
  }

  isDisabled() {
    return atom.packages.isPackageDisabled(this.pack.name);
  }

  hasSettings() {
    return this.packageManager.packageHasSettings(this.pack.name);
  }

  subscribeToPackageEvent(event, callback) {
    this.disposables.add(
      this.packageManager.on(event, ({ pack, error }) => {
        if (pack.pack != null) {
          pack = pack.pack;
        }

        if (!pack) return;
        const sameName = pack.name === this.pack.name;
        const cardOrigin = packageOrigin(this.pack);
        const eventOrigin = packageOrigin(pack);
        if (sameName || (cardOrigin && eventOrigin && cardOrigin === eventOrigin)) {
          callback(pack, error);
        }
      }),
    );
  }

  /*
  Section: Methods that should be on a Package model
  */

  install() {
    // Install is blocked (name conflict or no compatible version); the button
    // is shown disabled with a hover note explaining why.
    if (this.installBlocked) {
      return;
    }
    this.packageManager.install(
      this.installablePack != null ? this.installablePack : this.pack,
      (error) => {
        if (error != null) {
          console.error(
            `Installing ${this.type} ${this.pack.name} failed`,
            error.stack != null ? error.stack : error,
            error.stderr,
          );
        } else {
          // if a package was disabled before installing it, re-enable it
          if (this.isDisabled()) {
            atom.packages.enablePackage(this.pack.name);
          }
        }
      },
    );
  }

  // Conflict-state action: the install slot (name) is taken by a different
  // package, so uninstall that one and install this one in a single step. The
  // reused name means this package inherits the existing `name.*` settings and
  // `name:` keybindings.
  replace() {
    const button = this.refs.replaceButton;
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add("is-installing");
    this.packageManager.replace(
      this.installablePack != null ? this.installablePack : this.pack,
      (installError) => {
        if (installError != null) {
          button.disabled = false;
          button.classList.remove("is-installing");
          console.error(
            `Replacing ${this.type} ${this.pack.name} failed`,
            installError.stack != null ? installError.stack : installError,
            installError.stderr,
          );
        }
      },
    );
  }

  update() {
    if (!this.newVersion && !this.newSha) {
      return Promise.resolve();
    }

    const pack = this.installablePack != null ? this.installablePack : this.pack;
    const version = this.newVersion ? `v${this.newVersion}` : `#${this.newSha.substr(0, 8)}`;
    return new Promise((resolve, reject) => {
      this.packageManager.update(pack, this.newVersion, (error) => {
        if (error != null) {
          atom.assert(false, "Package update failed", (assertionError) => {
            assertionError.metadata = {
              type: this.type,
              name: pack.name,
              version,
              errorMessage: error.message,
              errorStack: error.stack,
              errorStderr: error.stderr,
            };
          });
          console.error(
            `Updating ${this.type} ${pack.name} to ${version} failed:\n`,
            error,
            error.stderr != null ? error.stderr : "",
          );
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  uninstall() {
    this.packageManager.uninstall(this.pack, (error) => {
      if (error != null) {
        console.error(
          `Uninstalling ${this.type} ${this.pack.name} failed`,
          error.stack != null ? error.stack : error,
          error.stderr,
        );
      }
    });
  }
};
