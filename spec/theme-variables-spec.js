const path = require("path");
const fs = require("fs");

const { THEME_VARIABLES, buildThemeVariablesStylesheet } = require("../src/theme-variables");
const { resolveBundledPackageDir, scanBundledPackageNames } = require("../src/bundled-packages");

// The public manifest owns defaults; the checked-in stylesheet is generated
// from it so normal startup does not need development tooling.
describe("the theme variable contract", () => {
  const repoRoot = path.join(__dirname, "..");
  const variablesDir = path.join(repoRoot, "static", "variables");
  // Bundled packages live wherever their pin delivers them, so resolve each
  // one instead of assuming a packages/ checkout.
  const packageDir = (name) => resolveBundledPackageDir(repoRoot, name);

  // Derive both lists from the bundled scan rather than naming packages here.
  // Which themes and which stylesheets ship is decided by the pins in
  // package.json, so a hardcoded list silently stops checking anything the
  // moment a package is unbundled.
  const bundledPackageNames = scanBundledPackageNames(repoRoot);
  const isThemePackage = (name) => {
    const dir = packageDir(name);
    if (!dir) return false;
    const manifestPath = path.join(dir, "package.json");
    if (!fs.existsSync(manifestPath)) return false;
    return Array.isArray(JSON.parse(fs.readFileSync(manifestPath, "utf8")).themes);
  };
  const themeNames = bundledPackageNames.filter(isThemePackage);
  // Every bundled package that actually ships a stylesheet. Listing names by
  // hand meant checking nothing when the named package shipped none.
  const packageStylePaths = bundledPackageNames
    .map((name) => [name, packageDir(name)])
    .filter(([, dir]) => dir && fs.existsSync(path.join(dir, "styles", "main.css")))
    .map(([name]) => `${name}/styles/main.css`);

  function cssCustomPropertyNames(fileName) {
    const source = fs.readFileSync(path.join(variablesDir, fileName), "utf8");
    const names = new Set();
    const declarationRegex = /--([\w-]+)\s*:/g;
    let match;
    while ((match = declarationRegex.exec(source)) !== null) {
      names.add(match[1]);
    }
    return names;
  }

  it("provides a CSS fallback in base-variables.css for every manifest variable", () => {
    const cssNames = cssCustomPropertyNames("base-variables.css");
    const manifestNames = THEME_VARIABLES.filter((variable) => variable.default !== null).map(
      (variable) => variable.name,
    );
    const missing = manifestNames.filter((name) => !cssNames.has(name));
    expect(missing).toEqual([]);
  });

  it("contains no duplicate public names", () => {
    const manifestNames = THEME_VARIABLES.map((variable) => variable.name);
    const duplicates = manifestNames.filter((name, index) => manifestNames.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });

  it("generates the complete fallback stylesheet from the public manifest", () => {
    const generated = fs.readFileSync(path.join(variablesDir, "base-variables.css"), "utf8");
    expect(generated.replace(/\s/g, "")).toBe(buildThemeVariablesStylesheet().replace(/\s/g, ""));
  });

  it("publishes immutable typed definitions and identifies runtime ownership", () => {
    const definitions = lumine.themes.getVariables();
    expect(definitions).toBe(THEME_VARIABLES);
    expect(Object.isFrozen(definitions)).toBe(true);
    const supportedTypes = ["color", "length", "number", "font-family", "line-height", "boolean"];
    for (const definition of definitions) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(supportedTypes).toContain(definition.type);
      expect(["semantic", "component", "runtime"]).toContain(definition.role);
      expect(["ui", "syntax", "editor"]).toContain(definition.owner);
      expect(definition.description.length).toBeGreaterThan(0);
      if (definition.role === "runtime") {
        expect(definition.owner).toBe("editor");
        expect(definition.scope).toBe("lumine-workspace");
        expect(definition.default).toBeNull();
      } else {
        expect(definition.scope).toBe(":root");
        expect(typeof definition.default).toBe("string");
      }
    }
    expect(
      definitions
        .filter((definition) => definition.role === "runtime")
        .map((definition) => definition.name),
    ).toEqual(["editor-font-family", "editor-font-size", "editor-line-height"]);
  });

  it("coalesces cascade updates and cancels queued notifications on disposal", async () => {
    const callback = jasmine.createSpy("variable change");
    const subscription = lumine.themes.onDidChangeVariables(callback);
    let first;
    let second;
    try {
      first = lumine.styles.addStyleSheet(":root { --text-color: red; }");
      second = lumine.styles.addStyleSheet(":root { --text-color: blue; }");
      await Promise.resolve();
      expect(callback).toHaveBeenCalledTimes(1);
      first.dispose();
      await Promise.resolve();
      expect(callback).toHaveBeenCalledTimes(2);
      second.dispose();
      subscription.dispose();
      await Promise.resolve();
      expect(callback).toHaveBeenCalledTimes(2);
    } finally {
      subscription.dispose();
      first?.dispose();
      second?.dispose();
    }
  });

  it("resolves every documented color and length to a usable CSS value", () => {
    const sheet = lumine.styles.addStyleSheet(buildThemeVariablesStylesheet(), { priority: 2 });
    const probe = document.createElement("span");
    probe.style.cssText = "display:block;color:rgb(1,2,3);font-size:13px;";
    jasmine.attachToDOM(probe);
    try {
      for (const definition of THEME_VARIABLES.filter((variable) => variable.default !== null)) {
        if (definition.type === "color") {
          probe.style.color = `var(--${definition.name}, rgb(1, 2, 3))`;
          const resolved = getComputedStyle(probe).color;
          expect(resolved).not.toBe("rgb(1, 2, 3)");
          expect(CSS.supports("color", resolved)).toBe(true);
          probe.style.color = "rgb(1, 2, 3)";
        } else if (definition.type === "length") {
          probe.style.width = `var(--${definition.name}, -1px)`;
          expect(Number.parseFloat(getComputedStyle(probe).width)).toBeGreaterThan(0);
        }
      }
    } finally {
      probe.remove();
      sheet.dispose();
    }
  });

  it("uses the selected and diagnostic foreground tokens in base buttons", () => {
    const sheet = lumine.styles.addStyleSheet(
      `:root {
      --button-text-color-selected: rgb(11, 22, 33);
      --text-color-on-success: rgb(22, 33, 44);
      --text-color-on-info: rgb(33, 44, 55);
      --text-color-on-warning: rgb(44, 55, 66);
      --text-color-on-error: rgb(55, 66, 77);
      --accent-foreground-color: rgb(66, 77, 88);
    }`,
      { priority: 2 },
    );
    const container = document.createElement("div");
    container.innerHTML =
      '<button class="btn selected"></button>' +
      ["success", "info", "warning", "error"]
        .map((status) => `<button class="btn btn-${status}"></button>`)
        .join("");
    container.innerHTML += ["success", "info", "warning", "error", "primary"]
      .map((status) => `<button class="btn btn-${status} selected active focus"></button>`)
      .join("");
    jasmine.attachToDOM(container);
    try {
      expect(
        Array.from(container.children).map((button) => getComputedStyle(button).color),
      ).toEqual([
        "rgb(11, 22, 33)",
        "rgb(22, 33, 44)",
        "rgb(33, 44, 55)",
        "rgb(44, 55, 66)",
        "rgb(55, 66, 77)",
        "rgb(22, 33, 44)",
        "rgb(33, 44, 55)",
        "rgb(44, 55, 66)",
        "rgb(55, 66, 77)",
        "rgb(66, 77, 88)",
      ]);
    } finally {
      container.remove();
      sheet.dispose();
    }
  });

  it("derives overlay documentation surfaces from the theme until explicitly overridden", () => {
    const defaults = lumine.styles.addStyleSheet(buildThemeVariablesStylesheet(), {
      priority: 2,
    });
    const container = document.createElement("div");
    container.innerHTML = '<span class="documentation"></span><span class="expected"></span>';
    const [documentation, expected] = container.children;
    documentation.style.backgroundColor = "var(--overlay-documentation-background-color)";
    jasmine.attachToDOM(container);
    let palette;
    let override;
    try {
      for (const [overlay, documentationColor] of [
        ["hsl(210, 25%, 80%)", "color(srgb 0.7 0.76 0.82)"],
        ["hsl(30, 50%, 20%)", "color(srgb 0.24 0.16 0.08)"],
      ]) {
        palette?.dispose();
        palette = lumine.styles.addStyleSheet(`:root { --overlay-background-color: ${overlay}; }`, {
          priority: 3,
        });
        expected.style.backgroundColor = documentationColor;
        expect(getComputedStyle(documentation).backgroundColor).toBe(
          getComputedStyle(expected).backgroundColor,
        );
      }

      override = lumine.styles.addStyleSheet(
        ":root { --overlay-documentation-background-color: rgb(11, 22, 33); }",
        { priority: 3 },
      );
      expect(getComputedStyle(documentation).backgroundColor).toBe("rgb(11, 22, 33)");
      palette.dispose();
      palette = null;
      expect(getComputedStyle(documentation).backgroundColor).toBe("rgb(11, 22, 33)");
    } finally {
      container.remove();
      override?.dispose();
      palette?.dispose();
      defaults.dispose();
    }
  });

  it("exposes shared data-grid tokens as component variables", () => {
    expect(
      THEME_VARIABLES.filter((variable) => variable.role === "component").map(
        (variable) => variable.name,
      ),
    ).toEqual(
      jasmine.arrayContaining([
        "data-grid-text-color",
        "data-grid-border-color",
        "data-grid-header-color",
        "data-grid-accent-color",
        "data-grid-row-height",
        "data-grid-header-height",
      ]),
    );
  });

  it("keeps package-owned variables out of the global theme contract", () => {
    const manifestNames = THEME_VARIABLES.map((variable) => variable.name);
    const cssNames = cssCustomPropertyNames("base-variables.css");
    const packagePrefixes = [
      "indent-guide-",
      "wrap-guide-",
      "terminal-",
      "settings-list-",
      "theme-config-",
    ];

    for (const prefix of packagePrefixes) {
      expect(manifestNames.filter((name) => name.startsWith(prefix))).toEqual([]);
      expect([...cssNames].filter((name) => name.startsWith(prefix))).toEqual([]);
    }
  });

  it("keeps package selectors out of bundled themes", () => {
    const removedOverrideFiles = [
      "styles/ui/09-messages.css",
      "styles/ui/23-settings.css",
      "styles/ui/24-packages.css",
      "styles/ui/25-core.css",
    ];
    const packageSelectorFragments = [
      ".wrap-guide",
      ".command-palette",
      "busy-signal",
      "AboutView",
      "TimecopView",
      "StyleguideView",
      "MarkdownPreviewView",
    ];
    const oldPackageVariables = [
      "--syntax-wrap-guide-color",
      "--syntax-indent-guide-color",
      "--settings-list-background-color",
      "--theme-config-box-shadow",
      "--theme-config-box-shadow-selected",
      "--theme-config-border-selected",
    ];

    for (const themeName of themeNames) {
      const themeDir = packageDir(themeName);
      for (const relativePath of removedOverrideFiles) {
        expect(fs.existsSync(path.join(themeDir, relativePath))).toBe(false);
      }

      const styleSources = fs
        .readdirSync(path.join(themeDir, "styles"), { recursive: true })
        .filter((relativePath) => relativePath.endsWith(".css"))
        .map((relativePath) => fs.readFileSync(path.join(themeDir, "styles", relativePath), "utf8"))
        .join("\n");

      for (const fragment of [...packageSelectorFragments, ...oldPackageVariables]) {
        expect(styleSources).not.toContain(fragment);
      }
    }
  });

  it("owns shared select-list presentation in the static UI layer", () => {
    const selectListSource = fs.readFileSync(
      path.join(__dirname, "..", "static", "lumine-ui", "styles", "select-list.css"),
      "utf8",
    );
    const textSource = fs.readFileSync(
      path.join(__dirname, "..", "static", "lumine-ui", "styles", "text.css"),
      "utf8",
    );
    const modalSource = fs.readFileSync(
      path.join(__dirname, "..", "static", "lumine-ui", "styles", "modals.css"),
      "utf8",
    );
    const redundantThemeFragments = [
      ".select-list .character-match",
      "--popover-list-padding",
      "max-height: min(70vh, calc(var(--ui-row-height) * 24))",
      ".select-list .key-binding",
      ".select-list .primary-line",
    ];

    expect(textSource).toContain(".character-match");
    expect(selectListSource).not.toContain(".character-match");
    expect(selectListSource).toContain("&:hover:not(.selected)");
    expect(selectListSource).toContain('> li.select-list-separator[role="separator"]');
    expect(selectListSource).toContain("height: 1px");
    expect(selectListSource).toContain("width: auto");
    // The horizontal inset is the part themes set; the vertical spacing next
    // to it is presentation this layer owns and is free to retune.
    expect(selectListSource).toContain("var(--select-list-separator-inset, 0)");
    expect(selectListSource).toContain("border-radius: 0");
    expect(selectListSource).toContain("background-color: var(--select-list-separator-color)");
    expect(selectListSource).toContain("--popover-list-padding");
    expect(modalSource).toContain("max-height: min(70vh, calc(var(--ui-row-height) * 24))");
    expect(modalSource).toContain(".select-list .key-binding");
    expect(modalSource).toContain(".select-list .primary-line");

    for (const relativePath of packageStylePaths) {
      const [packageName, ...rest] = relativePath.split("/");
      const packageRoot = packageDir(packageName);
      if (!packageRoot) continue;
      const packageStylePath = path.join(packageRoot, ...rest);
      // A path that has gone stale must fail here. Reading it as an empty
      // string would let this pass having checked nothing.
      expect(fs.existsSync(packageStylePath)).toBe(true);
      const packageSource = fs.readFileSync(packageStylePath, "utf8");
      expect(packageSource).not.toContain(".character-match");
    }

    for (const themeName of themeNames) {
      const stylesDir = path.join(packageDir(themeName), "styles");
      const themeSource = fs
        .readdirSync(stylesDir, { recursive: true })
        .filter((relativePath) => relativePath.endsWith(".css"))
        .map((relativePath) => fs.readFileSync(path.join(stylesDir, relativePath), "utf8"))
        .join("\n");

      for (const fragment of redundantThemeFragments) {
        expect(themeSource).not.toContain(fragment);
      }
    }
  });
});
