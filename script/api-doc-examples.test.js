"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const parser = require("@babel/parser");
const { validateDocumentationExamples } = require("./api-doc-examples");

function documentation(description) {
  return {
    classes: [],
    objects: [],
    functions: [{ name: "example", sourcePath: "src/example.js", line: 10, description }],
  };
}

test("validates JavaScript examples, async fragments and JSON manifests", () => {
  const api = documentation(
    '```js\nconst {BufferedProcess} = require("lumine");\n```\n' +
      '```javascript\nawait lumine.workspace.open("test.js");\nreturn true;\n```\n' +
      '```json\n{"name": "example"}\n```',
  );
  assert.doesNotThrow(() => validateDocumentationExamples(api, parser));
});

test("rejects missing declarations and commas in runnable API examples", () => {
  for (const source of [
    '{BufferedProcess} = require("lumine");',
    'lumine.menu.add([{label: "Hello" submenu: []}]);',
    "module.exports = { activate() {} handleURI() {} };",
  ]) {
    assert.throws(
      () => validateDocumentationExamples(documentation(`\`\`\`js\n${source}\n\`\`\``), parser),
      /src\/example.js:10: example:/,
    );
  }
});

test("checks object member examples and rejects malformed JSON", () => {
  const api = {
    classes: [],
    functions: [],
    objects: [
      {
        name: "Icon",
        sourcePath: "src/icon.js",
        members: [{ name: "classes", line: 42, description: '```json\n{"name":}\n```' }],
      },
    ],
  };
  assert.throws(() => validateDocumentationExamples(api, parser), /Icon#classes/);
});
