let presets = [
  [
    "@lumine-code/babel-preset",
    {
      // transform ES modules to commonjs
      keepModules: false,
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

let plugins = [];

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
