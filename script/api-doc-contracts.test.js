"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateDocumentationContracts } = require("./api-doc-contracts");

function fixture(members = [], functions = []) {
  return { classes: [{ name: "Widget", members }], objects: [], functions };
}

const method = {
  name: "run",
  kind: "method",
  category: "Operations",
  summary: "Run a widget operation.",
  parameters: [{ name: "options", type: "Object" }],
};

test("allows intentionally description-less typed overview properties and void commands", () => {
  assert.doesNotThrow(() =>
    validateDocumentationContracts(
      fixture([
        { name: "tools", kind: "property", category: "Properties", propertyType: "Object" },
        method,
      ]),
    ),
  );
});

test("reports missing method prose and untyped top-level or nested arguments together", () => {
  assert.throws(
    () =>
      validateDocumentationContracts(
        fixture([
          {
            ...method,
            summary: "",
            parameters: [{ name: "options" }, { name: "options.signal", nested: true }],
          },
        ]),
      ),
    (error) => {
      assert.match(error.message, /Widget#run: missing method description/);
      assert.match(error.message, /parameter options needs a type/);
      assert.match(error.message, /parameter options\.signal needs a type/);
      return true;
    },
  );
});

test("rejects duplicate parameter names and unnamed destructured arguments", () => {
  assert.throws(
    () =>
      validateDocumentationContracts(
        fixture([
          {
            ...method,
            parameters: [
              { name: "options", type: "Object" },
              { name: "options", type: "Object" },
              { name: null, source: "{force}", type: "Object" },
            ],
          },
        ]),
      ),
    /duplicate parameter options[\s\S]*unnamed parameter/,
  );
});

test("rejects multiline categories and distinct headings that share an anchor", () => {
  assert.throws(
    () =>
      validateDocumentationContracts(
        fixture([
          { ...method, category: "Operations\nAccidentally absorbed prose" },
          { ...method, name: "read", category: "Event Subscription" },
          { ...method, name: "observe", category: "Event subscription" },
        ]),
      ),
    /category must be one nonempty line[\s\S]*duplicate navigation anchor/,
  );
});

test("checks async return contracts on object APIs and exported functions", () => {
  assert.throws(
    () =>
      validateDocumentationContracts({
        classes: [],
        objects: [{ name: "tools", members: [{ ...method, static: true, async: true }] }],
        functions: [{ ...method, name: "load", accessPath: "lumine.tools.load", async: true }],
      }),
    /tools\.run: async method needs a Promise return type[\s\S]*lumine\.tools\.load/,
  );
  assert.doesNotThrow(() =>
    validateDocumentationContracts(
      fixture([{ ...method, async: true, returnType: "Promise<void>" }]),
    ),
  );
});
