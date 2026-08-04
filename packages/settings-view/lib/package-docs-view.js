const path = require("path");

const fs = require("@lumine-code/fs-plus");

// Displays the markdown documents a package ships in `docs/`.
//
// These are the contracts of the services the package owns. They belong to the
// package that defines them rather than to any central reference, so this is
// where they are read: from the installed copy on disk, in the package's own
// detail view.
module.exports = class PackageDocsView {
  constructor(packagePath) {
    this.element = document.createElement("section");
    this.element.classList.add("section");

    const container = document.createElement("div");
    container.classList.add("section-container");

    const heading = document.createElement("div");
    heading.classList.add("section-heading", "icon", "icon-file-text");
    heading.textContent = "Documentation";
    container.appendChild(heading);

    this.packageDocs = document.createElement("div");
    this.packageDocs.classList.add("package-docs", "native-key-bindings");
    this.packageDocs.tabIndex = -1;
    container.appendChild(this.packageDocs);
    this.element.appendChild(container);

    for (const file of documentFiles(packagePath)) {
      this.appendDocument(file);
    }

    // Lumine's global link handler prevents native fragment navigation.
    //
    // Every contract document uses the same headings, so `#contract` exists once
    // per file and the ids collide across them. Resolving inside the document
    // that was clicked is what keeps a link pointing at its own section.
    this.handleAnchorClick = (event) => {
      const anchor = event.target.closest('a[href^="#"]');
      if (anchor == null) return;

      const scope = anchor.closest(".package-doc");
      if (scope == null) return;

      let id = anchor.getAttribute("href").slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // Fall back to the raw fragment.
      }
      if (!id) return;

      // Prefer generated heading ids over colliding raw ids.
      const prefixedId = `user-content-${id}`;
      const target =
        scope.querySelector(`[id="${CSS.escape(prefixedId)}"]`) ??
        scope.querySelector(`[id="${CSS.escape(id)}"]`);
      if (target == null) return;

      event.preventDefault();
      target.scrollIntoView();
    };
    this.packageDocs.addEventListener("click", this.handleAnchorClick);
  }

  appendDocument(file) {
    let source;
    try {
      source = fs.readFileSync(file, { encoding: "utf8" });
    } catch {
      return;
    }

    const element = document.createElement("div");
    element.classList.add("package-doc");
    element.dataset.docFile = path.basename(file);

    try {
      element.innerHTML = atom.tools.markdown.render(source, {
        breaks: false,
        taskCheckboxDisabled: true,
        useGitHubHeadings: true,
        filePath: file,
      });
    } catch {
      element.innerHTML = `<h3>Error parsing ${path.basename(file)}</h3>`;
    }

    this.packageDocs.appendChild(element);
  }

  destroy() {
    this.packageDocs.removeEventListener("click", this.handleAnchorClick);
    this.element.remove();
  }
};

// The markdown a package ships in `docs/`, read in file-name order. That order is
// the only one there is, so a package that wants a particular reading order says
// so by numbering its files — `1_overview.md`, `2_contract.md`. The number never
// shows: each document is listed by its own headers. `listSync` returns nothing
// for a path that is not a directory, so a package without `docs/` simply has no
// documents.
function documentFiles(packagePath) {
  if (!packagePath) return [];
  return fs.listSync(path.join(packagePath, "docs"), ["md"]);
}
