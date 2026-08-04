let presets = [
  [
    "@lumine-code/babel-preset",
    {
      // transform ES modules to commonjs
      keepModules: false,
      // TypeScript files use the dedicated synchronous TypeScript transpiler.
      typescript: false,
      // some of the packages use non-strict JavaScript in ES6 modules! We need to add this for now. Eventually, we should fix those packages and remove these:
      notStrictDirectiveTriggers: ["use babel"],
      notStrictCommentTriggers: ["@babel", "@flow", "* @babel", "* @flow"],
      // etch is the editor's JSX factory; a per-file /** @jsx */ comment
      // overrides it. The classic runtime is required for pragma support.
      react: { runtime: "classic", pragma: "etch.dom" },
    },
  ],
];

let plugins = [];

module.exports = {
  presets: presets,
  plugins: plugins,
  exclude: "node_modules/**",
  sourceMap: "inline",
};
