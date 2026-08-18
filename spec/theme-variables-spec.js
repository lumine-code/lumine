const path = require("path");
const fs = require("fs");

const { UI_VARIABLES, UI_VARIABLES_EXTENDED, SYNTAX_VARIABLES } = require("../src/theme-variables");
const { resolveBundledPackageDir } = require("../src/bundled-packages");

// The theme variable contract exists in two places that must stay in sync:
// the manifest in src/theme-variables.js and the CSS custom-property fallbacks
// in static/variables/base-variables.css.
describe("the theme variable contract", () => {
  const repoRoot = path.join(__dirname, "..");
  const variablesDir = path.join(repoRoot, "static", "variables");
  // Bundled packages live wherever their pin delivers them, so resolve each
  // one instead of assuming a packages/ checkout.
  const packageDir = (name) => resolveBundledPackageDir(repoRoot, name);

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
    // Only packages that actually ship a stylesheet. fuzzy-files and
    // command-palette were listed here and ship none, so they were checking
    // nothing.
    const packageStylePaths = ["symbol/styles/main.css", "autocomplete/styles/main.css"];
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
