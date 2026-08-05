/** @jsx etch.dom */
const { CompositeDisposable } = require("atom");
const etch = require("@lumine-code/etch");

const PackageCard = require("./package-card");

// Lists the installed Git packages that have a newer version available (from
// their install receipts, not the catalog). This is its own panel rather than a
// filter on the Install tab.
module.exports = class UpdatesPanel {
  constructor(settingsView, packageManager) {
    etch.initialize(this);
    this.settingsView = settingsView;
    this.packageManager = packageManager;
    this.packageCards = [];

    this.subscriptions = new CompositeDisposable();
    // A finished install/update/uninstall changes what is outdated, so re-check.
    this.subscriptions.add(
      this.packageManager.on(
        "package-installed theme-installed package-updated theme-updated package-uninstalled theme-uninstalled",
        () => this.loadUpdates(),
      ),
    );

    this.subscriptions.add(
      atom.commands.add(this.element, {
        "core:move-up": () => this.scrollUp(),
        "core:move-down": () => this.scrollDown(),
        "core:page-up": () => this.pageUp(),
        "core:page-down": () => this.pageDown(),
        "core:move-to-top": () => this.scrollToTop(),
        "core:move-to-bottom": () => this.scrollToBottom(),
      }),
    );

    this.loadPromise = this.loadUpdates();
  }

  render() {
    return (
      <div className="panels-item" tabIndex="-1">
        <section className="section">
          <div className="section-container">
            <div className="section-heading icon icon-cloud-download">
              Available Updates
              <span ref="updateCount" className="section-heading-count badge badge-flexible">
                …
              </span>
              <button
                type="button"
                className="icon-sync section-heading-refresh"
                title="Check for updates"
                onclick={() => this.loadUpdates()}
              />
            </div>
            <div ref="updatesContainer" className="container package-container" />
            <div ref="statusMessage" className="alert alert-info icon icon-hourglass">
              Checking installed packages for updates…
            </div>
          </div>
        </section>
      </div>
    );
  }

  async loadUpdates() {
    if (this.loading) return;
    this.loading = true;
    this.clearCards();
    this.refs.updateCount.textContent = "…";
    this.refs.statusMessage.textContent = "Checking installed packages for updates…";
    this.refs.statusMessage.style.display = "";

    const generation = (this.generation = (this.generation || 0) + 1);
    try {
      const packs = await this.packageManager.getGitPackageUpdates();
      if (generation !== this.generation) return;
      this.clearCards();
      for (const pack of packs) {
        const card = new PackageCard(pack, this.settingsView, this.packageManager, {
          back: "Update",
        });
        this.packageCards.push(card);
        const row = document.createElement("div");
        row.classList.add("row");
        row.appendChild(card.element);
        this.refs.updatesContainer.appendChild(row);
      }
      this.refs.updateCount.textContent = String(packs.length);
      this.refs.statusMessage.textContent = packs.length
        ? ""
        : "All installed packages are up to date.";
      this.refs.statusMessage.style.display = packs.length ? "none" : "";
    } finally {
      this.loading = false;
    }
  }

  clearCards() {
    while (this.packageCards.length) this.packageCards.pop().destroy();
    this.refs.updatesContainer.innerHTML = "";
  }

  focus() {
    this.element.focus();
  }

  show() {
    this.element.style.display = "";
  }

  update() {}

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

  destroy() {
    this.clearCards();
    this.subscriptions.dispose();
    return etch.destroy(this);
  }
};
