// Verifies no bundled UI theme styles an editor by where it happens to sit.
//
// A UI editor is one that is a form control rather than a document, and it
// says so on the element: `lumine-text-editor[input]`, which `[mini]` implies.
// Themes used to guess instead, with `lumine-panel-container lumine-text-editor`
// — a selector that matches every dock (PanelContainerElement appends the
// dock element, src/panel-container-element.js) but no centre pane and no
// overlay. Two identical expression editors therefore looked different purely
// because one panel docked right and the other opened in the centre, while
// read-only diff viewers picked up an input ring for no reason but position.
//
//   node script/check-editors.js
//
// Scans every stylesheet of every bundled UI theme and fails on any rule that
// reaches an `lumine-text-editor` through a panel container. Structural panel
// rules that never mention an editor are fine and are what the second half of
// the check allows for.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function themeDirs() {
  const { scanBundledPackageNames, resolveBundledPackageDir } = require("../src/bundled-packages");
  return scanBundledPackageNames(ROOT)
    .map((name) => resolveBundledPackageDir(ROOT, name))
    .filter(Boolean)
    .filter((dir) => {
      const { themes } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      return Array.isArray(themes) && themes.some((theme) => theme.theme === "ui");
    })
    .map((dir) => path.join(dir, "styles"));
}

// The same tolerant scanner check-icons.js uses: track nesting so a rule's
// full selector chain is reconstructed, since `&` and plain nesting both hide
// the ancestor half of a selector from a flat grep.
function* rules(css) {
  const stack = [];
  let index = 0;
  let buffer = "";
  while (index < css.length) {
    const char = css[index];
    if (char === "/" && css[index + 1] === "*") {
      index = css.indexOf("*/", index + 2);
      index = index === -1 ? css.length : index + 2;
      continue;
    }
    if (char === "{") {
      stack.push({ selector: buffer.trim() });
      buffer = "";
    } else if (char === "}") {
      const rule = stack.pop();
      if (rule) yield [...stack.map((entry) => entry.selector), rule.selector];
      buffer = "";
    } else {
      buffer += char;
    }
    index += 1;
  }
}

// A violation needs both halves in one chain: a panel container somewhere in
// the ancestry, and an editor as the thing being styled.
function violates(chain) {
  const gated = chain.some((link) => /lumine-panel-container/.test(link));
  if (!gated) return false;
  return chain.some((link) => /lumine-text-editor/.test(link));
}

function* stylesheets(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* stylesheets(full);
    else if (entry.name.endsWith(".css")) yield full;
  }
}

function main() {
  const dirs = themeDirs();
  const errors = [];
  let scanned = 0;
  for (const stylesDir of dirs) {
    for (const file of stylesheets(stylesDir)) {
      scanned++;
      const css = fs.readFileSync(file, "utf8");
      for (const chain of rules(css)) {
        if (!violates(chain)) continue;
        errors.push(
          `${path.relative(ROOT, file)}: "${chain.filter(Boolean).join(" ")}" reaches an ` +
            `editor through a panel container — style lumine-text-editor[input] instead, ` +
            `so the same editor looks the same wherever its panel sits`,
        );
      }
    }
  }

  for (const error of errors) console.error(`error: ${error}`);
  console.log(
    `editor contract: ${dirs.length} theme packages, ${scanned} stylesheets scanned, ` +
      `${errors.length} error(s)`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
