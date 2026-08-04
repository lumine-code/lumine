// Displays the readme for a package, if it has one
// TODO Decide to keep this or current button-to-new-tab view
module.exports = class PackageReadmeView {
  constructor(readme, readmeSrc, readmeIsLocal) {
    this.element = document.createElement("section");
    this.element.classList.add("section");

    const container = document.createElement("div");
    container.classList.add("section-container");

    const heading = document.createElement("div");
    heading.classList.add("section-heading", "icon", "icon-book");
    heading.textContent = "README";
    container.appendChild(heading);

    this.packageReadme = document.createElement("div");
    this.packageReadme.classList.add("package-readme", "native-key-bindings");
    this.packageReadme.tabIndex = -1;
    container.appendChild(this.packageReadme);
    this.element.appendChild(container);

    readme ||= "### No README.";

    const markdownOpts = {
      breaks: false,
      taskCheckboxDisabled: true,
      useGitHubHeadings: true,
    };

    if (readmeIsLocal) {
      markdownOpts.filePath = readmeSrc;
    } else {
      markdownOpts.rootDomain = readmeSrc;
    }

    try {
      this.packageReadme.innerHTML = atom.tools.markdown.render(readme, markdownOpts);
    } catch {
      this.packageReadme.innerHTML = "<h3>Error parsing README</h3>";
    }

    if (!readmeIsLocal) {
      for (const image of this.packageReadme.querySelectorAll("img")) {
        const source = image.getAttribute("src") || "";
        if (/^https?:\/\//i.test(source)) {
          image.setAttribute("data-external-src", source);
          image.removeAttribute("src");
          image.classList.add("external-image-blocked");
          image.title = "External image blocked";
        }
      }
    }

    // Lumine's global link handler prevents native fragment navigation.
    this.handleAnchorClick = (event) => {
      const anchor = event.target.closest('a[href^="#"]');
      if (anchor == null) return;

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
        this.packageReadme.querySelector(`[id="${CSS.escape(prefixedId)}"]`) ??
        this.packageReadme.querySelector(`[id="${CSS.escape(id)}"]`);
      if (target == null) return;

      event.preventDefault();
      target.scrollIntoView();
    };
    this.packageReadme.addEventListener("click", this.handleAnchorClick);
  }

  destroy() {
    this.packageReadme.removeEventListener("click", this.handleAnchorClick);
    this.element.remove();
  }
};
