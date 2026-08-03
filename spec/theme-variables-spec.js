const path = require("path");
const fs = require("fs");

const { UI_VARIABLES, UI_VARIABLES_EXTENDED, SYNTAX_VARIABLES } = require("../src/theme-variables");

// The theme variable contract exists in three places that must stay in sync:
// the manifest in src/theme-variables.js, the legacy Less fallbacks in
// static/variables/*.less, and the CSS custom-property fallbacks in
// static/variables/base-variables.css.
describe("the theme variable contract", () => {
  const variablesDir = path.join(__dirname, "..", "static", "variables");
  const packagesDir = path.join(__dirname, "..", "packages");

  function lessVariableNames(fileName) {
    const source = fs.readFileSync(path.join(variablesDir, fileName), "utf8");
    const names = [];
    const definitionRegex = /^\s*@([\w-]+)\s*:/gm;
    let match;
    while ((match = definitionRegex.exec(source)) !== null) {
      names.push(match[1]);
    }
    return names;
  }

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

  it("defines the same UI variable names in the manifest and ui-variables.less", () => {
    const lessNames = lessVariableNames("ui-variables.less");
    expect([...lessNames].sort()).toEqual([...UI_VARIABLES].sort());
  });

  it("defines the same syntax variable names in the manifest and syntax-variables.less", () => {
    const lessNames = lessVariableNames("syntax-variables.less");
    expect([...lessNames].sort()).toEqual([...SYNTAX_VARIABLES].sort());
  });

  it("provides a CSS fallback in base-variables.css for every manifest variable", () => {
    const cssNames = cssCustomPropertyNames("base-variables.css");
    const manifestNames = [...UI_VARIABLES, ...UI_VARIABLES_EXTENDED, ...SYNTAX_VARIABLES];
    const missing = manifestNames.filter((name) => !cssNames.has(name));
    expect(missing).toEqual([]);
  });

  it("contains no duplicate names within or across the manifest lists", () => {
    const manifestNames = [...UI_VARIABLES, ...UI_VARIABLES_EXTENDED, ...SYNTAX_VARIABLES];
    const duplicates = manifestNames.filter((name, index) => manifestNames.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });

  it("keeps package-owned variables out of the global theme contract", () => {
    const manifestNames = [...UI_VARIABLES, ...UI_VARIABLES_EXTENDED, ...SYNTAX_VARIABLES];
    const lessNames = [
      ...lessVariableNames("ui-variables.less"),
      ...lessVariableNames("syntax-variables.less"),
    ];
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
      expect(lessNames.filter((name) => name.startsWith(prefix))).toEqual([]);
      expect([...cssNames].filter((name) => name.startsWith(prefix))).toEqual([]);
    }
  });

  it("keeps package selectors out of bundled themes", () => {
    const themeNames = ["one-theme", "aura-theme", "nova-theme", "vscode-theme"];
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
      const themeDir = path.join(packagesDir, themeName);
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
      path.join(__dirname, "..", "static", "atom-ui", "styles", "select-list.css"),
      "utf8",
    );
    const textSource = fs.readFileSync(
      path.join(__dirname, "..", "static", "atom-ui", "styles", "text.css"),
      "utf8",
    );
    const modalSource = fs.readFileSync(
      path.join(__dirname, "..", "static", "atom-ui", "styles", "modals.css"),
      "utf8",
    );
    const packageStylePaths = [
      "fuzzy-files/styles/fuzzy-files.css",
      "command-palette/styles/command-palette.css",
      "symbols-view/styles/symbols-view.css",
      "autocomplete/styles/autocomplete.css",
    ];
    const themeNames = ["one-theme", "aura-theme", "nova-theme", "vscode-theme"];
    const redundantThemeFragments = [
      ".select-list .character-match",
      "--popover-list-padding",
      "max-height: min(70vh, calc(var(--ui-line-height) * 24))",
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
    expect(modalSource).toContain("max-height: min(70vh, calc(var(--ui-line-height) * 24))");
    expect(modalSource).toContain(".select-list .key-binding");
    expect(modalSource).toContain(".select-list .primary-line");

    for (const relativePath of packageStylePaths) {
      const packageStylePath = path.join(packagesDir, relativePath);
      const packageSource = fs.existsSync(packageStylePath)
        ? fs.readFileSync(packageStylePath, "utf8")
        : "";
      expect(packageSource).not.toContain(".character-match");
    }

    for (const themeName of themeNames) {
      const stylesDir = path.join(packagesDir, themeName, "styles");
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
