const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");
// Local JSX rules keep each file's factory explicit and count JSX references
// for no-unused-vars without depending on a particular UI library.
const jsxPragmas = new WeakMap();
function readJSXPragmas(sourceCode) {
  if (!jsxPragmas.has(sourceCode)) {
    const pragmas = {};
    for (const comment of sourceCode.getAllComments()) {
      // Match Babel's annotation syntax and let the last annotation win.
      const factory = /^\s*(?:\*\s*)?@jsx\s+(\S+)\s*$/m.exec(comment.value);
      const fragment = /^\s*(?:\*\s*)?@jsxFrag\s+(\S+)\s*$/m.exec(comment.value);
      if (factory) pragmas.factory = factory[1];
      if (fragment) pragmas.fragment = fragment[1];
    }
    jsxPragmas.set(sourceCode, pragmas);
  }
  return jsxPragmas.get(sourceCode);
}

const jsx = {
  rules: {
    "require-pragma": {
      meta: {
        type: "problem",
        schema: [],
        messages: { missing: "This file contains JSX but declares no `/** @jsx ... */` pragma." },
      },
      create({ sourceCode, report }) {
        const { factory } = readJSXPragmas(sourceCode);
        let reported = false;
        function check(node) {
          if (factory || reported) return;
          reported = true;
          report({ node, messageId: "missing" });
        }
        return { JSXOpeningElement: check, JSXOpeningFragment: check };
      },
    },
    "jsx-uses": {
      meta: { type: "problem", schema: [] },
      create({ sourceCode }) {
        const { factory, fragment } = readJSXPragmas(sourceCode);
        function mark(expression, node) {
          if (expression) sourceCode.markVariableAsUsed(expression.split(".")[0], node);
        }
        return {
          JSXOpeningElement(node) {
            mark(factory, node);
            // Plain lowercase tags are strings; a member tag still references
            // its root even when that root starts with a lowercase letter.
            if (node.name.type === "JSXIdentifier" && /^[a-z]/.test(node.name.name)) return;
            let root = node.name;
            while (root.type === "JSXMemberExpression") root = root.object;
            if (root.type === "JSXIdentifier") sourceCode.markVariableAsUsed(root.name, root);
          },
          JSXOpeningFragment(node) {
            mark(factory, node);
            // A fragment type is separate from the factory that receives it.
            // Compiler defaults are outside this rule's explicit-pragma scope.
            mark(fragment, node);
          },
        };
      },
    },
  },
};

// Modules provided by the Lumine/Electron runtime or the editor's root
// dependencies — not resolvable from a bundled package's own manifest, so allow
// them across eslint-plugin-n's resolution rules.
const runtimeModules = ["lumine", "electron"];

module.exports = [
  {
    // `**/fixtures/**` are intentional test fixtures (deliberately broken syntax,
    // asserted-exact content); `.dev/**` is a local developer sandbox (LSP
    // experiments) with deps that aren't installed in the workspace.
    ignores: [
      "**/*.ts",
      "**/*.tsx",
      "vendor/**",
      "dist/**",
      "**/fixtures/**",
      ".dev/**",
      // Scaffolding for `script/new-grammar-package.js`; {{token}} placeholders
      // rather than valid source.
      "script/templates/**",
    ],
  },
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    // Flat config only lints .js/.mjs/.cjs by default; .jsx must be named
    // explicitly or renamed files silently drop out of `eslint .`.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx"],
    plugins: { jsx },
    settings: {
      // This is an Electron app bundling its own Node 24 runtime, so lint
      // syntax/builtins support against that — not each package's stale engines.
      // tryExtensions lets extensionless requires resolve .jsx files.
      n: { version: ">=24.0.0", tryExtensions: [".js", ".json", ".node", ".mjs", ".cjs", ".jsx"] },
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        lumine: "writable",
      },
    },
    rules: {
      // Each file carrying JSX names its own factory in a `/** @jsx ... */`
      // pragma: `require-pragma` insists on it, and `jsx-uses` reads the
      // factory from there so `no-unused-vars` sees the import as referenced.
      // babel.config.js still sets etch.dom for anything this never lints.
      "jsx/require-pragma": "error",
      "jsx/jsx-uses": "error",
      "no-constant-condition": "off",
      "no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-missing-import": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-import": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-import": ["error", { allowModules: runtimeModules }],
      // `localStorage`/`navigator` here are Chromium (renderer) globals, not
      // Node's newer experimental builtins of the same name.
      "n/no-unsupported-features/node-builtins": [
        "error",
        // `module.enableCompileCache` is stable enough to use on the bundled
        // Node 24 runtime; `localStorage`/`navigator` are Chromium (renderer)
        // globals, not Node's newer experimental builtins of the same name.
        { ignores: ["localStorage", "navigator", "module.enableCompileCache"] },
      ],
    },
  },
  {
    // process.exit() is legitimate in build scripts, the Electron main process,
    // and standalone helper processes/CLIs (CLI flag handling, forced quit,
    // askpass/worker entry points, the spec runners) — not the anti-pattern
    // this rule targets in long-running library code.
    files: [
      "script/**",
      "resources/**",
      "spec/main-process/**",
      "src/main.js",
      "src/lumine-application.js",
      "src/parse-command-line.js",
      "src/askpass.js",
      "src/start.js",
      "src/git-host-worker.js",
      "src/task-bootstrap.js",
      "src/file-watch-worker-bootstrap.js",
    ],
    rules: { "n/no-process-exit": "off" },
  },
  {
    // Completion-data build scripts (run manually via `npm run update`) require
    // update-time-only devDependencies that are not installed in the workspace,
    // and legitimately call process.exit(). Don't flag their resolution here.
    files: ["**/update/**"],
    rules: {
      "n/no-process-exit": "off",
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  {
    // Test files — jasmine, both the editor runner and the plain-Node
    // `*.test.js` suites (the main-process specs, the completion updaters), and
    // Lumine's async helpers. Also relax dependency-resolution rules: specs require
    // devDependencies and load fixture modules by path the resolver can't follow.
    files: ["spec/**", "**/spec/**", "**/*-spec.js", "**/*-spec.jsx", "**/*.test.js"],
    languageOptions: {
      globals: {
        ...globals.jasmine,
        test: "readonly",
        // Grammar-test helpers injected onto `window` by spec/helpers/normalize-comments.js.
        runGrammarTests: "readonly",
        runFoldsTests: "readonly",
        normalizeTreeSitterTextData: "readonly",
        advanceClock: "readonly",
        // Waiting primitives injected onto `window` by spec/helpers/async-spec-helpers.js.
        conditionPromise: "readonly",
        emitterEventPromise: "readonly",
        flushMicrotasks: "readonly",
        timeoutPromise: "readonly",
        waitForFrames: "readonly",
      },
    },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-unpublished-import": "off",
      "n/no-extraneous-require": "off",
      "n/no-extraneous-import": "off",
    },
  },
  // Must be last: turns off any lint rules that would conflict with Prettier.
  prettier,
];
