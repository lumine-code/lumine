// Verifies the service graph across the workspace: every bundled package, every
// pkg_lumine repo, and the services core registers directly on the serviceHub.
//
// Package activation wires services silently — src/package.js only warns to a
// console nobody reads when a declared provide*/consume* method is missing, and
// a consumer whose service name no longer matches any provider is never called
// at all. Nothing throws, and most community packages have no spec asserting
// their service names. These checks are the substitute.
//
//   node script/check-services.js [workspace-root]
//
// Defaults to the parent of this repository so pkg_lumine/* is picked up when
// checked out beside it. Exits non-zero on an error; style findings are
// reported as warnings and do not fail the run.

const fs = require("fs");
const path = require("path");
const semver = require("semver");
const { parseSync } = require("@babel/core");

// Consumed here, provided by a package that lives outside the workspace.
const EXTERNAL_SERVICES = new Set(["claude-chat"]);

// Namespaces that name a general domain rather than a package. Any other
// namespace must match the name of a package in the workspace.
const GENERAL_DOMAINS = new Set([
  "icons",
  "symbol",
  "jupyter",
  "mcp",
  "outline",
  "navigation",
  "search",
  "hyperclick",
  "hyperlink",
  "todo",
  "sofistik",
  "project",
  "workspace",
  "repositories",
]);

const errors = [];
const warnings = [];

function error(where, message) {
  errors.push(`${where}: ${message}`);
}

function warn(where, message) {
  warnings.push(`${where}: ${message}`);
}

// --- AST helpers -----------------------------------------------------------

function parseFile(file) {
  try {
    return parseSync(fs.readFileSync(file, "utf8"), {
      filename: file,
      configFile: false,
      babelrc: false,
      sourceType: "unambiguous",
      parserOpts: {
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: ["classProperties", "classPrivateMethods", "jsx", "decoratorsLegacy"],
      },
    });
  } catch {
    return null;
  }
}

function walk(node, visit) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    walk(node[key], visit);
  }
}

function keyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  return null;
}

function isModuleExports(node) {
  return (
    node?.type === "MemberExpression" &&
    node.object?.type === "Identifier" &&
    node.object.name === "module" &&
    keyName(node.property) === "exports"
  );
}

function objectKeys(node) {
  const names = [];
  if (node?.type !== "ObjectExpression") return names;
  for (const prop of node.properties) {
    if (prop.type === "ObjectMethod" || prop.type === "ObjectProperty") {
      const name = keyName(prop.key);
      if (name) names.push(name);
    }
  }
  return names;
}

function classMethodNames(node) {
  const names = [];
  for (const item of node?.body?.body ?? []) {
    if (item.type === "ClassMethod" || item.type === "ClassProperty") {
      const name = keyName(item.key);
      if (name) names.push(name);
    }
  }
  return names;
}

function resolveModule(fromFile, request) {
  if (!request.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), request);
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Collects a module's public names, CommonJS or ESM. Follows one hop for the
// two shapes that hide them: `module.exports = new TreeViewPackage()` and
// `export * from "./elsewhere"`.
function exportedNames(mainFile, depth = 0) {
  const ast = parseFile(mainFile);
  if (!ast) return null;

  const names = new Set();

  // ESM: export function foo() {}, export const foo =, export { foo }, export *
  walk(ast.program, (node) => {
    if (node.type === "ExportNamedDeclaration") {
      const declaration = node.declaration;
      if (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") {
        if (declaration.id?.name) names.add(declaration.id.name);
      } else if (declaration?.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          if (declarator.id?.type === "Identifier") names.add(declarator.id.name);
        }
      }
      for (const specifier of node.specifiers ?? []) {
        const name = keyName(specifier.exported);
        if (name) names.add(name);
      }
    } else if (node.type === "ExportAllDeclaration" && depth < 1) {
      const resolved = resolveModule(mainFile, node.source?.value ?? "");
      if (resolved) {
        for (const name of exportedNames(resolved, depth + 1) ?? []) names.add(name);
      }
    }
  });
  const requires = new Map(); // local binding -> resolved file
  const localObjects = new Map(); // local binding -> ObjectExpression
  const localClasses = new Map(); // local binding -> ClassDeclaration

  walk(ast.program, (node) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      const init = node.init;
      if (
        init?.type === "CallExpression" &&
        init.callee?.type === "Identifier" &&
        init.callee.name === "require" &&
        init.arguments[0]?.type === "StringLiteral"
      ) {
        const resolved = resolveModule(mainFile, init.arguments[0].value);
        if (resolved) requires.set(node.id.name, resolved);
      } else if (init?.type === "ObjectExpression") {
        localObjects.set(node.id.name, init);
      } else if (init?.type === "ClassExpression") {
        localClasses.set(node.id.name, init);
      }
    }
    if (node.type === "ClassDeclaration" && node.id?.type === "Identifier") {
      localClasses.set(node.id.name, node);
    }
  });

  walk(ast.program, (node) => {
    if (node.type !== "AssignmentExpression") return;

    // module.exports.foo = ...
    if (
      node.left?.type === "MemberExpression" &&
      (isModuleExports(node.left.object) ||
        (node.left.object?.type === "Identifier" && node.left.object.name === "exports"))
    ) {
      const name = keyName(node.left.property);
      if (name) names.add(name);
      return;
    }

    if (!isModuleExports(node.left)) return;

    const right = node.right;
    if (right.type === "ObjectExpression") {
      for (const name of objectKeys(right)) names.add(name);
    } else if (right.type === "ClassDeclaration" || right.type === "ClassExpression") {
      for (const name of classMethodNames(right)) names.add(name);
    } else if (right.type === "Identifier") {
      if (localObjects.has(right.name)) {
        for (const name of objectKeys(localObjects.get(right.name))) names.add(name);
      }
      if (localClasses.has(right.name)) {
        for (const name of classMethodNames(localClasses.get(right.name))) names.add(name);
      }
    } else if (right.type === "NewExpression") {
      const callee = right.callee;
      if (callee?.type === "Identifier") {
        if (localClasses.has(callee.name)) {
          for (const name of classMethodNames(localClasses.get(callee.name))) names.add(name);
        } else if (requires.has(callee.name)) {
          const sub = parseFile(requires.get(callee.name));
          if (sub) {
            walk(sub.program, (inner) => {
              if (inner.type === "ClassDeclaration" || inner.type === "ClassExpression") {
                for (const name of classMethodNames(inner)) names.add(name);
              }
            });
          }
        }
      }
    }
  });

  // Object.assign(module.exports, {...})
  walk(ast.program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      keyName(node.callee.property) === "assign" &&
      isModuleExports(node.arguments?.[0])
    ) {
      for (const arg of node.arguments.slice(1)) {
        for (const name of objectKeys(arg)) names.add(name);
      }
    }
  });

  return names;
}

function sourceFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        stack.push(full);
      } else if (entry.name.endsWith(".js")) {
        out.push(full);
      }
    }
  }
  return out;
}

function mentionsIdentifier(pkg, name) {
  const pattern = new RegExp(`\\b${name}\\b`);
  for (const dir of ["lib", "src"]) {
    const full = path.join(pkg.dir, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of sourceFiles(full)) {
      if (pattern.test(fs.readFileSync(file, "utf8"))) return true;
    }
  }
  return false;
}

// --- collection ------------------------------------------------------------

function readPackages(root) {
  const packages = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return packages;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
      error(path.relative(process.cwd(), manifestPath), `unparseable: ${e.message}`);
      continue;
    }
    packages.push({
      name: manifest.name || entry.name,
      dir: path.join(root, entry.name),
      label: `${path.basename(root)}/${entry.name}`,
      manifest,
    });
  }
  return packages;
}

function readCoreServices(srcDir) {
  const found = { provided: [], consumed: [] };
  const pattern =
    /serviceHub\s*\.\s*(provide|consume)\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g;
  for (const file of sourceFiles(srcDir)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const [, kind, name, version] = match;
      const line = text.slice(0, match.index).split("\n").length;
      const where = `src/${path.relative(srcDir, file).replace(/\\/g, "/")}:${line}`;
      found[kind === "provide" ? "provided" : "consumed"].push({ name, version, where });
    }
  }
  return found;
}

// --- checks ----------------------------------------------------------------

function checkDeclaredMethods(pkg) {
  const main = pkg.manifest.main || "./index.js";
  const mainFile = resolveModule(
    path.join(pkg.dir, "package.json"),
    main.startsWith(".") ? main : `./${main}`,
  );

  const declarations = [];
  for (const kind of ["providedServices", "consumedServices"]) {
    for (const [service, entry] of Object.entries(pkg.manifest[kind] ?? {})) {
      for (const method of Object.values(entry.versions ?? {})) {
        declarations.push({ kind, service, method });
      }
    }
  }
  if (declarations.length === 0) return;

  if (!mainFile) {
    warn(pkg.label, `main module "${main}" not resolvable; cannot verify declared methods`);
    return;
  }

  const exported = exportedNames(mainFile);
  for (const { kind, service, method } of declarations) {
    if (exported && exported.has(method)) continue;
    if (mentionsIdentifier(pkg, method)) {
      warn(
        pkg.label,
        `${kind} "${service}" -> ${method}() found in source but not as an export of ${main}`,
      );
    } else {
      error(pkg.label, `${kind} "${service}" declares ${method}(), which does not exist`);
    }
  }
}

function checkDuplicateConsumerMethods(pkg) {
  const byMethod = new Map();
  for (const [service, entry] of Object.entries(pkg.manifest.consumedServices ?? {})) {
    for (const method of Object.values(entry.versions ?? {})) {
      if (!byMethod.has(method)) byMethod.set(method, []);
      byMethod.get(method).push(service);
    }
  }
  for (const [method, services] of byMethod) {
    if (services.length > 1) {
      error(
        pkg.label,
        `consumes ${services.map((s) => `"${s}"`).join(" and ")} into the same ${method}(); ` +
          `it would run once per service and register twice`,
      );
    }
  }
}

function checkReadmeServices(pkg) {
  const declared = new Set([
    ...Object.keys(pkg.manifest.providedServices ?? {}),
    ...Object.keys(pkg.manifest.consumedServices ?? {}),
  ]);
  if (declared.size === 0) return;

  const readmePath = path.join(pkg.dir, "README.md");
  if (!fs.existsSync(readmePath)) return;
  const readme = fs.readFileSync(readmePath, "utf8");
  const chapter = readme
    .split(/^## /m)
    .slice(1)
    .find((section) => /^Services\s*$/m.test(section.split("\n")[0]));
  if (!chapter) {
    warn(pkg.label, `declares services but README.md has no "## Services" chapter`);
    return;
  }
  const listed = new Set([...chapter.matchAll(/^-\s+\*\*(.+?)\*\*/gm)].map((m) => m[1]));
  for (const name of declared) {
    if (!listed.has(name))
      warn(pkg.label, `"${name}" is declared but missing from the README "## Services" chapter`);
  }
  for (const name of listed) {
    if (!declared.has(name))
      warn(pkg.label, `README "## Services" lists "${name}", which is not declared`);
  }
}

function checkGraph(graph, packageNames, hasCommunityTree) {
  for (const [name, edge] of graph) {
    if (edge.consumers.length === 0) continue;
    if (edge.providers.length === 0) {
      if (EXTERNAL_SERVICES.has(name)) continue;
      // Core consuming something nothing provides is an open extension point,
      // not broken wiring — a package supplies it or none does. A *package*
      // consuming an unprovided service is a rename that landed on one side,
      // but only when the whole graph is visible: without pkg_lumine checked
      // out beside this repo, half the providers are simply absent.
      const consumedOnlyByCore = edge.consumers.every((c) => c.label.startsWith("src/"));
      const report = consumedOnlyByCore || !hasCommunityTree ? warn : error;
      report(
        "graph",
        `"${name}" is consumed by ${edge.consumers.map((c) => c.label).join(", ")} but nothing provides it`,
      );
      continue;
    }
    for (const consumer of edge.consumers) {
      const satisfied = edge.providers.some((provider) =>
        provider.versions.some((version) => semver.satisfies(version, consumer.range)),
      );
      if (!satisfied) {
        error(
          "graph",
          `${consumer.label} consumes "${name}" at ${consumer.range}, ` +
            `but the only provided versions are ${[...new Set(edge.providers.flatMap((p) => p.versions))].join(", ")}`,
        );
      }
    }
  }

  // Style: names are matched as opaque strings since service-hub was flattened,
  // so a prefix pair is no longer a delivery hazard — but it does mean a family
  // was split inconsistently.
  const names = [...graph.keys()];
  for (const a of names) {
    for (const b of names) {
      if (a !== b && b.startsWith(`${a}.`)) {
        warn("style", `"${a}" is a dot-prefix of "${b}"; one family, two shapes`);
      }
    }
  }

  for (const name of names) {
    const segments = name.split(".");
    if (segments.length === 1) continue;
    if (segments.length > 2) {
      warn("style", `"${name}" has more than two segments`);
    }
    const [namespace] = segments;
    if (!GENERAL_DOMAINS.has(namespace) && !packageNames.has(namespace)) {
      warn(
        "style",
        `"${name}" has namespace "${namespace}", which is neither a package nor a general domain`,
      );
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(segments[1])) {
      warn("style", `"${name}" capability segment is not kebab-case`);
    }
  }
}

// --- main ------------------------------------------------------------------

function main() {
  const lumineRoot = path.resolve(__dirname, "..");
  const workspaceRoot = path.resolve(process.argv[2] ?? path.join(lumineRoot, ".."));

  const communityRoot = path.join(workspaceRoot, "pkg_lumine");
  const hasCommunityTree = fs.existsSync(communityRoot);
  const packages = [
    ...readPackages(path.join(lumineRoot, "packages")),
    ...readPackages(communityRoot),
  ];
  const packageNames = new Set(packages.map((p) => p.name));

  const graph = new Map();
  const edge = (name) => {
    if (!graph.has(name)) graph.set(name, { providers: [], consumers: [] });
    return graph.get(name);
  };

  for (const pkg of packages) {
    for (const [name, entry] of Object.entries(pkg.manifest.providedServices ?? {})) {
      edge(name).providers.push({ label: pkg.label, versions: Object.keys(entry.versions ?? {}) });
    }
    for (const [name, entry] of Object.entries(pkg.manifest.consumedServices ?? {})) {
      for (const range of Object.keys(entry.versions ?? {})) {
        edge(name).consumers.push({ label: pkg.label, range });
      }
    }
    checkDeclaredMethods(pkg);
    checkDuplicateConsumerMethods(pkg);
    checkReadmeServices(pkg);
  }

  const core = readCoreServices(path.join(lumineRoot, "src"));
  for (const { name, version, where } of core.provided) {
    edge(name).providers.push({ label: where, versions: [version] });
  }
  for (const { name, version, where } of core.consumed) {
    edge(name).consumers.push({ label: where, range: version });
  }

  checkGraph(graph, packageNames, hasCommunityTree);

  for (const message of warnings) console.log(`warn  ${message}`);
  for (const message of errors) console.log(`ERROR ${message}`);

  console.log(
    `\n${packages.length} packages, ${graph.size} services, ` +
      `${core.provided.length + core.consumed.length} core registrations — ` +
      `${errors.length} error(s), ${warnings.length} warning(s)`,
  );

  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
