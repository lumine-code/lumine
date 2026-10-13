const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { types } = require("node:util");

// Node's require(esm) drops URL queries from the entry module's identity.
// Use virtual sibling filenames instead. No virtual files are written; the
// load hook reads the original source. Keeping the directory intact also
// preserves relative imports and native-module resolution on every platform.
const GENERATION_PREFIX = /^\.lumine-generation-(\d+)-(.+)$/;
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
const MODULE_EXTENSIONS = new Set([...JAVASCRIPT_EXTENSIONS, ".json"]);
const packages = new Map();
const dependencies = new Map();
const dependencyEdges = new Map();
const testModules = new Set();
const sourceMaps = new Map();
const moduleGenerations = new WeakMap();
const retiredModules = new Map();
const moduleSources = new Map();
const packageTypes = new Map();
let nextGeneration = 1;
let compiler = null;
let hooks = null;
let resourcePath = path.dirname(__dirname);
let apiSource = null;
let parser = null;

function prependAfterDirectives(source, prefix) {
  // A quoted first line can continue as an expression on the next line, so
  // a textual directive scan would accidentally make valid scripts strict.
  const ast = parseSource(source);
  let offset = ast.program.directives.at(-1)?.end ?? 0;
  if (offset === 0 && ast.program.interpreter) offset = source.indexOf("\n") + 1;
  return {
    output: source.slice(0, offset) + ";" + prefix + source.slice(offset),
    offset,
    length: prefix.length + 1,
  };
}

function parseSource(source) {
  if (typeof source !== "string") source = Buffer.from(source).toString("utf8");
  return parser.parse(source, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
  });
}

function hasModuleSyntax(source) {
  const ast = parseSource(source);
  if (ast.program.sourceType === "module") return true;
  // Node also detects ESM when a lexical declaration shadows one of the
  // CommonJS wrapper parameters, which cannot be redeclared in that wrapper.
  const wrapperNames = new Set(["require", "module", "exports", "__filename", "__dirname"]);
  return ast.program.body.some((node) => {
    if (
      node.type !== "ClassDeclaration" &&
      !(node.type === "VariableDeclaration" && node.kind !== "var")
    )
      return false;
    const identifiers =
      node.type === "ClassDeclaration"
        ? [node.id?.name]
        : node.declarations.flatMap((declaration) => bindingNames(declaration.id));
    return identifiers.some((name) => wrapperNames.has(name));
  });
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((property) =>
      bindingNames(property.type === "RestElement" ? property.argument : property.value),
    );
  return [];
}

function originalURL(url) {
  if (!url?.startsWith("file:")) return { url, generation: null };
  const parsed = new URL(url);
  const filePath = fileURLToPath(parsed);
  const match = GENERATION_PREFIX.exec(path.basename(filePath));
  if (!match) return { url, generation: null };
  const original = pathToFileURL(path.join(path.dirname(filePath), match[2]));
  original.search = parsed.search;
  original.hash = parsed.hash;
  return { url: original.href, generation: Number(match[1]) };
}

function packageOwnerOf(filePath) {
  let owner = null;
  let length = -1;
  for (const entry of packages.values()) {
    for (const root of entry.roots) {
      if ((filePath === root || filePath.startsWith(root + path.sep)) && root.length > length) {
        owner = entry;
        length = root.length;
      }
    }
  }
  return owner;
}

function contentDigest(contents) {
  return require("node:crypto").createHash("sha256").update(contents).digest("hex");
}

function dependencySignature(root) {
  try {
    const stat = fs.statSync(root);
    const manifest = fs.readFileSync(path.join(root, "package.json"));
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${contentDigest(manifest)}`;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return null;
  }
}

function ownerOf(filePath) {
  if (testModules.has(filePath)) return null;
  const parent = packageOwnerOf(filePath);
  if (!parent) return null;
  const root = [...parent.roots]
    .filter((candidate) => filePath === candidate || filePath.startsWith(candidate + path.sep))
    .sort((left, right) => right.length - left.length)[0];
  const parts = path.relative(root, filePath).split(path.sep);
  const modules = parts.lastIndexOf("node_modules");
  if (modules < 0 || !parts[modules + 1]) return parent;
  const end = modules + (parts[modules + 1].startsWith("@") ? 3 : 2);
  const dependencyRoot = path.join(root, ...parts.slice(0, end));
  let entry = dependencies.get(dependencyRoot);
  if (!entry) {
    entry = {
      kind: "dependency",
      parent,
      roots: new Set([dependencyRoot]),
      generation: 0,
      signature: dependencySignature(dependencyRoot),
      files: new Map(),
    };
    dependencies.set(dependencyRoot, entry);
  }
  return entry;
}

function resolveGeneration(owner, parentOwner, parentGeneration, requestedGeneration) {
  if (requestedGeneration != null) return requestedGeneration;
  if (parentOwner === owner && parentGeneration != null) return parentGeneration;
  if (owner.kind === "dependency" && parentGeneration != null) {
    let generations = dependencyEdges.get(parentOwner);
    if (!generations) dependencyEdges.set(parentOwner, (generations = new Map()));
    let edges = generations.get(parentGeneration);
    if (!edges) generations.set(parentGeneration, (edges = new Map()));
    if (!edges.has(owner)) edges.set(owner, owner.generation);
    return edges.get(owner);
  }
  return owner.generation;
}

function recordDependencySource(filePath, contents) {
  const owner = ownerOf(filePath);
  if (owner?.kind === "dependency" && !owner.files.has(filePath)) {
    owner.files.set(filePath, contentDigest(contents));
  }
}

function generationFilename(filename, generation) {
  if (generation === 0) return filename;
  return path.join(
    path.dirname(filename),
    `.lumine-generation-${generation}-${path.basename(filename)}`,
  );
}

function packageTypeAt(filePath, generation) {
  let cache = packageTypes.get(generation);
  if (!cache) packageTypes.set(generation, (cache = new Map()));
  let directory = path.dirname(filePath);
  const visited = [];
  let type;
  while (true) {
    if (cache.has(directory)) {
      type = cache.get(directory);
      break;
    }
    visited.push(directory);
    try {
      type = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).type;
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const entry of visited) cache.set(entry, type);
  return type;
}

function resolve(specifier, context, nextResolve) {
  const parent = originalURL(context.parentURL);
  let requestedGeneration = null;
  if (specifier.startsWith("file:")) {
    const original = originalURL(specifier);
    specifier = original.url;
    requestedGeneration = original.generation;
  } else if (path.isAbsolute(specifier)) {
    const original = originalURL(pathToFileURL(specifier).href);
    specifier = fileURLToPath(original.url);
    requestedGeneration = original.generation;
  }

  const adjustedContext =
    parent.generation == null ? context : { ...context, parentURL: parent.url };
  // The API is an object with lazy properties, so Node's static CommonJS
  // export analysis cannot expose all its named exports. Supply one shared
  // ESM facade while require('lumine') keeps returning the original object.
  if (specifier === "lumine" && !context.conditions.includes("require")) {
    return {
      url: pathToFileURL(path.join(resourcePath, "exports", ".lumine-api.mjs")).href,
      format: "module",
      shortCircuit: true,
    };
  }

  const result = nextResolve(specifier, adjustedContext);
  // _load routes managed require() requests to an explicit generation before
  // this hook. A raw CommonJS resolve is therefore public require.resolve(),
  // whose result must remain a real file for asset and grammar readers.
  if (context.conditions.includes("require") && requestedGeneration == null) return result;
  if (!result.url.startsWith("file:")) return result;
  const filePath = fileURLToPath(result.url);
  if (!MODULE_EXTENSIONS.has(path.extname(filePath))) return result;
  const owner = ownerOf(filePath);
  if (!owner) return result;
  const parentOwner = parent.url?.startsWith("file:") ? ownerOf(fileURLToPath(parent.url)) : null;
  const parentGeneration = parent.generation ?? (parentOwner?.kind === "dependency" ? 0 : null);
  const generation = resolveGeneration(owner, parentOwner, parentGeneration, requestedGeneration);
  const virtual = pathToFileURL(generationFilename(filePath, generation));
  const parsed = new URL(result.url);
  virtual.search = parsed.search;
  virtual.hash = parsed.hash;
  return { ...result, url: virtual.href };
}

function load(url, context, nextLoad) {
  const apiURL = pathToFileURL(path.join(resourcePath, "exports", ".lumine-api.mjs")).href;
  if (url === apiURL) {
    if (apiSource == null) {
      const apiPath = path.join(resourcePath, "exports", "lumine.js");
      const api = require(apiPath);
      const names = Object.keys(api).filter(
        (name) =>
          /^[A-Za-z_$][\w$]*$/.test(name) &&
          // This lazy UI getter cannot run in Electron's Node-only task host.
          // Leave it lazy on the default CommonJS object instead of evaluating
          // it merely because a task imports an unrelated named class.
          (name !== "WinShell" || process.type === "browser" || process.type === "renderer"),
      );
      apiSource =
        `import { createRequire } from "node:module";\n` +
        `const api = createRequire(${JSON.stringify(pathToFileURL(apiPath).href)})(${JSON.stringify(apiPath)});\n` +
        `export default api;\n` +
        names.map((name) => `export const ${name} = api[${JSON.stringify(name)}];`).join("\n");
    }
    return { format: "module", source: apiSource, shortCircuit: true };
  }
  const original = originalURL(url);
  if (!original.url.startsWith("file:")) return nextLoad(url, context);
  const filePath = fileURLToPath(original.url);
  const extension = path.extname(filePath);
  const sourceOwner = ownerOf(filePath);
  const saved =
    original.generation == null &&
    !(sourceOwner?.kind === "dependency" && sourceOwner.generation > 0)
      ? null
      : moduleSources.get(url);
  if (saved) {
    // Still let Node validate JSON import attributes for this request.
    if (extension === ".json") {
      nextLoad(original.url, context);
      const retired = retiredModules.get(fileURLToPath(url));
      // Node's JSON translator shares default exports with require.cache.
      // Restore that retired entry for a first late native JSON import too.
      if (retired) require.cache[fileURLToPath(url)] = retired;
    }
    return saved;
  }
  if (extension === ".json") {
    const result = { ...nextLoad(original.url, context), shortCircuit: true };
    recordDependencySource(filePath, result.source);
    moduleSources.set(url, result);
    const retired = retiredModules.get(fileURLToPath(url));
    if (retired) require.cache[fileURLToPath(url)] = retired;
    return result;
  }
  if (!JAVASCRIPT_EXTENSIONS.has(extension)) return nextLoad(url, context);
  const source = fs.readFileSync(filePath, "utf8");
  recordDependencySource(filePath, source);
  const compiled = compiler(source, filePath);
  // Unchanged installed JavaScript uses Node's native format detector and
  // source loader. Do not parse a 10 MB Plotly/Three bundle through Babel
  // merely to wrap a library whose canonical identity is already stable.
  if (
    original.generation == null &&
    compiled === source &&
    [".js", ".mjs", ".cjs"].includes(extension) &&
    (sourceOwner?.kind === "dependency" ||
      (!sourceOwner && filePath.includes(`${path.sep}node_modules${path.sep}`)))
  ) {
    const result = nextLoad(original.url, context);
    moduleSources.set(url, result);
    return result;
  }
  // Node has no built-in JSX loader. Babel removes JSX and types but leaves
  // module syntax; detect the resulting format only for these extensions.
  let result;
  if ([".jsx", ".ts", ".tsx"].includes(extension)) {
    const ast = parseSource(compiled);
    result = { format: ast.program.sourceType === "module" ? "module" : "commonjs" };
  } else {
    result = nextLoad(original.url, context);
  }
  if (extension === ".js") {
    // Node caches package.json types independently of module generations.
    // Read the nearest manifest once per generation, so a package update can
    // switch its .js files between CommonJS and ESM without stale formats.
    const type = packageTypeAt(filePath, original.generation ?? "unmanaged");
    result = {
      ...result,
      format: type === "module" ? "module" : type === "commonjs" ? "commonjs" : undefined,
    };
  }
  // For ambiguous .js sources let Node detect ESM, including transformed
  // pragma files. Explicit CommonJS remains CommonJS.
  const isModule =
    result.format === "module" || (result.format == null && hasModuleSyntax(compiled));
  let output = compiled;
  let insertion;
  if (original.generation != null) {
    // Assets, source maps and libraries such as MathJax use these public
    // paths. The loader retains its virtual identity independently of them.
    if (isModule) {
      let binding = "__lumineModuleLoader";
      while (output.includes(binding)) binding += "_";
      const prefix =
        `import ${binding} from ${JSON.stringify(pathToFileURL(__filename).href)};` +
        `${binding}.restoreImportMeta(import.meta, ${JSON.stringify({ url: original.url, filename: filePath, dirname: path.dirname(filePath) })}, ${JSON.stringify(url)});`;
      insertion = prependAfterDirectives(output, prefix);
    } else {
      const prefix =
        `__filename = ${JSON.stringify(filePath)};` +
        `require(${JSON.stringify(__filename)}).restoreCommonJSPaths(module, require, __filename);`;
      insertion = prependAfterDirectives(output, prefix);
    }
    output = insertion.output;
    recordSourceMap(url, original.url, compiled, insertion);
    output += `\n//# sourceURL=${original.url}`;
  }
  const resultSource = {
    ...result,
    format: isModule ? "module" : (result.format ?? "commonjs"),
    source: output,
    shortCircuit: true,
  };
  moduleSources.set(url, resultSource);
  return resultSource;
}

exports.install = function (compileSource, nodeRequire = require) {
  compiler = compileSource;
  if (hooks) return;
  // Load the standalone parser before registering hooks. Syntax detection
  // must not require Babel core while its own dependencies are loading.
  parser = Module.createRequire(require.resolve("@babel/core"))("@babel/parser");
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (specifier, ...args) {
    // Node's synchronous ESM translator can hand a pre-resolved CommonJS
    // filename back to _load with hooks disabled. It must retain the virtual
    // identity instead of looking for a physical generation file.
    if (path.isAbsolute(specifier) && GENERATION_PREFIX.test(path.basename(specifier))) {
      const actual = exports.getSourcePath(specifier);
      if (ownerOf(actual)) return specifier;
    }
    return resolveFilename.call(this, specifier, ...args);
  };
  const loadModule = Module._load;
  Module._load = function (specifier, parent, isMain, ...args) {
    if (Module.isBuiltin(specifier))
      return loadModule.call(this, specifier, parent, isMain, ...args);
    const resolved = Module._resolveFilename(specifier, parent, isMain);
    if (!path.isAbsolute(resolved))
      return loadModule.call(this, specifier, parent, isMain, ...args);
    const original = originalURL(pathToFileURL(resolved).href);
    const filename = fileURLToPath(original.url);
    const owner = ownerOf(filename);
    if (!owner || !MODULE_EXTENSIONS.has(path.extname(filename))) {
      return loadModule.call(this, specifier, parent, isMain, ...args);
    }
    const caller =
      moduleGenerations.get(parent) ??
      (parent?.filename ? originalURL(pathToFileURL(parent.filename).href) : null);
    const parentOwner = caller?.url ? ownerOf(fileURLToPath(caller.url)) : null;
    const generation = resolveGeneration(
      owner,
      parentOwner,
      caller?.generation,
      original.generation,
    );
    // Route before Node's private relativeResolveCache shortcut. Retaining an
    // old generation in require.cache must not redirect a new package load
    // to the old filename before the public resolve hook can run.
    const virtualFilename = generationFilename(filename, generation);
    const retired = retiredModules.get(virtualFilename);
    if (retired) return retired.exports;
    const loaded = loadModule.call(this, virtualFilename, parent, isMain, ...args);
    if (generation === owner.generation && require.cache[virtualFilename]) {
      // Keep the usual require.cache[require.resolve(...)] relation for the
      // active CommonJS bridge, without giving retired generations that alias.
      require.cache[filename] = require.cache[virtualFilename];
      moduleGenerations.set(require.cache[virtualFilename], { url: original.url, generation });
    }
    return loaded;
  };
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Supported by Lumine's Node 24 runtime; synchronous hooks also cover require(esm).
  hooks = Module.registerHooks({ resolve, load });
  // CommonJS's extension inference still reads this table. Compilation is
  // shared by require() and import() through the load hook above.
  for (const extension of [".jsx", ".ts", ".tsx"]) {
    // eslint-disable-next-line n/no-deprecated-api -- Retain CommonJS extension inference; compilation itself lives in the shared load hook.
    if (!nodeRequire.extensions[extension])
      // eslint-disable-next-line n/no-deprecated-api -- Add an extension alias, not a separate transpiler.
      nodeRequire.extensions[extension] = nodeRequire.extensions[".js"];
  }
};

exports.setResourcePath = function (directory) {
  resourcePath = directory;
  apiSource = null;
};

exports.registerTestModule = function (filename) {
  const actual = exports.getSourcePath(path.resolve(filename));
  testModules.add(actual);
  try {
    testModules.add(fs.realpathSync(actual));
  } catch {
    /* A removed test may still have a cached module. */
  }
  for (const cached of Object.values(require.cache)) {
    if (cached.filename === actual) moduleGenerations.delete(cached);
  }
};

exports.registerPackage = function (directory) {
  const root = path.resolve(directory);
  if (packages.has(root)) return;
  const roots = new Set([root]);
  try {
    roots.add(fs.realpathSync(root));
  } catch {
    /* The package may have been removed. */
  }
  const existing = [...packages.values()].find((entry) =>
    [...roots].some((candidate) => entry.roots.has(candidate)),
  );
  if (existing) {
    for (const candidate of roots) existing.roots.add(candidate);
    packages.set(root, existing);
  } else {
    const entry = { roots, generation: nextGeneration++ };
    packages.set(root, entry);
    // Adopt an ordinary CommonJS copy loaded before package discovery, rather
    // than duplicating a bootstrap already used by a spec or service consumer.
    for (const filename of Object.keys(require.cache)) {
      const owner = ownerOf(filename);
      if (
        GENERATION_PREFIX.test(path.basename(filename)) ||
        (owner !== entry && !(owner?.kind === "dependency" && owner.parent === entry))
      )
        continue;
      if (!MODULE_EXTENSIONS.has(path.extname(filename))) continue;
      const cached = require.cache[filename];
      // A namespace already evaluated at an ordinary ESM URL cannot be
      // aliased into Node's separate ESM cache. Both managed import() and
      // require(esm) must evaluate the same new generation instead.
      const source = moduleSources.get(pathToFileURL(filename).href);
      if (
        path.extname(filename) === ".mjs" ||
        source?.format === "module" ||
        (source?.format == null && source?.source && hasModuleSyntax(source.source)) ||
        types.isModuleNamespaceObject(cached.exports)
      )
        continue;
      require.cache[generationFilename(filename, owner.generation)] = cached;
      if (source)
        moduleSources.set(
          pathToFileURL(generationFilename(filename, owner.generation)).href,
          source,
        );
      moduleGenerations.set(cached, {
        url: pathToFileURL(filename).href,
        generation: owner.generation,
      });
    }
  }
};

exports.invalidatePackage = function (directory) {
  const entry = packages.get(path.resolve(directory));
  // Library modules belong to their installed payload, not to each consumer
  // activation. Keep one Three.js/MathJax/etc. identity across package reloads;
  // a replaced manifest, installation directory or loaded source advances
  // only that dependency's generation.
  if (entry)
    for (const dependency of dependencies.values()) {
      if (dependency.parent !== entry) continue;
      const root = [...dependency.roots][0];
      const signature = dependencySignature(root);
      let changed = signature !== dependency.signature;
      if (!changed)
        for (const [filename, digest] of dependency.files) {
          try {
            if (contentDigest(fs.readFileSync(filename)) !== digest) {
              changed = true;
              break;
            }
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            changed = true;
            break;
          }
        }
      if (changed) {
        retireModules(dependency);
        dependency.generation = nextGeneration++;
        dependency.signature = signature;
        dependency.files.clear();
      }
    }
  if (entry) entry.generation = nextGeneration++;
  retireModules(entry ?? { roots: new Set([path.resolve(directory)]) });
};

function retireModules(entry) {
  const roots = entry.roots;
  for (const modulePath of Object.keys(require.cache)) {
    // Retired exports keep old callbacks coherent while require.cache stops
    // exposing modules belonging to an unloaded package.
    if (
      [...roots].some((root) => modulePath === root || modulePath.startsWith(root + path.sep)) &&
      (ownerOf(exports.getSourcePath(modulePath)) === entry || !packages.has([...roots][0]))
    ) {
      if (GENERATION_PREFIX.test(path.basename(modulePath)) || entry.kind === "dependency")
        retiredModules.set(modulePath, require.cache[modulePath]);
      delete require.cache[modulePath];
    }
  }
}

exports.getSourcePath = function (filePath) {
  if (!filePath.startsWith("file:") && !path.isAbsolute(filePath)) return filePath;
  return fileURLToPath(
    originalURL(filePath.startsWith("file:") ? filePath : pathToFileURL(filePath).href).url,
  );
};

exports.restoreImportMeta = function (meta, publicPaths, url) {
  const resolve = meta.resolve;
  meta.resolve = (...args) => originalURL(resolve(...args)).url;
  // A standard createRequire(import.meta.url) uses the public source URL,
  // which cannot identify an old generation. Offer its generation-bound
  // equivalent for packages that lazily cross back into CommonJS.
  meta.require = Module.createRequire(url);
  meta.require.resolve("node:module");
  const requireResolve = meta.require.resolve;
  meta.require.resolve = (...args) => exports.getSourcePath(requireResolve(...args));
  meta.require.resolve.paths = requireResolve.paths;
  Object.assign(meta, publicPaths);
};

exports.restoreCommonJSPaths = function (module, nodeRequire, filename) {
  // Capture Node's internal parent URL before restoring the public filename.
  // Subsequent lazy require() calls then stay in this module's generation.
  nodeRequire.resolve("node:module");
  moduleGenerations.set(module, originalURL(pathToFileURL(module.filename).href));
  module.filename = filename;
  const resolve = nodeRequire.resolve;
  nodeRequire.resolve = (...args) => exports.getSourcePath(resolve(...args));
  nodeRequire.resolve.paths = resolve.paths;
};

function recordSourceMap(url, sourceURL, source, insertion) {
  // Reuse source-map-support's own synchronous source-map implementation.
  const { SourceMapGenerator, SourceMapConsumer } = Module.createRequire(
    require.resolve("source-map-support"),
  )("source-map");
  const before = source.slice(0, insertion.offset).split("\n");
  const line = before.length;
  const column = before[before.length - 1].length;
  let generator = new SourceMapGenerator({ file: url });
  const shift = (position) => ({
    line: position.line,
    column:
      position.column +
      (position.line === line && position.column >= column ? insertion.length : 0),
  });
  const maps = (parseSource(source).comments ?? [])
    .filter((comment) => comment.type === "CommentLine")
    .map((comment) =>
      /^\s*[@#]\s*sourceMappingURL=data:application\/json[^,]*,([^\s]+)\s*$/.exec(comment.value),
    )
    .filter(Boolean);
  let mapped = false;
  if (maps.length) {
    try {
      const raw = JSON.parse(Buffer.from(maps[maps.length - 1][1], "base64").toString());
      const consumer = new SourceMapConsumer(raw);
      consumer.eachMapping((mapping) => {
        if (mapping.source == null || mapping.originalLine == null) return;
        generator.addMapping({
          generated: shift({ line: mapping.generatedLine, column: mapping.generatedColumn }),
          original: { line: mapping.originalLine, column: mapping.originalColumn },
          source: mapping.source,
          name: mapping.name || undefined,
        });
      });
      for (const name of consumer.sources) {
        const content = consumer.sourceContentFor(name, true);
        if (content != null) generator.setSourceContent(name, content);
      }
      mapped = true;
    } catch {
      // Invalid diagnostic metadata must not prevent a valid module loading.
      generator = new SourceMapGenerator({ file: url });
    }
  }
  if (!mapped) {
    // Uncompiled sources need a map too, so stack frames do not expose the
    // private generation filename. Preserve columns rather than only lines.
    const sourceName = path.basename(fileURLToPath(sourceURL));
    source.split("\n").forEach((text, index) => {
      const positions = new Set([
        0,
        ...[...text.matchAll(/[A-Za-z_$][\w$]*|[^\s]/g)].map((match) => match.index),
      ]);
      for (const position of positions) {
        generator.addMapping({
          generated: shift({ line: index + 1, column: position }),
          original: { line: index + 1, column: position },
          source: sourceName,
        });
      }
    });
    generator.setSourceContent(sourceName, source);
  }
  sourceMaps.set(fileURLToPath(url), { map: generator.toJSON(), url: sourceURL });
}

exports.getSourceMap = function (filePath) {
  if (filePath.startsWith("file:")) filePath = fileURLToPath(filePath);
  return sourceMaps.get(filePath) ?? null;
};
