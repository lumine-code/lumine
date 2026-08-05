/** @jsx etch.dom */
const etch = require("@lumine-code/etch");
const _ = require("@lumine-code/underscore-plus");
const { Disposable, CompositeDisposable } = require("atom");
const { getSettingDescription } = require("./rich-description");
const { getSettingTitle } = require("./rich-title");

module.exports = class SearchSettingView {
  constructor(setting, settingsView, query = "") {
    this.settingsView = settingsView;
    this.setting = setting;
    this.query = query;
    this.disposables = new CompositeDisposable();

    etch.initialize(this);
    this.handleButtonEvents();
  }

  render() {
    const pathSegments = this.setting.path.split(".");
    const settingName = pathSegments[pathSegments.length - 1];
    const title = getSettingTitle(this.setting.path, settingName);
    const namespace = pathSegments[0];
    const namespaceLabel = this.getNamespaceLabel(namespace);
    const icon = this.getIcon(namespace);
    const description = getSettingDescription(this.setting.path);
    // Recently-opened entries reuse this card but were never scored, so there is
    // no rank to report for them.
    const metadata =
      this.setting.rank && atom.config.get("settings-view.searchSettingsMetadata")
        ? `${this.setting.rank.totalScore.toFixed(2)} search score`
        : "";

    return (
      <div className="search-result" role="listitem">
        <a ref="settingLink" className="search-result-link" href={this.getDestinationURI()}>
          <span className="search-result-heading">
            <span className="search-result-title">{this.highlightText(title)}</span>
            <span className="search-package-name">
              <span className={icon} />
              {namespaceLabel}
            </span>
          </span>
          <span className="search-id">
            {this.highlightText(this.setting.path)}
            {metadata ? ` · ${metadata}` : ""}
          </span>
        </a>
        {description ? <span className="search-description" innerHTML={description} /> : null}
      </div>
    );
  }

  update() {}

  destroy() {
    this.disposables.dispose();
    return etch.destroy(this);
  }

  getNamespaceLabel(namespace) {
    switch (namespace) {
      case "core":
        return "Core";
      case "editor":
        return "Editor";
      case "language":
        return "Language";
      case "git":
        return "Git";
      default:
        return _.undasherize(_.uncamelcase(namespace));
    }
  }

  getDestinationURI() {
    const path = this.setting.path;
    if (path === "core.themes") return "lumine://config/themes";
    if (path === "core.disabledPackages") return "lumine://config/packages";
    if (path === "core.uriHandlerRegistration") return "lumine://config/uri-handling";

    const namespace = path.split(".")[0];
    if (namespace === "core") return "lumine://config/core";
    if (namespace === "editor") return "lumine://config/editor";
    if (namespace === "language") return "lumine://config/language";
    if (namespace === "git") return "lumine://config/git";
    return `lumine://config/packages/${namespace}`;
  }

  highlightText(text) {
    if (!text || !this.query) return text || "";
    const terms = this.query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (terms.length === 0) return text;

    const expression = new RegExp(`(${terms.map(this.escapeRegExp).join("|")})`, "ig");
    return text.split(expression).map((part, index) => {
      const matched = terms.some((term) => term.toLowerCase() === part.toLowerCase());
      return matched ? <mark key={index}>{part}</mark> : part;
    });
  }

  escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  getIcon(namespace) {
    switch (namespace) {
      case "core":
        return "icon icon-settings search-result-icon";
      case "editor":
        return "icon icon-code search-result-icon";
      case "language":
        return "icon icon-globe search-result-icon";
      case "git":
        return "icon icon-git-branch search-result-icon";
      default:
        return "icon icon-package search-result-icon";
    }
  }

  handleButtonEvents() {
    const settingsClickHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.settingsView && typeof this.settingsView.openSetting === "function") {
        this.settingsView.openSetting(this.setting.path);
      } else {
        atom.workspace.open(this.getDestinationURI());
      }
    };

    this.refs.settingLink.addEventListener("click", settingsClickHandler);
    this.disposables.add(
      new Disposable(() => {
        this.refs.settingLink.removeEventListener("click", settingsClickHandler);
      }),
    );
  }
};
