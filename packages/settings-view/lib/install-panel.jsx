/** @jsx etch.dom */
/** @jsxFrag etch.Fragment */
const path = require("path");
const etch = require("@lumine-code/etch");
const gitHubUrlInfo = require("./github-url-info");

const requireCore = require("./require-core");
const { cloneUrlForRepository, parsePackageSource } = requireCore("package-source");

const { CompositeDisposable, Disposable, TextEditor } = require("atom");

const PackageCard = require("./package-card");
const notifyPackageError = require("./notify-error");
const { packageOrigin } = require("./utils");
const { normalizeCatalogSource } = require("./community-package-catalog-client");

const PackageNameRegex = /config\/install\/(?:package|theme):([a-z0-9-_]+)/i;

module.exports = class InstallPanel {
  constructor(settingsView, packageManager) {
    this.settingsView = settingsView;
    this.packageManager = packageManager;
    this.disposables = new CompositeDisposable();
    this.sourceDisposables = new CompositeDisposable();
    this.catalogClient = this.packageManager.getCatalogClient();
    this.pulsarClient = this.packageManager.getPulsarClient();
    this.catalogPackages = [];
    this.catalogPackageCards = [];
    this.browsePackageCards = [];
    this.catalogFetched = false;
    this.sourceEditors = [];
    this.filterType = "all";
    this.page = 1;
    this.pageSize = 50;
    this.searchPackages = [];
    this.atomIoURL = "https://github.com";

    etch.initialize(this);

    this.refs.searchMessage.style.display = "none";

    this.refs.searchEditor.setPlaceholderText("Search community packages or enter owner/repo");
    this.refs.catalogEditor.setPlaceholderText("owner/catalog or index.json URL");

    this.disposables.add(atom.tooltips.add(this.refs.addCatalogButton, { title: "Add catalog" }));
    // Install failures are surfaced as notifications centrally (see SettingsView).
    // Catalog fetch and Pulsar search failures below are panel-local; those still
    // raise their own notifications, tracked here so a re-run can dismiss a stale one.
    this.catalogFetchNotifications = [];
    this.disposables.add(
      this.packageManager.on("package-installed theme-installed", ({ pack }) => {
        const gitUrlInfo =
          this.currentGitPackageCard &&
          this.currentGitPackageCard.pack &&
          this.currentGitPackageCard.pack.gitUrlInfo
            ? this.currentGitPackageCard.pack.gitUrlInfo
            : null;

        const sourceMatches =
          this.currentGitPackageCard &&
          this.currentGitPackageCard.pack &&
          (this.currentGitPackageCard.pack.name ===
            (pack.apmInstallSource && pack.apmInstallSource.source) ||
            this.currentGitPackageCard.pack.repository ===
              (pack.apmInstallSource && pack.apmInstallSource.repository));
        if ((gitUrlInfo && gitUrlInfo === pack.gitUrlInfo) || sourceMatches) {
          this.updateGitPackageCard(pack);
        }
      }),
    );
    // Debounce the search so it runs shortly after the user stops typing rather
    // than on every keystroke.
    let searchTimer = null;
    this.disposables.add(
      this.refs.searchEditor.getBuffer().onDidChange(() => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => this.performSearch(), 700);
      }),
    );
    this.disposables.add(new Disposable(() => clearTimeout(searchTimer)));
    this.disposables.add(
      atom.commands.add(this.refs.searchEditor.element, "core:confirm", () => {
        this.performSearch();
      }),
    );
    this.disposables.add(
      atom.commands.add(this.refs.catalogEditor.element, "core:confirm", () => {
        this.didClickAddCatalog();
      }),
    );
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
    this.disposables.add(
      atom.config.onDidChange("settings-view.communityPackageCatalogs", () => {
        this.renderCatalogSources();
        // Sources changed — re-fetch on the next search instead of reusing the
        // data fetched from the old source list.
        this.catalogFetched = false;
        this.catalogPromise = this.loadCatalog({ cacheOnly: true });
      }),
    );
    this.disposables.add(
      atom.config.observe("settings-view.includePulsarPackageResults", (include) => {
        this.refs.includePulsarCheckbox.checked = !!include;
      }),
    );

    this.renderCatalogSources();
    // Populated on first show (see beforeShow); until then nothing is loaded.
    this.catalogPromise = Promise.resolve({ schemaVersion: 1, packages: [] });
  }

  didToggleIncludePulsar() {
    atom.config.set(
      "settings-view.includePulsarPackageResults",
      this.refs.includePulsarCheckbox.checked,
    );
    this.performSearch();
  }

  destroy() {
    this.clearSourceEditors();
    this.sourceDisposables.dispose();
    this.clearPackageCards(this.catalogPackageCards);
    this.clearPackageCards(this.browsePackageCards);
    if (this.currentGitPackageCard) this.currentGitPackageCard.destroy();
    if (this.catalogProgressTooltip) this.catalogProgressTooltip.dispose();
    this.disposables.dispose();
    return etch.destroy(this);
  }

  update() {}

  focus() {
    this.refs.searchEditor.element.focus();
  }

  show() {
    this.element.style.display = "";
  }

  render() {
    return (
      <div className="panels-item" tabIndex="-1">
        <div className="section packages">
          <div className="section-container">
            <h1 ref="installHeading" className="section-heading icon icon-plus">
              Install Packages
            </h1>

            <div className="text native-key-bindings" tabIndex="-1">
              <span className="icon icon-question" />
              <span ref="publishedToText">
                Packages are installed from Git repositories such as{" "}
              </span>
              <a className="link" onclick={this.didClickOpenAtomIo.bind(this)}>
                GitHub
              </a>
              <span> and are installed to {path.join(process.env.LUMINE_HOME, "packages")}</span>
            </div>

            <div className="sub-section catalog-sources">
              <h3 className="sub-section-heading icon icon-repo">Catalog Sources</h3>
              <div ref="catalogSourcesList" className="catalog-sources-list" />
              <div className="catalog-source catalog-source-add">
                <div className="editor-container">
                  <TextEditor mini ref="catalogEditor" />
                </div>
                <button
                  ref="addCatalogButton"
                  className="btn icon icon-plus catalog-source-button"
                  aria-label="Add catalog"
                  onclick={this.didClickAddCatalog.bind(this)}
                />
              </div>
              <div className="catalog-source-actions">
                <div className="btn-group">
                  <button
                    ref="fetchButton"
                    className="btn icon icon-sync"
                    onclick={this.didClickFetch.bind(this)}
                  >
                    Fetch
                  </button>
                  <button
                    ref="cancelFetchButton"
                    className="btn icon icon-x"
                    style={{ display: "none" }}
                    onclick={this.didClickCancelFetch.bind(this)}
                  >
                    Cancel
                  </button>
                  <button
                    ref="restoreDefaultsButton"
                    className="btn icon icon-history"
                    onclick={this.didClickRestoreDefaults.bind(this)}
                  >
                    Restore Defaults
                  </button>
                </div>
                <label className="pulsar-toggle">
                  <input
                    ref="includePulsarCheckbox"
                    className="input-checkbox"
                    type="checkbox"
                    onchange={this.didToggleIncludePulsar.bind(this)}
                  />
                  <span>Include results from the Pulsar package registry</span>
                </label>
              </div>
              <div ref="catalogProgress" className="catalog-progress text-subtle" />
              <div
                ref="catalogSourceError"
                className="alert alert-danger alert-dismissable"
                style={{ display: "none" }}
              >
                <button
                  ref="catalogSourceErrorClose"
                  className="close icon icon-x"
                  onclick={() => this.hideCatalogSourceError()}
                />
                <span ref="catalogSourceErrorMessage" />
              </div>
            </div>
          </div>
        </div>

        <div className="section packages">
          <div className="section-container">
            <h1 ref="browseHeading" className="section-heading icon icon-star">
              Community Packages
            </h1>

            <div className="search-container clearfix">
              <div className="editor-container">
                <TextEditor mini ref="searchEditor" />
              </div>
              <div className="btn-group">
                <button
                  ref="filterAllButton"
                  className="btn btn-default selected"
                  onclick={() => this.setFilterType("all")}
                >
                  All
                </button>
                <button
                  ref="filterPackagesButton"
                  className="btn btn-default"
                  onclick={() => this.setFilterType("packages")}
                >
                  Packages
                </button>
                <button
                  ref="filterThemesButton"
                  className="btn btn-default"
                  onclick={() => this.setFilterType("themes")}
                >
                  Themes
                </button>
              </div>
            </div>

            <div ref="searchMessage" className="alert alert-info search-message icon icon-search" />
            <div ref="resultsContainer" className="container package-container" />

            <div ref="browseArea" className="browse-area">
              <div ref="browseContainer" className="container package-container" />
            </div>
            <div ref="pagination" className="catalog-pagination" style={{ display: "none" }}>
              <button
                ref="previousPageButton"
                className="btn"
                onclick={this.previousPage.bind(this)}
              >
                Previous
              </button>
              <span ref="pageStatus" />
              <button ref="nextPageButton" className="btn" onclick={this.nextPage.bind(this)}>
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  beforeShow(options) {
    // Show the persistent cache immediately. On the first run, when no cache
    // exists, begin a progressive refresh before handling an incoming search.
    if (!this.initialFetchStarted) {
      this.initialFetchStarted = true;
      if (!this.catalogFetched && this.getCatalogSources().length) {
        this.catalogPromise = this.loadCatalog({ cacheOnly: true }).then((catalog) => {
          if (catalog.packages.length === 0) return this.loadCatalog({ refresh: true });
          return catalog;
        });
      }
    }

    if (options && options.uri) {
      const query = this.extractQueryFromURI(options.uri);
      if (query != null) {
        this.refs.searchEditor.setText(query);
        this.performSearch();
      }
    }
  }

  extractQueryFromURI(uri) {
    const matches = PackageNameRegex.exec(uri);
    if (matches) {
      return matches[1];
    } else {
      return null;
    }
  }

  setFilterType(filterType) {
    this.filterType = filterType;
    this.page = 1;
    const buttons = {
      all: this.refs.filterAllButton,
      packages: this.refs.filterPackagesButton,
      themes: this.refs.filterThemesButton,
    };
    for (const [type, button] of Object.entries(buttons)) {
      button.classList.toggle("selected", type === filterType);
    }
    // performSearch renders the browse list (no query) or the filtered search
    // results (query); no separate renderBrowseList call is needed.
    this.performSearch();
  }

  matchesFilter(pack) {
    if (this.filterType === "themes") return !!pack.theme;
    if (this.filterType === "packages") return !pack.theme;
    return true;
  }

  performSearch() {
    // Git refs, and paths on some Git servers, are case-sensitive.
    const query = this.refs.searchEditor.getText().trim();
    this.page = 1;
    if (query) {
      // Download the catalogs on the first search if the user never clicked
      // Fetch — otherwise a search would only surface live Pulsar results and
      // silently miss the community catalogs.
      if (!this.catalogFetched && this.getCatalogSources().length) {
        this.catalogPromise = this.loadCatalog();
      }
      this.refs.browseArea.style.display = "none";
      this.performSearchForQuery(query);
    } else {
      this.clearSearchResults();
      this.refs.browseArea.style.display = "";
      this.renderBrowseList();
    }
  }

  performSearchForQuery(query) {
    try {
      const parsed = parsePackageSource(query);
      cloneUrlForRepository(parsed.repository);
      const gitUrlInfo = gitHubUrlInfo.fromUrl(parsed.repository);
      return this.showGitInstallPackageCard({
        name: query,
        // The typed query is the exact source to install — it may carry a
        // selector (e.g. "owner/repo@0.4.0"), which the bare `repository` drops.
        installSource: parsed.source,
        repository: parsed.repository,
        gitUrlInfo: gitUrlInfo && gitUrlInfo.type === "github" ? gitUrlInfo : null,
      });
    } catch {
      return this.searchCatalog(query);
    }
  }

  clearSearchResults() {
    if (this.currentGitPackageCard) {
      this.currentGitPackageCard.destroy();
      this.currentGitPackageCard = null;
    }
    this.clearPackageCards(this.catalogPackageCards);
    this.refs.resultsContainer.innerHTML = "";
    this.refs.searchMessage.style.display = "none";
  }

  showGitHubOnlyMessage(_query) {
    if (this.currentGitPackageCard) {
      this.currentGitPackageCard.destroy();
      this.currentGitPackageCard = null;
    }

    this.refs.resultsContainer.innerHTML = "";
    this.clearPackageCards(this.catalogPackageCards);
    this.refs.searchMessage.textContent = `No community packages match “${_query}”. You can also enter owner/repo directly.`;
    this.refs.searchMessage.style.display = "";
  }

  showGitInstallPackageCard(pack) {
    this.clearPackageCards(this.catalogPackageCards);
    this.refs.searchMessage.style.display = "none";
    if (this.currentGitPackageCard) {
      this.currentGitPackageCard.destroy();
    }

    const pendingPack = {
      ...pack,
      originKey: packageOrigin(pack),
      status: "validating",
      refs: { tags: [], branches: null },
    };
    this.currentGitPackageCard = this.getPackageCardView(pendingPack);
    this.updatePagination(0);
    this.currentGitPackageCard.displayGitPackageInstallInformation();
    this.replaceCurrentGitPackageCardView();

    if (typeof this.catalogClient.hydrateManualSource === "function") {
      this.catalogClient.hydrateManualSource(pack.installSource).then(
        (hydrated) => this.updateGitPackageCard({ ...pack, ...hydrated }),
        (error) =>
          this.updateGitPackageCard({
            ...pendingPack,
            status: "error",
            error: error.message,
          }),
      );
    }
  }

  updateGitPackageCard(pack) {
    if (this.currentGitPackageCard) {
      this.currentGitPackageCard.destroy();
    }

    this.currentGitPackageCard = this.getPackageCardView(pack);
    this.replaceCurrentGitPackageCardView();
  }

  replaceCurrentGitPackageCardView() {
    this.clearPackageCards(this.catalogPackageCards);
    this.refs.resultsContainer.innerHTML = "";
    this.addPackageCardView(this.refs.resultsContainer, this.currentGitPackageCard);
  }

  async search(query) {
    return this.searchCatalog(query);
  }

  addPackageViews(container, packages) {
    for (const pack of packages) {
      this.addPackageCardView(container, this.getPackageCardView(pack));
    }
  }

  addPackageCardView(container, packageCard) {
    const packageRow = document.createElement("div");
    packageRow.classList.add("row");
    packageRow.appendChild(packageCard.element);
    container.appendChild(packageRow);
  }

  getPackageCardView(pack) {
    return new PackageCard(pack, this.settingsView, this.packageManager, {
      back: "Install",
      onPackUpdated: (updatedPack) => this.rememberSelectedPack(updatedPack),
    });
  }

  rememberSelectedPack(updatedPack) {
    const origin = packageOrigin(updatedPack);
    this.catalogPackages = this.catalogPackages.map((pack) =>
      packageOrigin(pack) === origin ? updatedPack : pack,
    );
    this.searchPackages = this.searchPackages.map((pack) =>
      packageOrigin(pack) === origin ? updatedPack : pack,
    );
  }

  async loadCatalog({ refresh = false, cacheOnly = false } = {}) {
    if (!cacheOnly) this.catalogFetched = true;
    const generation = (this.catalogGeneration = (this.catalogGeneration || 0) + 1);
    if (!cacheOnly) this.catalogIndexing = true;
    const sources = this.getCatalogSources();
    this.dismissCatalogFetchNotifications();
    if (refresh) {
      this.refs.fetchButton.classList.add("is-checking");
      this.refs.cancelFetchButton.style.display = "";
      // Erase the current catalog list and its per-repository error tooltip; the
      // list is rebuilt incrementally as records arrive.
      this.catalogPackages = [];
      this.updateCatalogProgressTooltip([]);
      this.refs.catalogProgress.textContent = "Fetching…";
      this.renderBrowseList();
    }

    const progressive = new Map(this.catalogPackages.map((pack) => [packageOrigin(pack), pack]));
    let renderTimer = null;
    let pendingRecords = 0;
    const flushRender = () => {
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      pendingRecords = 0;
      if (generation !== this.catalogGeneration) return;
      this.catalogPackages = Array.from(progressive.values());
      const query = this.refs.searchEditor.getText().trim();
      if (query && this.catalogIndexing) this.renderIncompleteSearch(query);
      else this.renderBrowseList();
    };
    const scheduleRender = () => {
      // Redraw once every ~10 hydrated packages, with a short time-based fallback
      // so the trailing few still appear promptly.
      if (++pendingRecords >= 50) {
        flushRender();
      } else if (!renderTimer) {
        renderTimer = setTimeout(flushRender, 5000);
      }
    };

    try {
      const result = await this.catalogClient.loadAll(sources, {
        refresh,
        cacheOnly,
        onProgress: ({ processed, total, errors }) => {
          if (generation !== this.catalogGeneration) return;
          this.refs.catalogProgress.textContent = `${processed} / ${total} processed · ${errors} error(s)`;
        },
        onRecord: (pack) => {
          progressive.set(packageOrigin(pack), pack);
          scheduleRender();
        },
      });
      if (generation !== this.catalogGeneration) return { packages: this.catalogPackages };
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      this.catalogPackages = result.packages;
      this.updateCatalogProgressTooltip(result.packages);
      this.page = Math.min(
        this.page,
        Math.max(1, Math.ceil(this.catalogPackages.length / this.pageSize)),
      );
      this.renderBrowseList();
      const stamp = result.lastFetch ? new Date(result.lastFetch).toLocaleString() : "never";
      this.refs.catalogProgress.textContent = `${result.packages.length} package(s) · last Fetch ${stamp}${
        result.cancelled ? " · cancelled" : ""
      }${
        result.pendingSources && result.pendingSources.length
          ? ` · ${result.pendingSources.length} source(s) pending Fetch`
          : ""
      }`;
      if (result.errors && result.errors.length) {
        // One notification for the whole fetch, listing each failed source, so a
        // catalog with many bad entries doesn't bury the screen in toasts.
        const detail = result.errors.map((e) => `${e.source}: ${e.message}`).join("\n");
        this.catalogFetchNotifications.push(
          atom.notifications.addWarning(
            `${result.errors.length} catalog source(s) failed to load.`,
            { dismissable: true, detail },
          ),
        );
      }
      return { schemaVersion: 2, packages: this.catalogPackages };
    } catch (error) {
      if (generation === this.catalogGeneration) {
        this.catalogFetchNotifications.push(
          notifyPackageError(this.packageManager, error, "Failed to load the package catalog."),
        );
      }
      return { schemaVersion: 2, packages: this.catalogPackages };
    } finally {
      if (generation === this.catalogGeneration) {
        this.catalogIndexing = false;
        this.refs.fetchButton.classList.remove("is-checking");
        this.refs.cancelFetchButton.style.display = "none";
        this.refs.cancelFetchButton.disabled = false;
      }
    }
  }

  // Lists the repositories that failed to hydrate (with their error messages) in
  // a tooltip on the progress line, so the "N error(s)" count is explorable.
  updateCatalogProgressTooltip(packages) {
    if (this.catalogProgressTooltip) {
      this.catalogProgressTooltip.dispose();
      this.catalogProgressTooltip = null;
    }
    const failed = (packages || []).filter(
      (pack) => (pack.status === "error" || pack.status === "stale") && pack.error,
    );
    this.refs.catalogProgress.classList.toggle("has-errors", failed.length > 0);
    if (!failed.length) return;
    const escape = (text) =>
      String(text).replace(
        /[&<>"']/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
      );
    const entries = failed.map((pack) => ({
      title: `<strong>${escape(pack.originKey || pack.name || "")}</strong>: ${escape(pack.error)}`,
    }));
    entries[0].html = true;
    entries[0].class = "catalog-progress-tooltip";
    this.catalogProgressTooltip = atom.tooltips.addComposite(this.refs.catalogProgress, entries);
  }

  // Renders `packs` into `container`, reusing any existing card whose pack
  // object is unchanged (identity). Filter and page switches keep the same pack
  // objects, so no card is rebuilt; a fetch replaces the objects it re-hydrates,
  // so only those cards rebuild. This keeps switching "All"/"Packages" and
  // paging cheap instead of destroying and recreating up to 50 cards each time.
  renderCardList(container, cards, packs) {
    const pool = new Map();
    for (const card of cards) {
      const key = packageOrigin(card.pack) || card.pack.name;
      if (!pool.has(key)) pool.set(key, card);
    }
    const next = [];
    const reused = new Set();
    for (const pack of packs) {
      const key = packageOrigin(pack) || pack.name;
      const pooled = pool.get(key);
      if (pooled && pooled.pack === pack && !reused.has(pooled)) {
        reused.add(pooled);
        next.push(pooled);
      } else {
        next.push(this.getPackageCardView(pack));
      }
    }
    for (const card of cards) {
      if (!reused.has(card)) card.destroy();
    }
    container.innerHTML = "";
    for (const card of next) {
      this.addPackageCardView(container, card);
    }
    cards.length = 0;
    cards.push(...next);
  }

  renderBrowseList() {
    const origins = new Set();
    const packages = this.catalogPackages
      .filter((pack) => this.matchesFilter(pack))
      .filter((pack) => {
        const key = packageOrigin(pack);
        if (key && origins.has(key)) return false;
        if (key) origins.add(key);
        return true;
      })
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          packageOrigin(left).localeCompare(packageOrigin(right)),
      );
    const start = (this.page - 1) * this.pageSize;
    this.renderCardList(
      this.refs.browseContainer,
      this.browsePackageCards,
      packages.slice(start, start + this.pageSize),
    );
    this.updatePagination(packages.length);
  }

  updatePagination(total) {
    const pages = Math.max(1, Math.ceil(total / this.pageSize));
    this.page = Math.min(this.page, pages);
    this.refs.pagination.style.display = total > this.pageSize ? "" : "none";
    this.refs.pageStatus.textContent = `Page ${this.page} of ${pages} · ${total} result(s)`;
    this.refs.previousPageButton.disabled = this.page <= 1;
    this.refs.nextPageButton.disabled = this.page >= pages;
  }

  previousPage() {
    if (this.page <= 1) return;
    this.page--;
    this.renderActivePage();
  }

  nextPage() {
    this.page++;
    this.renderActivePage();
  }

  renderActivePage() {
    if (this.refs.searchEditor.getText().trim()) this.renderSearchList(this.searchPackages);
    else this.renderBrowseList();
  }

  isPulsarSearchEnabled() {
    return atom.config.get("settings-view.includePulsarPackageResults") === true;
  }

  // Scores a package against the query by name and keywords only. Descriptions
  // are deliberately excluded: fuzzy-matching prose produced noisy hits (e.g.
  // "ui" matching a syntax theme whose description mentions "Seti UI").
  scorePackage(pack, query) {
    const name = pack.name.toLowerCase();
    if (name === query) return 1000;
    if (name.startsWith(query)) return 800;
    if (name.includes(query)) return 600;

    const keywords = (pack.keywords || []).map((keyword) => keyword.toLowerCase());
    if (keywords.includes(query)) return 400;
    if (keywords.some((keyword) => keyword.includes(query))) return 300;

    // Typo-tolerant fallback on the name only.
    return (atom.tools.fuzzyMatcher.score(name, query) || 0) > 0 ? 100 : 0;
  }

  scoreCatalog(query) {
    const normalizedQuery = query.trim().toLowerCase();
    return this.catalogPackages
      .filter((pack) => this.matchesFilter(pack))
      .map((pack) => ({ pack, score: this.scorePackage(pack, normalizedQuery) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) => right.score - left.score || left.pack.name.localeCompare(right.pack.name),
      )
      .map(({ pack }) => pack);
  }

  addResultCard(pack, byOrigin, results) {
    const key = packageOrigin(pack);
    if (key && byOrigin.has(key)) {
      // A duplicate (e.g. the same repository surfaced by the Pulsar registry)
      // does not add a second card, but its catalog provenance is recorded on
      // the card that is kept.
      const index = byOrigin.get(key);
      results[index] = this.mergeCatalogProvenance(results[index], pack);
      return;
    }
    if (key) byOrigin.set(key, results.length);
    results.push(pack);
  }

  // Adds the duplicate's catalog sources/selectors to the kept card without
  // mutating the cached record (returns a copy).
  mergeCatalogProvenance(kept, duplicate) {
    const keptSources = kept.catalogSources || [];
    const newSources = (duplicate.catalogSources || []).filter(
      (source) => !keptSources.includes(source),
    );
    if (!newSources.length) return kept;
    const newSelectors = (duplicate.catalogSelectors || []).filter((entry) =>
      newSources.includes(entry.catalogSource),
    );
    return {
      ...kept,
      catalogSources: [...keptSources, ...newSources],
      catalogSelectors: [...(kept.catalogSelectors || []), ...newSelectors],
    };
  }

  renderSearchList(packages) {
    const start = (this.page - 1) * this.pageSize;
    this.renderCardList(
      this.refs.resultsContainer,
      this.catalogPackageCards,
      packages.slice(start, start + this.pageSize),
    );
    this.updatePagination(packages.length);
  }

  renderIncompleteSearch(query) {
    this.searchPackages = this.scoreCatalog(query);
    this.renderSearchList(this.searchPackages);
    this.refs.searchMessage.textContent =
      "Catalog indexing is still in progress; these search results are incomplete.";
    this.refs.searchMessage.style.display = "";
  }

  clearPulsarError() {
    if (this.pulsarErrorNotification) {
      this.pulsarErrorNotification.dismiss();
      this.pulsarErrorNotification = null;
    }
  }

  dismissCatalogFetchNotifications() {
    if (!this.catalogFetchNotifications) return;
    for (const notification of this.catalogFetchNotifications) notification.dismiss();
    this.catalogFetchNotifications = [];
  }

  async searchCatalog(query) {
    const generation = (this.searchGeneration = (this.searchGeneration || 0) + 1);
    if (this.currentGitPackageCard) {
      this.currentGitPackageCard.destroy();
      this.currentGitPackageCard = null;
    }
    this.clearPackageCards(this.catalogPackageCards);
    this.refs.resultsContainer.innerHTML = "";
    this.refs.searchMessage.style.display = "none";
    this.clearPulsarError();

    if (this.catalogIndexing) this.renderIncompleteSearch(query);
    await this.catalogPromise;
    if (generation !== this.searchGeneration) return [];
    this.refs.searchMessage.style.display = "none";

    // Local community catalog results first, deduplicated by repository.
    const byOrigin = new Map();
    const results = [];
    for (const pack of this.scoreCatalog(query)) {
      this.addResultCard(pack, byOrigin, results);
    }

    // Opt-in live search of the Pulsar registry, appended and deduped by repo.
    if (this.isPulsarSearchEnabled()) {
      let pulsarResults = [];
      try {
        pulsarResults = await this.pulsarClient.search(query);
        pulsarResults = (
          await Promise.all(
            pulsarResults.map((pack) =>
              this.catalogClient
                .hydrateSource(pack.installSource || pack.repository, "pulsar")
                .catch(() => null),
            ),
          )
        ).filter(Boolean);
      } catch (error) {
        if (generation === this.searchGeneration) {
          this.pulsarErrorNotification = atom.notifications.addError(
            "Pulsar registry search failed.",
            { dismissable: true, detail: error.message },
          );
        }
      }
      if (generation !== this.searchGeneration) return results;
      for (const pack of pulsarResults) {
        if (this.matchesFilter(pack)) this.addResultCard(pack, byOrigin, results);
      }
    }

    if (results.length === 0) {
      this.searchPackages = [];
      this.updatePagination(0);
      this.showGitHubOnlyMessage(query);
      return [];
    }
    this.searchPackages = results;
    this.renderSearchList(results);
    return results;
  }

  clearPackageCards(cards) {
    while (cards.length) cards.pop().destroy();
  }

  getCatalogSources() {
    const sources = atom.config.get("settings-view.communityPackageCatalogs");
    return Array.isArray(sources)
      ? sources.filter((source) => typeof source === "string" && source.trim())
      : [];
  }

  clearSourceEditors() {
    this.sourceDisposables.dispose();
    this.sourceDisposables = new CompositeDisposable();
    while (this.sourceEditors.length) this.sourceEditors.pop().destroy();
  }

  showCatalogSourceError(message) {
    this.refs.catalogSourceErrorMessage.textContent = message;
    this.refs.catalogSourceError.style.display = "";
  }

  hideCatalogSourceError() {
    this.refs.catalogSourceError.style.display = "none";
  }

  renderCatalogSources() {
    this.clearSourceEditors();
    this.refs.catalogSourcesList.innerHTML = "";
    this.hideCatalogSourceError();
    this.getCatalogSources().forEach((source, index) => {
      const row = document.createElement("div");
      row.className = "catalog-source";

      const editorContainer = document.createElement("div");
      editorContainer.className = "editor-container";
      const editor = new TextEditor({ mini: true });
      editor.setText(source);
      editorContainer.appendChild(editor.element);
      this.sourceEditors.push(editor);

      const commit = () => {
        const value = editor.getText().trim();
        if (value !== source) this.updateCatalogSource(index, value);
      };
      this.sourceDisposables.add(atom.commands.add(editor.element, "core:confirm", commit));
      editor.element.addEventListener("blur", commit);
      this.sourceDisposables.add(
        new Disposable(() => editor.element.removeEventListener("blur", commit)),
      );

      const removeButton = document.createElement("button");
      removeButton.className = "btn icon icon-x catalog-source-button";
      removeButton.setAttribute("aria-label", "Remove catalog");
      removeButton.onclick = () => this.removeCatalogSource(index);
      this.sourceDisposables.add(atom.tooltips.add(removeButton, { title: "Remove catalog" }));

      row.appendChild(editorContainer);
      row.appendChild(removeButton);
      this.refs.catalogSourcesList.appendChild(row);
    });
  }

  didClickAddCatalog() {
    const source = this.refs.catalogEditor.getText().trim();
    try {
      const normalized = normalizeCatalogSource(source);
      const sources = this.getCatalogSources();
      if (sources.some((existing) => normalizeCatalogSource(existing) === normalized)) {
        throw new Error("That catalog is already configured.");
      }
      atom.config.set("settings-view.communityPackageCatalogs", [...sources, source]);
      this.refs.catalogEditor.setText("");
    } catch (error) {
      this.showCatalogSourceError(error.message);
    }
  }

  didClickFetch() {
    this.catalogPromise = this.loadCatalog({ refresh: true });
  }

  didClickCancelFetch() {
    this.catalogClient.cancel();
    this.refs.catalogProgress.textContent += " · cancelling…";
    this.refs.cancelFetchButton.disabled = true;
  }

  didClickRestoreDefaults() {
    atom.config.unset("settings-view.communityPackageCatalogs");
    this.renderCatalogSources();
  }

  removeCatalogSource(index) {
    const sources = this.getCatalogSources();
    atom.config.set(
      "settings-view.communityPackageCatalogs",
      sources.filter((_source, sourceIndex) => sourceIndex !== index),
    );
  }

  updateCatalogSource(index, source) {
    const value = source.trim();
    try {
      const normalized = normalizeCatalogSource(value);
      const sources = this.getCatalogSources();
      if (
        sources.some(
          (existing, sourceIndex) =>
            sourceIndex !== index && normalizeCatalogSource(existing) === normalized,
        )
      ) {
        throw new Error("That catalog is already configured.");
      }
      const updated = [...sources];
      updated[index] = value;
      atom.config.set("settings-view.communityPackageCatalogs", updated);
    } catch (error) {
      this.renderCatalogSources();
      this.showCatalogSourceError(error.message);
    }
  }

  didClickOpenAtomIo(event) {
    event.preventDefault();
    atom.openExternal(this.atomIoURL);
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
};
