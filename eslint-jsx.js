/**
 * The JSX rules the editor's packages need and eslint-plugin-react cannot
 * supply: it still caps its peer range at eslint 9, and the fleet is on 10.
 *
 * `require-pragma` makes every file that contains JSX name its own factory, so
 * what a tag compiles to is readable in the file rather than inherited from a
 * Babel option in another repository.
 *
 * `jsx-uses` then stands in for `jsx-uses-react` and `jsx-uses-vars`, which do
 * nothing but tell `no-unused-vars` that a tag counts as a reference — to the
 * component it names, and to the factory. It reads the factory out of the same
 * pragma, so it takes no options and holds no default: a file that says
 * `etch.dom` marks `etch`, one that says `React.createElement` marks `React`,
 * and a package mixing the two needs no configuration to get both right.
 */

// Babel accepts the pragma in any leading comment, as `@jsx <expression>`.
const PRAGMA = /@jsx\s+([^\s*]+)/;
const PRAGMA_FRAG = /@jsxFrag\s+([^\s*]+)/;

function readPragma(sourceCode, pattern) {
  for (const comment of sourceCode.getAllComments()) {
    const match = pattern.exec(comment.value);
    if (match) return match[1];
  }
  return null;
}

// `etch.dom` hangs off `etch`, and that root is the identifier an import binds.
function rootOf(expression) {
  return expression.split(".")[0];
}

// `<Foo />` references `Foo`; `<a.b.c />` references `a`; `<div />` is an
// intrinsic element and resolves to no variable at all.
function rootIdentifier(name) {
  let node = name;
  while (node && node.type === "JSXMemberExpression") node = node.object;
  return node && node.type === "JSXIdentifier" ? node : null;
}

const requirePragma = {
  meta: {
    type: "problem",
    docs: { description: "Require every file containing JSX to name its own JSX factory." },
    schema: [],
    messages: {
      missing:
        "This file contains JSX but declares no `/** @jsx ... */` pragma, so its tags compile to whatever factory the build happens to default to.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    let reported = false;

    function check(node) {
      if (reported || readPragma(sourceCode, PRAGMA)) return;
      reported = true;
      context.report({ node, messageId: "missing" });
    }

    return { JSXOpeningElement: check, JSXOpeningFragment: check };
  },
};

const jsxUses = {
  meta: {
    type: "problem",
    docs: { description: "Count JSX tags as references to the identifiers they name." },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;

    // With no pragma there is nothing to mark: which identifier is the factory
    // is exactly what the file failed to say. `require-pragma` reports the
    // cause, and `no-unused-vars` may add a follow-on about the factory import
    // — both clear on the same one-line fix.
    function markFactory(node, pattern) {
      const pragma = readPragma(sourceCode, pattern) ?? readPragma(sourceCode, PRAGMA);
      if (pragma) sourceCode.markVariableAsUsed(rootOf(pragma), node);
    }

    return {
      JSXOpeningElement(node) {
        markFactory(node, PRAGMA);
        const identifier = rootIdentifier(node.name);
        if (identifier) sourceCode.markVariableAsUsed(identifier.name, identifier);
      },
      // A fragment compiles to the `@jsxFrag` factory, falling back to `@jsx`.
      JSXOpeningFragment(node) {
        markFactory(node, PRAGMA_FRAG);
      },
    };
  },
};

module.exports = { rules: { "jsx-uses": jsxUses, "require-pragma": requirePragma } };
