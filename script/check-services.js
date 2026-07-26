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
//
// The graph itself is built by service-graph.js, which the website's service
// reference reads from a sibling checkout.

const fs = require("fs");
const path = require("path");
const semver = require("semver");
const {
  CORE,
  EXTERNAL,
  EXTERNAL_SERVICES,
  GENERAL_DOMAINS,
  buildGraph,
  exportedNames,
  mentionsIdentifier,
  ownerFor,
  resolveModule,
} = require("./service-graph");

// Sections every service document must carry. Warned about rather than
// required, so a doc can be landed and filled in, but the list is the shape
// reviewers should expect.
const REQUIRED_DOC_SECTIONS = ["Registration", "Contract", "Minimal example", "Versioning"];

// Every service has a document. A new one without a document fails the build
// rather than quietly joining a backlog.
const DOCS_ARE_MANDATORY = true;

const errors = [];
const warnings = [];

function error(where, message) {
  errors.push(`${where}: ${message}`);
}

function warn(where, message) {
  warnings.push(`${where}: ${message}`);
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
  // The name may be wrapped in a Markdown link to the service document.
  const listed = new Set(
    [...chapter.matchAll(/^-\s+\*\*(?:\[)?(.+?)(?:\]\([^)]*\))?\*\*/gm)].map((m) => m[1]),
  );
  for (const name of declared) {
    if (!listed.has(name))
      warn(pkg.label, `"${name}" is declared but missing from the README "## Services" chapter`);
  }
  for (const name of listed) {
    if (!declared.has(name))
      warn(pkg.label, `README "## Services" lists "${name}", which is not declared`);
  }
}

// Every service is documented once, by the package that owns its namespace —
// which for a hub contract is the consumer, not the providers. See ownerFor()
// in service-graph.js.
function checkServiceDocs(pkg, graph, packageNames) {
  const docsDir = path.join(pkg.dir, "docs");
  const owned = [...graph.keys()].filter((name) => ownerFor(name, packageNames) === pkg.name);

  for (const name of owned) {
    const file = path.join(docsDir, `${name}.md`);
    if (!fs.existsSync(file)) {
      const report = DOCS_ARE_MANDATORY ? error : warn;
      report(pkg.label, `owns "${name}" but has no docs/${name}.md`);
      continue;
    }
    const doc = fs.readFileSync(file, "utf8");
    if (doc.split("\n")[0].trim() !== `# ${name}`) {
      warn(pkg.label, `docs/${name}.md does not open with "# ${name}"`);
    }

    const sections = new Set([...doc.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]));
    for (const section of REQUIRED_DOC_SECTIONS) {
      if (!sections.has(section)) warn(pkg.label, `docs/${name}.md has no "## ${section}"`);
    }

    // The doc has to name the method the reader must export.
    const entry = pkg.manifest.providedServices?.[name] ?? pkg.manifest.consumedServices?.[name];
    for (const method of Object.values(entry?.versions ?? {})) {
      if (!doc.includes(method)) warn(pkg.label, `docs/${name}.md never mentions ${method}()`);
    }

    // Cross-owner links go to the site by absolute URL, since a relative path
    // cannot cross a repository boundary on GitHub. Catch the ones that point
    // at a service that does not exist.
    for (const match of doc.matchAll(/lumine-code\.github\.io\/docs\.html#services\/([\w.-]+)/g)) {
      if (!graph.has(match[1])) {
        error(pkg.label, `docs/${name}.md links to "${match[1]}", which is not a service`);
      }
    }
  }

  if (!fs.existsSync(docsDir)) return;
  for (const file of fs.readdirSync(docsDir)) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    if (!graph.has(name)) {
      error(pkg.label, `docs/${file} documents "${name}", which is not a service`);
    } else if (!owned.includes(name)) {
      const owner = ownerFor(name, packageNames);
      error(
        pkg.label,
        `docs/${file} documents "${name}", which is owned by ` +
          `${typeof owner === "string" ? owner : "core"}`,
      );
    }
  }
}

// Services core registers on the serviceHub itself belong to no package, so
// their documents live in the website repository rather than here. Check them
// only when that repository is checked out beside this one; the website's own
// `npm run docs:services` is what enforces them where it matters.
function checkCoreServiceDocs(graph, packageNames, workspaceRoot) {
  const docsDir = path.join(workspaceRoot, "website", "docs", "services");
  if (!fs.existsSync(docsDir)) return;

  const owned = [...graph.keys()].filter((name) => ownerFor(name, packageNames) === CORE);
  for (const name of owned) {
    if (!fs.existsSync(path.join(docsDir, `${name}.md`))) {
      warn("core", `"${name}" is registered by src/ but website has no docs/services/${name}.md`);
    }
  }
  for (const file of fs.readdirSync(docsDir)) {
    if (file.endsWith(".md") && !owned.includes(file.slice(0, -3))) {
      warn("core", `website docs/services/${file} documents nothing core registers`);
    }
  }
}

function checkGraph(graph, packageNames, hasCommunityTree) {
  for (const [name, edge] of graph) {
    // Every service needs exactly one package responsible for documenting it.
    // A name that resolves to nobody is a naming-rule violation regardless of
    // what is checked out, so this is not gated on hasCommunityTree.
    if (ownerFor(name, packageNames) === null) {
      error(
        "graph",
        `"${name}" resolves to no documentation owner; ` +
          `add it to SERVICE_OWNERS in script/service-graph.js`,
      );
    }

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

  const { packages, packageNames, graph, core, hasCommunityTree, problems } = buildGraph({
    lumineRoot,
    workspaceRoot,
  });

  for (const { where, message } of problems) error(where, message);

  for (const pkg of packages) {
    checkDeclaredMethods(pkg);
    checkDuplicateConsumerMethods(pkg);
    checkReadmeServices(pkg);
  }

  // A second pass: doc ownership needs the whole graph, not one manifest.
  for (const pkg of packages) {
    checkServiceDocs(pkg, graph, packageNames);
  }
  checkCoreServiceDocs(graph, packageNames, workspaceRoot);

  checkGraph(graph, packageNames, hasCommunityTree);

  for (const message of warnings) console.log(`warn  ${message}`);
  for (const message of errors) console.log(`ERROR ${message}`);

  const documented = [...graph.keys()].filter((name) => {
    const owner = ownerFor(name, packageNames);
    // Core and external services are documented outside this repository.
    if (owner === EXTERNAL || owner === CORE) return true;
    const pkg = packages.find((p) => p.name === owner);
    return pkg ? fs.existsSync(path.join(pkg.dir, "docs", `${name}.md`)) : false;
  }).length;

  console.log(
    `\n${packages.length} packages, ${graph.size} services ` +
      `(${documented} documented), ` +
      `${core.provided.length + core.consumed.length} core registrations — ` +
      `${errors.length} error(s), ${warnings.length} warning(s)`,
  );

  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
