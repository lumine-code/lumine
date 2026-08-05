const postcss = require("postcss");
const selectorParser = require("postcss-selector-parser");
const DEPRECATED_SYNTAX_SELECTORS = require("./deprecated-syntax-selectors");

// Compatibility shims for style sheets authored as Less against older editors.
// `StyleManager` runs these over a style sheet whose source path is a `.less`
// file, and never over hand-authored CSS — the math shim in particular can
// mangle data: URIs and modern CSS functions.

function transformDeprecatedShadowDOMSelectors(css, context) {
  const transformedSelectors = [];
  let transformedSource;
  try {
    transformedSource = postcss.parse(css);
  } catch {
    transformedSource = null;
  }

  if (transformedSource) {
    transformedSource.walkRules((rule) => {
      const transformedSelector = selectorParser((selectors) => {
        selectors.each((selector) => {
          const firstNode = selector.nodes[0];
          if (
            context === "atom-text-editor" &&
            firstNode.type === "pseudo" &&
            firstNode.value === ":host"
          ) {
            const atomTextEditorElementNode = selectorParser.tag({
              value: "atom-text-editor",
            });
            firstNode.replaceWith(atomTextEditorElementNode);
          }

          let previousNodeIsAtomTextEditor = false;
          let targetsAtomTextEditorShadow = context === "atom-text-editor";
          let previousNode;
          selector.each((node) => {
            if (targetsAtomTextEditorShadow && node.type === "class") {
              if (DEPRECATED_SYNTAX_SELECTORS.has(node.value)) {
                node.value = `syntax--${node.value}`;
              }
            } else {
              if (
                previousNodeIsAtomTextEditor &&
                node.type === "pseudo" &&
                node.value === "::shadow"
              ) {
                node.type = "className";
                node.value = ".editor";
                targetsAtomTextEditorShadow = true;
              }
            }
            previousNode = node;
            if (node.type === "combinator") {
              previousNodeIsAtomTextEditor = false;
            } else if (previousNode.type === "tag" && previousNode.value === "atom-text-editor") {
              previousNodeIsAtomTextEditor = true;
            }
          });
        });
      }).processSync(rule.selector, { lossless: true });
      if (transformedSelector !== rule.selector) {
        transformedSelectors.push({
          before: rule.selector,
          after: transformedSelector,
        });
        rule.selector = transformedSelector;
      }
    });

    let deprecationMessage;
    if (transformedSelectors.length > 0) {
      deprecationMessage =
        "The contents of `atom-text-editor` elements are not encapsulated within a shadow " +
        "DOM boundary, so the `:host` and `::shadow` pseudo-selectors match nothing and " +
        "every syntax selector needs a `syntax--` prefix. To keep this style sheet " +
        "working, Lumine rewrote the following selectors:\n\n" +
        transformedSelectors
          .map((selector) => `* \`${selector.before}\` => \`${selector.after}\``)
          .join("\n\n") +
        "\n\nThis rewrite is a compatibility shim for style sheets written against older " +
        "editors. Please update the selectors above at their source.";
    }
    return { source: transformedSource.toString(), deprecationMessage };
  } else {
    // CSS was malformed so we don't transform it.
    return { source: css };
  }
}

function transformDeprecatedMathUsage(css, _context) {
  const transformedProperties = [];
  let transformedSource;

  // Some CSS keys **do** have very valid usage of `/` that might trigger a false
  // positive of this regex, without any easy way to detect it as such.
  // In those cases, it may be safer to ignore the key totally, as some broken
  // UI because of an outdated community package, is better than breaking valid
  // less style sheets.
  const cssKeyIgnoreList = ["font", "background", "grid-column", "cursor", "aspect-ratio"];
  // There are certain functions that may be used within a CSS value, where `/`
  // or other mathematical expressions are valid, and we do not want to modify.
  // In those cases, if we find the existence of that function within, then we
  // stop modifying that value completely.
  const cssValueIgnoreList = /hsl|abs|acos|asin|atan|atan2|cos|mod|rem|sign|sin|tan|url/g;

  const mathExpressionRegex =
    /(-*(\d(\.\d)?)+(cm|mm|Q|in|pc|pt|px|em|ex|ch|rem|lh|rlh|vw|vh|vmin|vmax|vb|vi|svw|svh|lvw|lvh|dvw|dvh|%)?|@?[\w-]+)(\s*([/+*]|(-\s+))\s*((\d(\.\d)*)+(cm|mm|Q|in|pc|pt|px|em|ex|ch|rem|lh|rlh|vw|vh|vmin|vmax|vb|vi|svw|svh|lvw|lvh|dvw|dvh|%)?|@?[\w-]+))+/g;

  try {
    transformedSource = postcss.parse(css);
  } catch {
    transformedSource = null;
  }

  if (transformedSource) {
    transformedSource.walkRules((rule) => {
      rule.each((node) => {
        if (
          typeof node.value === "string" &&
          !cssKeyIgnoreList.includes(node.prop) &&
          !cssValueIgnoreList.test(node.value)
        ) {
          let containsMath = node.value.match(mathExpressionRegex);

          if (containsMath !== null) {
            let nodeOriginal = node.value;
            let appliedChanges = false;
            for (let i = 0; i < containsMath.length; i++) {
              let match = containsMath[i];
              if (!node.value.includes(`calc(${match})`)) {
                node.value = node.value.replace(match, `calc(${match})`);
                appliedChanges = true;
              }
            }
            if (appliedChanges) {
              transformedProperties.push({
                property: node.prop,
                valueBefore: nodeOriginal,
                valueAfter: node.value,
              });
            }
          }
        }
      });
    });

    let deprecationMessage;
    if (transformedProperties.length > 0) {
      deprecationMessage =
        "Lumine transpiles Less style sheets with Less 4, where parens-division is the " +
        "default math setting, so every division has to be wrapped in parentheses. To " +
        "keep this style sheet working, Lumine wrapped the expressions Less left " +
        "unevaluated in `calc()`:\n\n" +
        transformedProperties
          .map(
            (prop) => `* \`${prop.property}\`: \`${prop.valueBefore}\` => \`${prop.valueAfter}\``,
          )
          .join("\n\n") +
        "\n\nThis rewrite is a compatibility shim. Please update the expressions above at " +
        "their source.";
    }
    return { source: transformedSource.toString(), deprecationMessage };
  } else {
    // CSS was malformed, so we don't transform it.
    return { source: css };
  }
}

module.exports = {
  transformDeprecatedShadowDOMSelectors,
  transformDeprecatedMathUsage,
};
