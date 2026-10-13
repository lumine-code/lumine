let presets = [
  [
    "@lumine-code/babel-preset",
    {
      // Node's loader handles both native ESM and CommonJS. Only compile JSX,
      // types and legacy syntax; preserve static and asynchronous imports.
      keepModules: true,
      // Strip type-only imports and preserve the factory used by JSX views.
      typescript: {
        onlyRemoveTypeImports: false,
        jsxPragma: "etch.dom",
        jsxPragmaFrag: "etch.Fragment",
      },
      // some of the packages use non-strict JavaScript in ES6 modules! We need to add this for now. Eventually, we should fix those packages and remove these:
      notStrictDirectiveTriggers: ["use babel"],
      notStrictCommentTriggers: ["@babel", "@flow", "* @babel", "* @flow"],
      // etch is the editor's JSX factory; a per-file /** @jsx */ comment
      // overrides it. The classic runtime is required for pragma support.
      react: { runtime: "classic", pragma: "etch.dom", pragmaFrag: "etch.Fragment" },
    },
  ],
];

// `export =` is TypeScript's explicit CommonJS export. Retain that syntax's
// meaning even though Babel's ESM transform is disabled for native imports.
let plugins = [
  function commonJSTypeScriptExport({ types }) {
    return {
      visitor: {
        TSExportAssignment(path, state) {
          state.commonJSExport = true;
          path.replaceWith(
            types.expressionStatement(
              types.assignmentExpression(
                "=",
                types.memberExpression(types.identifier("module"), types.identifier("exports")),
                path.node.expression,
              ),
            ),
          );
        },
      },
      post(file) {
        // The TS preset marks a file as ESM when its last type-only import is
        // removed. An explicit CommonJS export must remain CommonJS instead.
        if (!this.commonJSExport) return;
        file.path.traverse({
          ExportNamedDeclaration(path) {
            if (!path.node.declaration && !path.node.source && path.node.specifiers.length === 0)
              path.remove();
          },
        });
      },
    };
  },
];

module.exports = {
  presets: presets,
  plugins: plugins,
  overrides: [
    {
      // Plain TypeScript allows angle-bracket assertions; JSX would parse them
      // as unfinished tags. Keep JSX enabled for .tsx, .jsx and pragma JS.
      test: /\.ts$/,
      presets: [["@lumine-code/babel-preset", { ...presets[0][1], react: false, flow: false }]],
    },
  ],
  exclude: "node_modules/**",
  sourceMap: "inline",
};
