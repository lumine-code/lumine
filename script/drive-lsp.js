const fs = require("fs");
const path = require("path");

const ROOT_VALUE = "$";
const RETRYABLE_METHODS = new Set([
  "textDocument/completion",
  "completionItem/resolve",
  "textDocument/hover",
  "textDocument/signatureHelp",
  "textDocument/declaration",
  "textDocument/definition",
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/references",
  "textDocument/documentHighlight",
  "textDocument/documentSymbol",
  "workspace/symbol",
  "textDocument/documentLink",
  "documentLink/resolve",
  "textDocument/documentColor",
  "textDocument/colorPresentation",
  "textDocument/foldingRange",
  "textDocument/selectionRange",
  "textDocument/linkedEditingRange",
  "textDocument/prepareRename",
  "textDocument/codeAction",
  "codeAction/resolve",
  "textDocument/codeLens",
  "codeLens/resolve",
  "textDocument/diagnostic",
  "workspace/diagnostic",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/onTypeFormatting",
  "textDocument/inlayHint",
  "inlayHint/resolve",
  "textDocument/semanticTokens/full",
  "textDocument/semanticTokens/full/delta",
  "textDocument/semanticTokens/range",
  "textDocument/prepareCallHierarchy",
  "callHierarchy/incomingCalls",
  "callHierarchy/outgoingCalls",
  "textDocument/prepareTypeHierarchy",
  "typeHierarchy/supertypes",
  "typeHierarchy/subtypes",
]);

function count(value) {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function valuesAtPath(value, selector = ROOT_VALUE) {
  if (!selector || selector === ROOT_VALUE) return value;
  let values = [value];
  let expanded = false;
  for (const segment of selector.split(".")) {
    if (segment === "*") {
      expanded = true;
      values = values.flatMap((item) =>
        Array.isArray(item) ? item : item && typeof item === "object" ? Object.values(item) : [],
      );
    } else {
      values = values.map((item) => item?.[segment]);
    }
  }
  return expanded ? values : values[0];
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExpectation(name, value, expectation = {}) {
  const selected = valuesAtPath(value, expectation.path);
  const description = expectation.path ? `${name} at ${expectation.path}` : name;
  if (expectation.exists === true && selected === undefined) {
    throw new Error(`${description} is undefined`);
  }
  if (expectation.truthy === true && !selected) {
    throw new Error(`${description} is not truthy`);
  }
  if (expectation.type) {
    const actual = Array.isArray(selected) ? "array" : selected === null ? "null" : typeof selected;
    if (actual !== expectation.type) {
      throw new Error(`${description} has type ${actual}, expected ${expectation.type}`);
    }
  }
  if (expectation.minLength !== undefined && count(selected) < expectation.minLength) {
    throw new Error(
      `${description} has length ${count(selected)}, expected at least ${expectation.minLength}`,
    );
  }
  if (Object.hasOwn(expectation, "equals") && !sameValue(selected, expectation.equals)) {
    throw new Error(
      `${description} is ${JSON.stringify(selected)}, expected ${JSON.stringify(expectation.equals)}`,
    );
  }
  if (Object.hasOwn(expectation, "includes")) {
    const included =
      typeof selected === "string"
        ? selected.includes(String(expectation.includes))
        : Array.isArray(selected) &&
          selected.some((candidate) => sameValue(candidate, expectation.includes));
    if (!included) {
      throw new Error(
        `${description} does not include ${JSON.stringify(expectation.includes)}; received ${JSON.stringify(selected)}`,
      );
    }
  }
  if (expectation.matches) {
    const pattern = new RegExp(expectation.matches, expectation.flags || "");
    const candidates = Array.isArray(selected) ? selected : [selected];
    if (
      !candidates.some((candidate) => {
        pattern.lastIndex = 0;
        return pattern.test(String(candidate));
      })
    ) {
      throw new Error(`${description} does not match /${expectation.matches}/`);
    }
  }
}

function normalizeManifest(manifest, manifestPath) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("the LSP conformance manifest must be an object");
  }
  if (!manifest.adapter || typeof manifest.adapter !== "string") {
    throw new Error("the LSP conformance manifest needs an adapter id");
  }
  if (!Array.isArray(manifest.checks) || manifest.checks.length === 0) {
    throw new Error("the LSP conformance manifest needs at least one check");
  }
  if (
    manifest.timeout !== undefined &&
    (!Number.isFinite(manifest.timeout) || manifest.timeout < 0)
  ) {
    throw new Error("the LSP conformance manifest timeout must be a non-negative number");
  }
  const names = new Set();
  for (const check of manifest.checks) {
    if (!check.name || typeof check.name !== "string") throw new Error("every check needs a name");
    if (names.has(check.name)) throw new Error(`duplicate check name: ${check.name}`);
    names.add(check.name);
    if (!check.kind && !check.method) throw new Error(`${check.name} needs a method or kind`);
    if (check.retry) {
      if (check.kind || !RETRYABLE_METHODS.has(check.method)) {
        throw new Error(`${check.name} retries a method that is not a safe read`);
      }
      if (!check.expect || typeof check.expect !== "object") {
        throw new Error(`${check.name} needs an expectation to decide when its retry is ready`);
      }
      const retry = check.retry === true ? {} : check.retry;
      if (!retry || typeof retry !== "object" || Array.isArray(retry)) {
        throw new Error(`${check.name} retry must be true or an object`);
      }
      for (const key of ["timeout", "interval"]) {
        if (retry[key] !== undefined && (!Number.isFinite(retry[key]) || retry[key] < 0)) {
          throw new Error(`${check.name} retry ${key} must be a non-negative number`);
        }
      }
    }
  }
  const directory = path.dirname(path.resolve(manifestPath));
  return {
    timeout: 30000,
    ...manifest,
    ...(manifest.project ? { project: path.resolve(directory, manifest.project) } : {}),
    ...(manifest.file ? { file: path.resolve(directory, manifest.file) } : {}),
  };
}

function loadManifest(manifestPath) {
  const filePath = path.resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read LSP conformance manifest ${filePath}: ${error.message}`, {
      cause: error,
    });
  }
  return normalizeManifest(manifest, filePath);
}

// Stringified and evaluated inside the driven renderer. Keep it self-contained:
// it cannot close over any of this module's Node-side helpers.
async function runInRenderer(manifest) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = () => Date.now() + manifest.timeout;
  const waitFor = async (read, label) => {
    const until = deadline();
    let value;
    while (Date.now() < until) {
      value = await read();
      if (value) return value;
      await delay(50);
    }
    throw new Error(`${label} timed out after ${manifest.timeout}ms`);
  };

  await lumine.packages.activatePackage("ide-client");
  await lumine.packages.activatePackage(manifest.adapter);
  for (const [keyPath, value] of Object.entries(manifest.config || {})) {
    lumine.config.set(keyPath, value);
  }
  if (manifest.project) lumine.project.setPaths([manifest.project]);
  const editor = manifest.file
    ? await lumine.workspace.open(manifest.file)
    : lumine.workspace.getActiveTextEditor();
  if (!editor) throw new Error("the conformance manifest did not open a text editor");
  if (manifest.grammarScope) {
    await waitFor(
      () => editor.getGrammar()?.scopeName === manifest.grammarScope,
      `grammar ${manifest.grammarScope}`,
    );
  }

  const clientPackage = lumine.packages.getActivePackage("ide-client");
  const manager = clientPackage?.mainModule?.manager;
  if (!manager) throw new Error("ide-client did not expose its active language-server manager");
  let session = await waitFor(async () => {
    const sessions = await manager.activeSessionsForEditor(editor);
    return sessions.find(
      (candidate) => candidate.adapter.id === manifest.adapter && candidate.state === "running",
    );
  }, `${manifest.adapter} running session`);
  const { pathToFileURL } = require("url");
  const uri = pathToFileURL(editor.getPath()).href;
  const results = [];
  const resultValues = new Map();
  const readPath = (value, selector = "$") => {
    if (!selector || selector === "$") return value;
    return selector.split(".").reduce((item, segment) => item?.[segment], value);
  };
  const writePath = (target, selector, value) => {
    const segments = selector.split(".");
    const property = segments.pop();
    const owner = segments.reduce((item, segment) => (item[segment] ||= {}), target);
    owner[property] = structuredClone(value);
  };
  const expectationMatches = (value, expectation = {}) => {
    const select = (input, selector = "$") => {
      if (!selector || selector === "$") return input;
      let values = [input];
      let expanded = false;
      for (const segment of selector.split(".")) {
        if (segment === "*") {
          expanded = true;
          values = values.flatMap((item) =>
            Array.isArray(item)
              ? item
              : item && typeof item === "object"
                ? Object.values(item)
                : [],
          );
        } else {
          values = values.map((item) => item?.[segment]);
        }
      }
      return expanded ? values : values[0];
    };
    const selected = select(value, expectation.path);
    const size = (input) => {
      if (typeof input === "string" || Array.isArray(input)) return input.length;
      if (input && typeof input === "object") return Object.keys(input).length;
      return 0;
    };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    if (expectation.exists === true && selected === undefined) return false;
    if (expectation.truthy === true && !selected) return false;
    if (expectation.type) {
      const actual = Array.isArray(selected)
        ? "array"
        : selected === null
          ? "null"
          : typeof selected;
      if (actual !== expectation.type) return false;
    }
    if (expectation.minLength !== undefined && size(selected) < expectation.minLength) return false;
    if (Object.hasOwn(expectation, "equals") && !same(selected, expectation.equals)) return false;
    if (Object.hasOwn(expectation, "includes")) {
      const included =
        typeof selected === "string"
          ? selected.includes(String(expectation.includes))
          : Array.isArray(selected) &&
            selected.some((candidate) => same(candidate, expectation.includes));
      if (!included) return false;
    }
    if (expectation.matches) {
      const pattern = new RegExp(expectation.matches, expectation.flags || "");
      const candidates = Array.isArray(selected) ? selected : [selected];
      if (
        !candidates.some((candidate) => {
          pattern.lastIndex = 0;
          return pattern.test(String(candidate));
        })
      )
        return false;
    }
    return true;
  };
  const readReferencedValue = (source, checkName) => {
    let value = readPath(resultValues.get(source.check), source.path);
    if (source.find) {
      const candidates = Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? Object.values(value)
          : [];
      value = candidates.find(
        (candidate) =>
          JSON.stringify(readPath(candidate, source.find.path)) ===
          JSON.stringify(source.find.equals),
      );
      if (value === undefined) {
        throw new Error(
          `${checkName} could not find ${source.find.path || "$"}=${JSON.stringify(source.find.equals)} in ${source.check}`,
        );
      }
    }
    if (source.select) {
      value = readPath(value, source.select);
      if (value === undefined) {
        throw new Error(`${checkName} could not select ${source.select} from ${source.check}`);
      }
    }
    return value;
  };

  for (const check of manifest.checks) {
    let value;
    if (check.kind === "diagnostics") {
      // The manager canonicalizes equivalent file URI spellings. Marksman and
      // Pyright percent-encode a Windows drive colon and lower-case its letter,
      // so comparing the raw URI here loses diagnostics that the editor itself
      // has already associated with the open document.
      value = await waitFor(() => {
        const diagnostics = manager.diagnosticsFor(session, uri);
        return diagnostics.length >= (check.minLength || 0) ? diagnostics : null;
      }, `${check.name} diagnostics`);
    } else if (check.kind === "restart") {
      const previous = session;
      await manager.restart(session);
      session = await waitFor(async () => {
        const sessions = await manager.activeSessionsForEditor(editor);
        return sessions.find(
          (candidate) =>
            candidate !== previous &&
            candidate.adapter.id === manifest.adapter &&
            candidate.state === "running",
        );
      }, `${manifest.adapter} restarted session`);
      value = { previous: previous.state, current: session.state };
    } else {
      let params = structuredClone(check.params || {});
      for (const [target, source] of Object.entries(check.paramsFrom || {})) {
        if (!resultValues.has(source.check)) {
          throw new Error(`${check.name} refers to unfinished check ${source.check}`);
        }
        const value = readReferencedValue(source, check.name);
        if (target === "$") params = structuredClone(value);
        else writePath(params, target, value);
      }
      if (check.document !== false && check.method.startsWith("textDocument/")) {
        params.textDocument ||= { uri };
      }
      if (check.position) {
        params.position = { line: check.position[0], character: check.position[1] };
      }
      const request = (options) => session.request(check.method, params, options);
      if (check.retry) {
        const options = check.retry === true ? {} : check.retry;
        const timeout = options.timeout ?? manifest.timeout;
        const interval = options.interval ?? 100;
        const until = Date.now() + timeout;
        let lastError;
        let firstAttempt = true;
        const timeoutError = () => {
          const detail = lastError ? `: ${lastError.message}` : "";
          return new Error(`${check.name} did not become ready within ${timeout}ms${detail}`);
        };
        do {
          const remaining = until - Date.now();
          if (!firstAttempt && remaining <= 0) throw timeoutError();
          firstAttempt = false;
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            Math.max(0, Math.min(remaining, 0x7fffffff)),
          );
          try {
            value = await request({ signal: controller.signal });
            lastError = null;
            if (Date.now() <= until && expectationMatches(value, check.expect)) break;
          } catch (error) {
            lastError = error;
          } finally {
            clearTimeout(timer);
          }
          const wait = until - Date.now();
          if (wait <= 0) throw timeoutError();
          await delay(Math.min(interval, wait));
        } while (true);
      } else {
        value = await request();
      }
    }
    results.push({ name: check.name, value });
    resultValues.set(check.name, value);
  }

  return {
    adapter: session.adapter.id,
    displayName: session.adapter.displayName,
    grammarScope: editor.getGrammar()?.scopeName,
    state: session.state,
    results,
  };
}

function rendererExpression(manifest) {
  return `(${runInRenderer.toString()})(${JSON.stringify(manifest)})`;
}

function assertResult(manifest, result) {
  if (result?.adapter !== manifest.adapter) {
    throw new Error(
      `the renderer used adapter ${result?.adapter || "none"}, expected ${manifest.adapter}`,
    );
  }
  if (result.state !== "running") {
    throw new Error(`${manifest.adapter} finished in state ${result.state}`);
  }
  const results = new Map((result.results || []).map((entry) => [entry.name, entry.value]));
  const passed = [];
  for (const check of manifest.checks) {
    if (!results.has(check.name)) throw new Error(`the renderer omitted check ${check.name}`);
    assertExpectation(check.name, results.get(check.name), check.expect);
    passed.push(check.name);
  }
  return passed;
}

module.exports = {
  assertExpectation,
  assertResult,
  loadManifest,
  normalizeManifest,
  rendererExpression,
  valuesAtPath,
};
