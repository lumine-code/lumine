// Builds the service graph of the workspace: every bundled package, every
// pkg_lumine repo, and the services core registers directly on the serviceHub.
//
// Extracted from check-services.js so the website's service reference can build
// the same graph from a sibling checkout rather than reimplementing the AST
// walk. This module only collects; it reports nothing and exits nothing. The
// checks live in check-services.js, the rendering in the website generator.

const fs = require("fs");
const path = require("path");
const { parseSync } = require("@babel/core");

// Consumed here, provided by a package that lives outside the workspace.
const EXTERNAL_SERVICES = new Set(["claude-chat"]);

const CORE = Symbol("core");
const EXTERNAL = Symbol("external");

// Namespaces that name a general domain rather than a package, mapped to the
// package that owns the contracts in that domain — for a hub/plugin contract
// that is the *consumer*, since the hub defines the shape others provide into.
// Any namespace not listed here must match the name of a package.
//
// `null` marks a domain split across owners; those services are resolved
// individually in SERVICE_OWNERS below.
//
// Three of these are judgment calls rather than readings of the graph:
//   - `icons` has no hub at all — two providers, seven consumers, no definer.
//     native-icons provides both icons.class and icons.element, so it holds the
//     more complete implementation. This is the weakest entry in the table.
//   - `symbol` goes to symbols-view on merit: lib/main.d.ts already is the
//     contract and lib/provider-broker.js already validates it.
//   - `hyperclick` goes to symbols-view as the sole in-workspace definer; the
//     service has no consumer yet, so it is an extension point without a hub.
const GENERAL_DOMAINS = new Map([
  ["icons", "native-icons"],
  ["symbol", "symbols-view"],
  ["hyperclick", "symbols-view"],
  ["outline", "outline-view"],
  ["navigation", "navigation-panel"],
  ["search", "search-panel"],
  ["hyperlink", "language-hyperlink"],
  ["todo", "language-todo"],
  ["sofistik", "language-sofistik"],
  ["mcp", "lumine-mcp"],
  ["jupyter", null],
  ["project", CORE],
  ["workspace", CORE],
  ["repositories", CORE],
]);

// Services whose documentation owner is not derivable from the namespace.
const SERVICE_OWNERS = new Map([
  ["jupyter.kernel", "jupyter-repl"],
  ["jupyter.breakpoints", "jupyter-repl"],
  ["jupyter.adapter", "jupyter-view"],
  ["jupyter.notebook", "jupyter-view"],
  // Shares the `icons` namespace with the two package-to-package icon services
  // but is a different contract entirely: core's IconRegistry consumes it, and
  // an implementer supplies iconFor(target) rather than iconClassForPath().
  ["icons.provider", CORE],
  ["claude-chat", EXTERNAL],
]);

// The package responsible for documenting a service, or null when the name
// resolves to nothing — which is a naming-rule violation, not a missing doc.
function ownerFor(name, packageNames) {
  if (SERVICE_OWNERS.has(name)) return SERVICE_OWNERS.get(name);
  const dot = name.indexOf(".");
  if (dot === -1) return packageNames.has(name) ? name : null;
  const namespace = name.slice(0, dot);
  if (packageNames.has(namespace)) return namespace;
  if (GENERAL_DOMAINS.has(namespace)) return GENERAL_DOMAINS.get(namespace);
  return null;
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
      // `new Proxy(target, handler)` exports whatever the target carries. The
      // trap forwards everything else at runtime, but only the target is
      // visible to a reader — or to this check — so a package that wires
      // services through a proxy has to spell them out there.
      if (callee?.type === "Identifier" && callee.name === "Proxy") {
        const target = right.arguments?.[0];
        if (target?.type === "ObjectExpression") {
          for (const name of objectKeys(target)) names.add(name);
        } else if (target?.type === "Identifier" && localObjects.has(target.name)) {
          for (const name of objectKeys(localObjects.get(target.name))) names.add(name);
        }
      } else if (callee?.type === "Identifier") {
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

// `tree` is "bundled" or "community": the two differ in where their docs live
// relative to a repository root, which the website generator needs to build raw
// URLs. `problems` collects unparseable manifests for the caller to report.
function readPackages(root, tree, problems = []) {
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
      problems.push({
        where: path.relative(process.cwd(), manifestPath),
        message: `unparseable: ${e.message}`,
      });
      continue;
    }
    packages.push({
      name: manifest.name || entry.name,
      dir: path.join(root, entry.name),
      dirname: entry.name,
      tree,
      label: `${path.basename(root)}/${entry.name}`,
      manifest,
    });
  }
  return packages;
}

function readCoreServices(srcDir) {
  const found = { provided: [], consumed: [] };
  // `?.` has to be allowed: core reaches the hub through an optional chain in
  // more than one place, and without this a service registered that way drops
  // out of the graph entirely — the exact silence these checks exist to catch.
  const pattern =
    /serviceHub\s*\??\s*\.\s*(provide|consume)\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g;
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

// Reads both package trees plus core, and returns the whole service graph.
//
// `lumineRoot` is the editor repository; `workspaceRoot` is its parent, where
// pkg_lumine/* is checked out. `hasCommunityTree` is false in the editor repo's
// own CI, where half the providers are simply absent — callers must degrade
// their reporting accordingly rather than treating absence as breakage.
function buildGraph({ lumineRoot, workspaceRoot }) {
  const problems = [];
  const communityRoot = path.join(workspaceRoot, "pkg_lumine");
  const hasCommunityTree = fs.existsSync(communityRoot);
  const packages = [
    ...readPackages(path.join(lumineRoot, "packages"), "bundled", problems),
    ...readPackages(communityRoot, "community", problems),
  ];
  const packageNames = new Set(packages.map((p) => p.name));
  const byName = new Map(packages.map((p) => [p.name, p]));

  const graph = new Map();
  const edge = (name) => {
    if (!graph.has(name)) graph.set(name, { providers: [], consumers: [] });
    return graph.get(name);
  };

  for (const pkg of packages) {
    for (const [name, entry] of Object.entries(pkg.manifest.providedServices ?? {})) {
      edge(name).providers.push({
        label: pkg.label,
        package: pkg.name,
        versions: Object.keys(entry.versions ?? {}),
        methods: Object.values(entry.versions ?? {}),
      });
    }
    for (const [name, entry] of Object.entries(pkg.manifest.consumedServices ?? {})) {
      for (const [range, method] of Object.entries(entry.versions ?? {})) {
        edge(name).consumers.push({ label: pkg.label, package: pkg.name, range, method });
      }
    }
  }

  const core = readCoreServices(path.join(lumineRoot, "src"));
  for (const { name, version, where } of core.provided) {
    edge(name).providers.push({ label: where, versions: [version], methods: [] });
  }
  for (const { name, version, where } of core.consumed) {
    edge(name).consumers.push({ label: where, range: version });
  }

  return { packages, byName, packageNames, graph, core, hasCommunityTree, problems };
}

module.exports = {
  CORE,
  EXTERNAL,
  EXTERNAL_SERVICES,
  GENERAL_DOMAINS,
  SERVICE_OWNERS,
  ownerFor,
  parseFile,
  walk,
  resolveModule,
  exportedNames,
  sourceFiles,
  mentionsIdentifier,
  readPackages,
  readCoreServices,
  buildGraph,
};
