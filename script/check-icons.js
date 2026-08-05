// Verifies the icon geometry contract stays uncontested by the bundled UI
// themes. The contract (static/atom-ui/styles/icons.css) makes core the only
// owner of icon box geometry: themes own row metrics (container line-height,
// heights, margins) and colors, never the internals of an `.icon` ::before.
// A theme that re-declares a geometry property there silently re-splits icon
// alignment per surface — exactly the bug the contract removed — so this
// check fails the build on any such declaration.
//
//   node script/check-icons.js
//
// Scans styles/ui/*.css of every bundled theme package. Only `margin*`,
// `padding*`, `color`, and other non-geometry declarations are allowed in a
// rule whose selector targets an `.icon` (or `.title`) ::before.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// The properties that place or size a glyph. `width` is deliberately included:
// a per-surface width re-introduces per-font advance drift. Escape hatches
// belong in package stylesheets (status-bar keeps `width: auto` there), not in
// themes.
const GEOMETRY =
  /^(line-height|vertical-align|height|width|top|bottom|left|right|font-size|position|translate|transform)$/;

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

// A tolerant scanner for the flat, hand-written CSS these themes use: tracks
// nesting to reconstruct each rule's full selector chain, then inspects the
// declarations of any rule whose resolved selector ends in an icon ::before.
function* iconBeforeRules(css) {
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
      stack.push({ selector: buffer.trim(), declarations: "" });
      buffer = "";
    } else if (char === "}") {
      const rule = stack.pop();
      if (rule) {
        const chain = [...stack.map((entry) => entry.selector), rule.selector];
        yield { chain, declarations: rule.declarations + buffer };
      }
      buffer = "";
    } else {
      buffer += char;
    }
    index += 1;
  }
}

// The contract's `text-bottom` anchors the glyph box to its host element's
// content area, so a theme relocating the *element* — vertical-align, its own
// line box, a position offset — moves every icon with it just as surely as
// restyling the ::before. The status bar's icons sat 2px low behind exactly
// one such rule (`.icon { vertical-align: middle }`). Element font-size stays
// legal: on compounds like `.badge.icon` it is the component's typography.
const ELEMENT_GEOMETRY =
  /^(vertical-align|line-height|position|top|bottom|left|right|height|translate|transform)$/;

// `-` is a valid class character, so a word boundary is not a class boundary:
// `\.title\b` also matches `.title-bar`, whose ::before is a menu highlight and
// no icon at all. Match a whole class name instead.
const ICON_CLASS = /\.icon(?:-[\w-]+)?(?![\w-])/;
const TITLE_CLASS = /\.title(?![\w-])/;

function targetsIconBefore(chain) {
  // The rule's own selector must reach a ::before, and some link of the chain
  // must scope it to an icon element. `.title` counts: in tabs the icon glyph
  // renders through the title's ::before.
  const selector = chain[chain.length - 1];
  if (!/::?before\b/.test(selector)) return false;
  return chain.some((link) => ICON_CLASS.test(link) || TITLE_CLASS.test(link));
}

function targetsIconElement(chain) {
  // An element rule whose subject is an icon class itself, rather than a
  // pseudo-element rule, which the ::before check owns.
  const selector = chain[chain.length - 1];
  if (/::?(?:before|after)\b/.test(selector)) return false;
  return ICON_CLASS.test(selector);
}

function findViolations(file) {
  const css = fs.readFileSync(file, "utf8");
  const violations = [];
  for (const { chain, declarations } of iconBeforeRules(css)) {
    const pattern = targetsIconBefore(chain)
      ? GEOMETRY
      : targetsIconElement(chain)
        ? ELEMENT_GEOMETRY
        : null;
    if (!pattern) continue;
    for (const declaration of declarations.split(";")) {
      const property = declaration.split(":")[0]?.trim();
      if (property && pattern.test(property)) {
        violations.push({
          selector: chain.filter(Boolean).join(" "),
          property,
        });
      }
    }
  }
  return violations;
}

// Every stylesheet a theme ships, at any depth. Themes lay their sheets out
// differently — `styles/ui/` for the ones that own a full UI, `ui-overrides/`
// for the ones that layer on another — so keying on one folder name silently
// stops checking a theme the day it is restructured.
function* stylesheets(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* stylesheets(full);
    else if (entry.name.endsWith(".css")) yield full;
  }
}

function main() {
  const errors = [];
  let scanned = 0;
  for (const stylesDir of themeDirs()) {
    for (const file of stylesheets(stylesDir)) {
      scanned++;
      for (const violation of findViolations(file)) {
        errors.push(
          `${path.relative(ROOT, file)}: "${violation.selector}" declares ` +
            `${violation.property} — icon box geometry is owned by the core contract ` +
            `(static/atom-ui/styles/icons.css); themes own row metrics only`,
        );
      }
    }
  }

  for (const error of errors) console.error(`error: ${error}`);
  console.log(
    `icon contract: ${themeDirs().length} theme packages, ${scanned} stylesheets scanned, ` +
      `${errors.length} error(s)`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
