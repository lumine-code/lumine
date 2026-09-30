"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Linter } = require("eslint");
const config = require("../eslint.config");
const jsx = config.find((entry) => entry.plugins?.jsx)?.plugins.jsx;

assert.ok(jsx, "the lint configuration exposes its local JSX rules");

const cases = [
  ["ordinary JavaScript needs no pragma", "module.exports = 1;", []],
  [
    "missing pragma is reported once for mixed elements and fragments",
    "module.exports = <><div /><span /></>;",
    ["jsx/require-pragma:missing"],
  ],
  [
    "Etch factory is used by an intrinsic element",
    "/** @jsx etch.dom */\nconst etch = {}; module.exports = <div />;",
    [],
  ],
  [
    "React factory is used by an intrinsic element",
    "/** @jsx React.createElement */\nconst React = {}; module.exports = <div />;",
    [],
  ],
  [
    "component tag references its binding",
    "/** @jsx make */\nconst make = (...a) => a; const Foo = 1; module.exports = <Foo />;",
    [],
  ],
  [
    "intrinsic tag does not reference a similarly named variable",
    "/** @jsx make */\nconst make = (...a) => a; const div = 1; module.exports = <div />;",
    ["no-unused-vars:div"],
  ],
  [
    "lowercase member tag references its root",
    "/** @jsx make */\nconst make = (...a) => a; const ui = {}; module.exports = <ui.Button />;",
    [],
  ],
  [
    "nested member tag references its root",
    "/** @jsx make */\nconst make = (...a) => a; const ui = {}; module.exports = <ui.controls.Button />;",
    [],
  ],
  [
    "component lookup respects a shadowed binding",
    "/** @jsx make */\nconst make = (...a) => a; const Foo = 1; module.exports = function(Foo) { return <Foo />; };",
    ["no-unused-vars:Foo"],
  ],
  [
    "factory lookup respects a shadowed binding",
    "/** @jsx make */\nconst make = (...a) => a; module.exports = function(make) { return <div />; };",
    ["no-unused-vars:make"],
  ],
  [
    "fragment references both its factory and its separate type",
    "/** @jsx make */\n/** @jsxFrag Frag */\nconst make = (...a) => a; const Frag = {}; module.exports = <>hello</>;",
    [],
  ],
  [
    "fragment can share a root with its factory",
    "/** @jsx etch.dom */\n/** @jsxFrag etch.Fragment */\nconst etch = {}; module.exports = <>hello</>;",
    [],
  ],
  [
    "fragment does not guess a type absent from its annotations",
    "/** @jsx make */\nconst make = (...a) => a; const React = {}; module.exports = <>hello</>;",
    ["no-unused-vars:React"],
  ],
  [
    "fragment type annotation alone does not declare a factory",
    "/** @jsxFrag Frag */\nconst Frag = {}; module.exports = <>hello</>;",
    ["jsx/require-pragma:missing"],
  ],
  [
    "prose mentioning a pragma does not declare a factory",
    "// Example syntax: @jsx make\nconst make = (...a) => a; module.exports = <div />;",
    ["no-unused-vars:make", "jsx/require-pragma:missing"],
  ],
  [
    "annotation with additional prose does not declare a factory",
    "/** @jsx make example */\nconst make = (...a) => a; module.exports = <div />;",
    ["no-unused-vars:make", "jsx/require-pragma:missing"],
  ],
  [
    "last factory annotation wins",
    "/** @jsx first */\n/** @jsx second */\nconst first = (...a) => a; const second = (...a) => a; module.exports = <div />;",
    ["no-unused-vars:first"],
  ],
  [
    "last fragment type annotation wins",
    "/** @jsx make */\n/** @jsxFrag First */\n/** @jsxFrag Second */\nconst make = (...a) => a; const First = {}; const Second = {}; module.exports = <>hello</>;",
    ["no-unused-vars:First"],
  ],
  [
    "multiline annotation is accepted",
    "/**\n * @jsx make\n */\nconst make = (...a) => a; module.exports = <div />;",
    [],
  ],
  [
    "annotation after a statement is accepted like Babel",
    "const make = (...a) => a;\n/** @jsx make */\nmodule.exports = <div />;",
    [],
  ],
];

function lint(linter, source) {
  return linter.verify(source, {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { jsx },
    rules: { "jsx/require-pragma": "error", "jsx/jsx-uses": "error", "no-unused-vars": "error" },
  });
}

for (const [name, source, expected] of cases) {
  test(name, () => {
    const messages = lint(new Linter(), source);
    const actual = messages.map((message) =>
      message.ruleId === "no-unused-vars"
        ? `${message.ruleId}:${message.message.match(/^'([^']+)'/)[1]}`
        : `${message.ruleId}:${message.messageId}`,
    );
    assert.deepEqual(actual.sort(), expected.toSorted());
  });
}

test("annotation cache stays local to each source file", () => {
  const linter = new Linter();
  assert.equal(
    lint(linter, "/** @jsx make */\nconst make = (...a) => a; module.exports = <div />;").length,
    0,
  );
  const messages = lint(linter, "module.exports = <div />;");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, "jsx/require-pragma");
  assert.equal(messages[0].messageId, "missing");
});
