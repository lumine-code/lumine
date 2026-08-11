"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const parser = require("@babel/parser");
const { SCHEMA_VERSION, extractApi } = require("./api-extractor");

const fixturePath = path.join(__dirname, "fixtures", "api-extractor", "modern-api.js");

function editorFixture(source = fs.readFileSync(fixturePath, "utf8")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-api-extractor-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "lumine",
      productName: "Lumine",
      version: "1.0.0",
      repository: "https://github.com/lumine-code/lumine",
    }),
  );
  fs.writeFileSync(path.join(root, "src", "fixture.js"), source);
  return root;
}

test("extracts structured JSDoc metadata from modern JavaScript", (context) => {
  const root = editorFixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = extractApi({ editorRoot: root, parser });

  assert.equal(api.schemaVersion, SCHEMA_VERSION);
  assert.equal(api.name, "Lumine");
  assert.equal(api.classes.length, 2);
  assert.equal(api.memberCount, 7);
  const environment = api.classes[0];
  assert.equal(environment.name, "LumineEnvironment");
  assert.equal(environment.visibility, "Essential");
  assert.equal(environment.description, "The public editor surface.");
  assert.equal(environment.members[0].propertyType, "FixtureService");

  const service = api.classes.find(({ name }) => name === "FixtureService");
  assert.equal(service.visibility, "Extended");
  assert.equal(service.members.length, 5);
  const transform = service.members.find(({ name }) => name === "transform");
  assert.equal(transform.visibility, "Experimental");
  assert.equal(transform.category, "Transformation");
  assert.equal(transform.returnType, "Promise<String>");
  assert.equal(transform.returnDescription, "The transformed value.");
  assert.deepEqual(
    transform.parameters.map(({ name, nested, optional, type }) => ({
      name,
      nested: Boolean(nested),
      optional,
      type,
    })),
    [
      { name: "value", nested: false, optional: false, type: "String" },
      { name: "options", nested: false, optional: true, type: "Object" },
      { name: "options.prefix", nested: true, optional: true, type: "String" },
    ],
  );
  assert.equal(service.members.find(({ name }) => name === "create").static, true);
  assert.equal(service.members.find(({ name }) => name === "ready").kind, "get");
  assert.equal(service.members.find(({ name }) => name === "label").kind, "set");
  assert.equal(
    service.members.some(({ name }) => name === "hidden"),
    false,
  );
  assert.equal(
    service.members.some(({ name }) => name === "undocumented"),
    false,
  );
  assert.equal(api.functions[0].name, "normalize");
  assert.equal(api.functions[0].parameters[0].defaultValue, '""');
});

test("normalizes CRLF input", (context) => {
  const source = fs.readFileSync(fixturePath, "utf8").replace(/\n/g, "\r\n");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = extractApi({ editorRoot: root, parser });
  assert.equal(api.memberCount, 7);
});

test("uses a grammatical article for synthesized property descriptions", (context) => {
  const source = fs
    .readFileSync(fixturePath, "utf8")
    .replace("     * The fixture service.\n     *\n", "")
    .replaceAll("FixtureService", "ApplicationService");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = extractApi({ editorRoot: root, parser });
  assert.equal(api.classes[0].members[0].description, "An {@link ApplicationService} instance");
});

test("rejects invalid API status values", (context) => {
  const source = fs
    .readFileSync(fixturePath, "utf8")
    .replace("@status essential", "@status stable");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => extractApi({ editorRoot: root, parser }), /Invalid @status "stable"/);
});

test("rejects legacy API status tag spellings", (context) => {
  for (const legacyTag of ["api-status", "apistatus"]) {
    const source = fs
      .readFileSync(fixturePath, "utf8")
      .replace("@status essential", `@${legacyTag} essential`);
    const root = editorFixture(source);
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.throws(() => extractApi({ editorRoot: root, parser }), /must declare @status/);
  }
});

test("rejects return tags without a structured type", (context) => {
  const source = fs
    .readFileSync(fixturePath, "utf8")
    .replace("@returns {Promise<String>}", "@returns");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => extractApi({ editorRoot: root, parser }), /must declare a type in braces/);
});

test("rejects links used as property types", (context) => {
  const source = fs
    .readFileSync(fixturePath, "utf8")
    .replace("@type {FixtureService}", "@type {@link FixtureService}");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => extractApi({ editorRoot: root, parser }), /structured type in braces/);
});

test("rejects documented parameters that are not declared", (context) => {
  const source = fs
    .readFileSync(fixturePath, "utf8")
    .replace("@param {String} value", "@param {String} missing");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => extractApi({ editorRoot: root, parser }),
    /Documented parameter "missing" is not declared/,
  );
});

test("maps conceptual parameters documented for a rest wrapper", (context) => {
  const source = fs
    .readFileSync(fixturePath, "utf8")
    .replace('function normalize(input = "")', "function normalize(...args)");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = extractApi({ editorRoot: root, parser });
  assert.deepEqual(
    api.functions[0].parameters.map(({ name, rest }) => ({ name, rest })),
    [{ name: "input", rest: false }],
  );
});

test("maps a documented name onto a destructured parameter", (context) => {
  const source = fs
    .readFileSync(fixturePath, "utf8")
    .replace('@param {String} [input=""] - Input value.', "@param {Object} [options] - Options.")
    .replace('function normalize(input = "")', "function normalize({ trim = true } = {})");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = extractApi({ editorRoot: root, parser });
  assert.equal(api.functions[0].parameters[0].name, "options");
  assert.equal(api.functions[0].parameters[0].source, "{ trim = true } = {}");
});

test("rejects unresolved JSDoc links", (context) => {
  const source = fs
    .readFileSync(fixturePath, "utf8")
    .replace("FixtureService#transform", "FixtureService#missing");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => extractApi({ editorRoot: root, parser }), /Unresolved JSDoc link/);
});

test("reports modern JavaScript parse errors", (context) => {
  const source = fs.readFileSync(fixturePath, "utf8").replace("return values;", "return (values;");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => extractApi({ editorRoot: root, parser }), /Unable to parse/);
});

test("rejects duplicate documented members", (context) => {
  const source = fs
    .readFileSync(fixturePath, "utf8")
    .replace("@private", "@public\n   * @status public")
    .replace("hidden()", "collect()");
  const root = editorFixture(source);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => extractApi({ editorRoot: root, parser }), /Duplicate documented member/);
});
