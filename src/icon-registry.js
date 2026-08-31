const fs = require("fs");
const path = require("path");
const { CompositeDisposable, Disposable, Emitter } = require("@lumine-code/event-kit");
const { normalizeTarget, cacheKeyFor, defaultDataName } = require("./icon-target");
const { Icon, NONE } = require("./icon-descriptor");
const createPathProvider = require("./icon-path-provider");
const { createNameProvider, createKindProvider } = require("./icon-vocabulary");

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// One application per element, so a second `applyTo` on the same element
// replaces the first instead of layering on top of it.
const APPLICATIONS = new WeakMap();

// Paths are the only open-ended vocabulary; names and kinds are closed sets of
// a few dozen entries and live in plain Maps. Metadata gets its own budget: it
// is cheaper than repeating filesystem or repository lookups, and a project
// with a few thousand visible entries must fit without a cyclic LRU scan
// evicting every entry before the next pass reaches it.
const DEFAULT_CACHE_SIZES = Object.freeze({ path: 16000, filesystem: 16000, repository: 16000 });
const REPOSITORY_INVALIDATION_DELAY = 16;

class LRUCache {
  constructor(maxSize, onEvict = null) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.onEvict = onEvict;
    this.newestKey = null;
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    // A repeatedly requested hot entry is already newest. Avoiding a delete +
    // set here matters in a Map with thousands of entries, where repeatedly
    // moving the same key otherwise accumulates enough tombstones to trigger
    // periodic O(n) compaction.
    if (key !== this.newestKey) {
      this.cache.delete(key);
      this.cache.set(key, value);
      this.newestKey = key;
    }
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      const oldestValue = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.onEvict?.(oldestKey, oldestValue);
    }
    this.cache.set(key, value);
    this.newestKey = key;
  }

  delete(key) {
    if (!this.cache.has(key)) return false;
    const value = this.cache.get(key);
    this.cache.delete(key);
    if (key === this.newestKey) this.newestKey = null;
    this.onEvict?.(key, value);
    return true;
  }

  take(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    if (key === this.newestKey) this.newestKey = null;
    return value;
  }

  clear() {
    const entries = this.onEvict ? Array.from(this.cache) : null;
    this.cache.clear();
    this.newestKey = null;
    if (entries) {
      for (const [key, value] of entries) this.onEvict(key, value);
    }
  }

  keys() {
    return this.cache.keys();
  }

  has(key) {
    return this.cache.has(key);
  }
}

class PathPrefixIndex {
  constructor() {
    this.root = this.node();
  }

  node() {
    return { children: new Map(), paths: new Set() };
  }

  segments(normalizedPath) {
    return normalizedPath.split(path.sep).filter((segment) => segment.length > 0);
  }

  add(filePath, normalizedPath) {
    let node = this.root;
    for (const segment of this.segments(normalizedPath)) {
      let child = node.children.get(segment);
      if (!child) node.children.set(segment, (child = this.node()));
      node = child;
    }
    node.paths.add(filePath);
  }

  delete(filePath, normalizedPath) {
    let node = this.root;
    const branch = [];
    for (const segment of this.segments(normalizedPath)) {
      const child = node.children.get(segment);
      if (!child) return;
      branch.push([node, segment, child]);
      node = child;
    }
    node.paths.delete(filePath);
    for (let index = branch.length - 1; index >= 0; index--) {
      const [parent, segment, child] = branch[index];
      if (child.paths.size > 0 || child.children.size > 0) break;
      parent.children.delete(segment);
    }
  }

  pathsUnder(normalizedPath) {
    let node = this.root;
    for (const segment of this.segments(normalizedPath)) {
      node = node.children.get(segment);
      if (!node) return [];
    }
    const paths = [];
    const pending = [node];
    while (pending.length > 0) {
      const current = pending.pop();
      paths.push(...current.paths);
      pending.push(...current.children.values());
    }
    return paths;
  }

  minimalPaths() {
    const paths = [];
    const pending = [this.root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node.paths.size > 0) paths.push(...node.paths);
      else pending.push(...node.children.values());
    }
    return paths;
  }
}

const CORE_NONE = Object.freeze({ descriptor: NONE, core: true });

// Everything one `applyTo` call put on one element, so disposing it can put the
// element back exactly as it was. Tracking additions rather than rewriting
// `className` is what keeps `status-modified`, `squashed-dir` and `selected`
// alive across an icon change.
class Application {
  constructor(registry, element, input, options) {
    this.registry = registry;
    this.element = element;
    this.input = snapshotTarget(input);
    this.target = normalizeTarget(this.input);
    this.options = options;
    this.key = cacheKeyFor(this.target, { context: registry.contextSensitive });
    this.descriptor = null;
    this.addedClasses = [];
    this.previousAttributes = new Map();
    this.styleProperties = [];
    this.child = null;
    this.disposed = false;
    // Held by the registry's bindings, so it must not close over anything the
    // application does not already own.
    this.ref = new WeakRef(this);
    this.targetSubscriptions = new CompositeDisposable();
    this.hasTargetSubscriptions = false;
    this.boundPath = null;

    if (this.options.live && this.input.item) {
      this.subscribeToTarget(this.input.item, "onDidChangeIcon");
      this.subscribeToTarget(this.input.item, "onDidChangePath");
      if (this.hasTargetSubscriptions) this.registry.trackTargetSubscriptions(this);
    }
  }

  subscribeToTarget(item, method) {
    if (typeof item[method] !== "function") return;
    const applicationRef = this.ref;
    const subscription = item[method](() => {
      const application = applicationRef.deref();
      if (!application) return;
      application.target = normalizeTarget(application.input);
      application.apply();
    });
    if (subscription && typeof subscription.dispose === "function") {
      this.targetSubscriptions.add(subscription);
      this.hasTargetSubscriptions = true;
    } else {
      console.warn(`Icon target ${method} must return a Disposable`, item);
    }
  }

  apply() {
    if (this.disposed) return;

    // The cache key folds in whether any provider varies by context, which can
    // change when a provider is added or removed.
    const key = cacheKeyFor(this.target, { context: this.registry.contextSensitive });
    const targetChanged = key !== this.key;
    if (targetChanged) {
      this.registry.unbind(this);
      this.key = key;
      if (this.options.live) this.registry.bind(this);
    }

    const descriptor = this.registry.descriptorFor(this.target, this.options);
    if (Icon.equal(descriptor, this.descriptor)) {
      if (targetChanged) this.renderData();
      return;
    }
    this.undo();
    this.descriptor = descriptor;
    this.render(descriptor);
  }

  render(descriptor) {
    for (const name of this.options.classes) this.addClass(name);

    if (descriptor.render !== "none") {
      // `none` gets no `icon` class at all: that class alone reserves the
      // glyph's right margin, which would leave a gap where no icon is.
      this.addClass("icon");
      for (const name of descriptor.classes) this.addClass(name);
    }

    this.renderData();
    if (descriptor.title) this.setAttribute("title", descriptor.title);

    if (!this.options.render) return;

    if (descriptor.color) {
      this.setStyleProperty("--icon-color", descriptor.color);
      this.addClass("icon-tinted");
    }

    switch (descriptor.render) {
      case "image":
        this.setStyleProperty("--icon-image", `url("${descriptor.source}")`);
        break;
      case "svg": {
        const svg = document.createElementNS(SVG_NAMESPACE, "svg");
        svg.setAttribute("class", "icon-glyph");
        if (descriptor.viewBox) svg.setAttribute("viewBox", descriptor.viewBox);
        svg.innerHTML = descriptor.svg;
        this.appendChild(svg);
        break;
      }
      case "letter": {
        const span = document.createElement("span");
        span.className = "icon-letter-glyph";
        span.textContent = descriptor.letter;
        this.appendChild(span);
        break;
      }
      default:
        break;
    }
  }

  renderData() {
    if (!this.options.setData) return;
    this.setAttribute("data-name", this.options.name ?? defaultDataName(this.target));
    this.setAttribute("data-path", this.target.path);
  }

  addClass(name) {
    // Only record what was not already there, so disposing never strips a class
    // the consumer or another package owns.
    if (this.element.classList.contains(name)) return;
    this.element.classList.add(name);
    this.addedClasses.push(name);
  }

  setAttribute(name, value) {
    if (!this.previousAttributes.has(name)) {
      this.previousAttributes.set(name, this.element.getAttribute(name));
    }
    if (value == null) this.element.removeAttribute(name);
    else this.element.setAttribute(name, value);
  }

  setStyleProperty(name, value) {
    this.element.style.setProperty(name, value);
    this.styleProperties.push(name);
  }

  appendChild(node) {
    this.element.appendChild(node);
    this.child = node;
  }

  undo() {
    for (const name of this.addedClasses) this.element.classList.remove(name);
    this.addedClasses = [];

    for (const [name, previous] of this.previousAttributes) {
      if (previous == null) this.element.removeAttribute(name);
      else this.element.setAttribute(name, previous);
    }
    this.previousAttributes.clear();

    for (const name of this.styleProperties) this.element.style.removeProperty(name);
    this.styleProperties = [];

    if (this.child) {
      this.child.remove();
      this.child = null;
    }
    this.descriptor = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.undo();
    this.registry.unbind(this);
    this.registry.untrackTargetSubscriptions(this);
    this.targetSubscriptions.dispose();
    if (APPLICATIONS.get(this.element) === this) APPLICATIONS.delete(this.element);
  }
}

function snapshotTarget(target) {
  return Object.freeze({
    ...target,
    hints: target.hints == null ? target.hints : Object.freeze({ ...target.hints }),
  });
}

function normalizedPrefix(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  let normalized = path.resolve(filePath);
  const root = path.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(path.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function compactPrefixes(prefixes) {
  const normalized = new Set(
    Array.from(prefixes ?? [], normalizedPrefix).filter((prefix) => prefix != null),
  );
  const index = new PathPrefixIndex();
  for (const prefix of normalized) index.add(prefix, prefix);
  return index.minimalPaths();
}

/**
 * @public
 * @status essential
 *
 * The single source of every icon the editor renders — file-type
 * icons, the semantic names pane items return from `getIconName()`, and LSP
 * symbol kinds.
 *
 * Providers form a priority chain. Each is asked in turn, and returning `null`
 * means "not mine, ask the next one"; core's octicon mapping is the always
 * present provider at the bottom, so every target resolves. Returning
 * `Icon.none()` is *not* the same as `null` — it stops the chain with "no icon
 * here".
 *
 * An instance of this class is always available as the `lumine.icons` global.
 */
module.exports = class IconRegistry {
  constructor({ config, themeManager, grammarRegistry, packageManager, cacheSizes } = {}) {
    this.config = config;
    this.themes = themeManager;
    this.grammars = grammarRegistry;
    this.packageManager = packageManager;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.projectSubscriptions = new CompositeDisposable();
    this.repositorySubscriptions = new CompositeDisposable();
    this.repositories = null;
    this.overrides = { name: new Map(), kind: new Map() };
    this.applications = new Map();
    this.keysByPath = new Map();
    this.warnedProviders = new Set();
    this.destroyed = false;
    this.bindingGeneration = 0;
    this.cacheSizes = { ...DEFAULT_CACHE_SIZES, ...cacheSizes };
    this.repositoryInvalidationPrefixes = new Set();
    this.repositoryInvalidationTimer = null;
    const registryRef = new WeakRef(this);
    this.applicationFinalizer = new FinalizationRegistry(({ key, ref, filePath, generation }) => {
      registryRef.deref()?.finalizeBinding(key, ref, filePath, generation);
    });
    this.targetSubscriptionFinalizer = new FinalizationRegistry((subscriptions) => {
      subscriptions.dispose();
    });

    this.clear();

    // An icon set that swaps its palette between light and dark answers
    // differently after a theme change. Owning the subscription here means
    // every provider gets that for free instead of wiring it themselves.
    if (this.themes?.onDidChangeActiveThemes) {
      this.subscriptions.add(this.themes.onDidChangeActiveThemes(() => this.invalidateAll()));
    }
    if (this.config?.onDidChange) {
      this.subscriptions.add(
        this.config.onDidChange("core.customFileTypes", () => this.invalidate({ types: ["path"] })),
      );
    }
    // Icon themes keyed on language rather than extension resolve through the
    // grammar registry, so a newly added grammar can change their answers.
    if (this.grammars?.onDidAddGrammar) {
      const onGrammarChange = () => this.invalidate({ types: ["path"] });
      this.subscriptions.add(
        this.grammars.onDidAddGrammar(onGrammarChange),
        this.grammars.onDidUpdateGrammar(onGrammarChange),
      );
    }
  }

  // Watch the project for the renames and deletions that change what a path's
  // icon should be.
  attachProject(project) {
    this.projectSubscriptions.dispose();
    this.projectSubscriptions = new CompositeDisposable();
    if (!project?.onDidChangeFiles) return;
    this.projectSubscriptions.add(
      project.onDidChangeFiles((events) => {
        const paths = [];
        for (const event of events) {
          if (event.path) paths.push(event.path);
          if (event.oldPath) paths.push(event.oldPath);
        }
        if (paths.length > 0) this.invalidate({ paths });
      }),
    );
  }

  // Repository discovery is asynchronous and changes the semantic identity of
  // directory paths after they may already be on screen. Keep path metadata
  // here so every consumer gets the same answer without duplicating filesystem
  // checks, repository routing, or repaint subscriptions.
  attachRepositories(repositories) {
    this.cancelRepositoryInvalidation();
    this.repositorySubscriptions.dispose();
    this.repositorySubscriptions = new CompositeDisposable();
    this.repositories = repositories ?? null;
    if (this.repositories?.onDidChange) {
      this.repositorySubscriptions.add(
        this.repositories.onDidChange((event) =>
          this.queueRepositoryInvalidation(event?.routingChangedPrefixes),
        ),
      );
    }
    this.clearRepositoryMetadata();
    this.invalidate({ types: ["path"] });
  }

  // Drop every package-supplied provider and cached answer, leaving the core
  // chain. Called when the window is reset.
  clear() {
    this.cancelRepositoryInvalidation();
    for (const registration of this.registrations ?? []) registration.subscription?.dispose();
    for (const set of this.applications?.values() ?? []) {
      for (const ref of Array.from(set)) ref.deref()?.dispose();
    }
    this.bindingGeneration++;
    this.applications = new Map();
    this.keysByPath = new Map();
    this.pathByKey = new Map();
    this.normalizedPaths = new Map();
    this.pathIndex = new PathPrefixIndex();
    this.repositoryDependentPaths = new Set();
    this.activePathCounts = new Map();
    this.activeFilesystemMetadata = new Map();
    this.activeRepositoryMetadata = new Map();
    this.registrations = [];
    this.nextRegistrationOrder = 0;
    this.contextSensitive = false;
    this.caches = {
      path: new LRUCache(this.cacheSizes.path, (key) => this.prunePathKey(key)),
      name: new Map(),
      kind: new Map(),
    };
    this.filesystemMetadata = new LRUCache(this.cacheSizes.filesystem);
    this.repositoryMetadata = new LRUCache(this.cacheSizes.repository, (filePath) =>
      this.pruneRepositoryPath(filePath),
    );

    this.addProvider(createPathProvider(), { priority: -100, core: true });
    this.addProvider(createNameProvider(this.overrides.name), { priority: -90, core: true });
    this.addProvider(createKindProvider(this.overrides.kind), { priority: -90, core: true });

    // Resubscribed here rather than in the constructor because resetting the
    // window runs `PackageManager#reset`, which clears every consumer off the
    // service hub. A subscription made once at construction would survive the
    // first reset in name only, and no provider would ever reach the chain
    // again.
    this.serviceSubscription?.dispose();
    this.serviceSubscription = this.packageManager?.serviceHub?.consume(
      "icons.provider",
      "^1.0.0",
      (provider) => this.addProvider(provider),
    );
  }

  /**
   * @public
   * @status essential
   *
   * Register an icon provider. Returns a `Disposable`.
   *
   * Providers are consulted highest `priority` first, and equal priorities keep
   * registration order. `iconFor(target)` returns an icon descriptor, or
   * `null` to defer to the next provider.
   */
  addProvider(provider, { priority = 0, id = null, core = false } = {}) {
    if (!provider || typeof provider.iconFor !== "function") {
      throw new TypeError("Icon providers must implement iconFor(target)");
    }
    const resolvedPriority = provider.priority ?? priority;
    if (!Number.isFinite(resolvedPriority)) {
      throw new TypeError("Icon provider priority must be a finite number");
    }

    const registration = {
      provider,
      core,
      priority: resolvedPriority,
      order: this.nextRegistrationOrder++,
      id: provider.id ?? id ?? `icon-provider-${this.nextRegistrationOrder}`,
      handles: Array.isArray(provider.handles) ? new Set(provider.handles) : null,
      subscription: null,
    };

    if (provider.async === true && typeof provider.onDidChange !== "function") {
      console.warn(
        `Icon provider "${registration.id}" declares async but has no onDidChange, ` +
          `so answers it resolves later will never reach the editor.`,
      );
    }
    if (typeof provider.onDidChange === "function") {
      registration.subscription = provider.onDidChange((scope) => this.invalidate(scope));
    }

    this.registrations.push(registration);
    this.registrations.sort((a, b) => b.priority - a.priority || a.order - b.order);
    this.updateContextSensitivity();
    this.invalidateAll();

    return new Disposable(() => {
      const index = this.registrations.indexOf(registration);
      if (index === -1) return;
      this.registrations.splice(index, 1);
      registration.subscription?.dispose();
      this.warnedProviders.delete(registration.id);
      this.updateContextSensitivity();
      this.invalidateAll();
    });
  }

  updateContextSensitivity() {
    this.contextSensitive = this.registrations.some((r) => r.provider.usesContext === true);
  }

  /**
   * @public
   * @status essential
   *
   * Resolve `target` to an icon descriptor. Never returns null — a
   * target nothing answers for resolves to `Icon.none()`.
   *
   * `target` is an object: `{path}`, `{name}`, `{kind}`, or `{item}` for a pane
   * item. It may also carry a `context` string naming the caller and a `hints`
   * object describing what the caller already knows about the path — see
   * `src/icon-target.js`.
   */
  iconFor(target, options = {}) {
    return this.descriptorFor(normalizeTarget(target), options);
  }

  descriptorFor(normalized, { skipFallback = false } = {}) {
    const entry = this.resolveEntry(normalized);
    // "Only show an icon if something other than the built-in mapping had an
    // opinion" — what keeps a plain tab's title unadorned.
    if (skipFallback && entry.core) return NONE;
    return entry.descriptor;
  }

  enrichTarget(normalized) {
    if (normalized.type !== "path" || !normalized.path || normalized.hints.virtual) {
      return normalized;
    }

    const hints = normalized.hints;
    let { directory, symlink, submodule, repositoryRoot } = hints;

    const needsDirectory = directory === undefined;
    const needsDirectorySymlink = directory === true && symlink === undefined;
    let inspectedFilesystem = false;
    if ((needsDirectory || needsDirectorySymlink) && path.isAbsolute(normalized.path)) {
      const metadata = this.metadataForPath(normalized.path, { filesystem: true });
      inspectedFilesystem = true;
      directory ??= metadata.directory;
      symlink ??= metadata.symlink;
    }

    if (
      directory !== false &&
      (repositoryRoot === undefined || submodule === undefined) &&
      this.repositories?.getForPath
    ) {
      this.markRepositoryDependent(normalized.path);
      const metadata = this.metadataForPath(normalized.path, { repositories: true });
      repositoryRoot ??= metadata.repositoryRoot;
      submodule ??= metadata.submodule;
    }

    // A failed lookup still answers the filesystem question. Resolve a missing
    // path by name after repository routing had its chance to prove that it is
    // a directory, rather than letting the fallback provider repeat `lstat`.
    if (inspectedFilesystem) {
      directory ??= false;
      symlink ??= false;
    }
    if ((repositoryRoot || submodule) && hints.directory === undefined) directory = true;
    if (
      directory === hints.directory &&
      symlink === hints.symlink &&
      submodule === hints.submodule &&
      repositoryRoot === hints.repositoryRoot
    ) {
      return normalized;
    }
    return Object.freeze({
      ...normalized,
      hints: Object.freeze({ ...hints, directory, symlink, submodule, repositoryRoot }),
    });
  }

  filesystemMetadataForPath(filePath) {
    return this.activeFilesystemMetadata.get(filePath) ?? this.filesystemMetadata.get(filePath);
  }

  setFilesystemMetadata(filePath, metadata) {
    if (this.activePathCounts.has(filePath)) this.activeFilesystemMetadata.set(filePath, metadata);
    else this.filesystemMetadata.set(filePath, metadata);
  }

  deleteFilesystemMetadata(filePath) {
    this.activeFilesystemMetadata.delete(filePath);
    this.filesystemMetadata.delete(filePath);
  }

  repositoryMetadataForPath(filePath) {
    return this.activeRepositoryMetadata.get(filePath) ?? this.repositoryMetadata.get(filePath);
  }

  setRepositoryMetadata(filePath, metadata) {
    if (this.activePathCounts.has(filePath)) this.activeRepositoryMetadata.set(filePath, metadata);
    else this.repositoryMetadata.set(filePath, metadata);
  }

  deleteRepositoryMetadata(filePath) {
    this.activeRepositoryMetadata.delete(filePath);
    this.repositoryMetadata.delete(filePath);
    this.pruneRepositoryPath(filePath);
  }

  clearRepositoryMetadata() {
    this.activeRepositoryMetadata.clear();
    this.repositoryMetadata.clear();
  }

  metadataForPath(filePath, { filesystem = false, repositories = false } = {}) {
    let metadata = {};

    if (filesystem) {
      let resolved = this.filesystemMetadataForPath(filePath);
      if (!resolved) {
        let directory;
        let symlink;
        try {
          const stats = fs.lstatSync(filePath);
          directory = stats.isDirectory();
          symlink = stats.isSymbolicLink();
          if (symlink) directory = fs.statSync(filePath).isDirectory();
        } catch {
          // Missing, remote, and stale paths still receive useful name-based
          // icons. Repository routing below may independently prove a directory.
        }
        resolved = { directory, symlink };
        this.setFilesystemMetadata(filePath, resolved);
      }
      metadata = { ...metadata, ...resolved };
    }

    if (repositories) {
      let resolved = this.repositoryMetadataForPath(filePath);
      if (!resolved) {
        const repository = this.repositories?.getForPath?.(filePath) ?? null;
        resolved = {
          repositoryRoot: repository != null && repository.relativize?.(filePath) === "",
          submodule: repository?.isSubmodule?.(filePath) === true,
        };
        this.setRepositoryMetadata(filePath, resolved);
      }
      metadata = { ...metadata, ...resolved };
      if (resolved.repositoryRoot || resolved.submodule) metadata.directory = true;
    }
    return metadata;
  }

  resolveEntry(normalized) {
    const key = cacheKeyFor(normalized, { context: this.contextSensitive });
    if (key == null) return CORE_NONE;

    const cache = this.caches[normalized.type];
    const cached = cache.get(key);
    if (cached) return cached;

    // Explicit and unknown hints have distinct keys. Enrichment is therefore
    // needed only on a miss; a warm lookup can return the descriptor without a
    // repository lookup, filesystem-cache touch, or fresh frozen target.
    const entry = this.resolveUncached(this.enrichTarget(normalized));
    cache.set(key, entry);
    if (normalized.type === "path") this.indexPathKey(normalized.path, key);
    return entry;
  }

  resolveUncached(normalized) {
    for (const registration of this.registrations) {
      if (registration.handles && !registration.handles.has(normalized.type)) continue;

      let descriptor;
      try {
        const answer = registration.provider.iconFor(normalized);
        if (answer == null) continue;
        descriptor = Icon.coerce(answer, { providerId: registration.id });
      } catch (error) {
        // One misbehaving provider costs its own icon, not the whole chain.
        if (!this.warnedProviders.has(registration.id)) {
          this.warnedProviders.add(registration.id);
          console.error(`Icon provider "${registration.id}" threw`, error);
        }
        continue;
      }
      return { descriptor, core: registration.core };
    }
    return CORE_NONE;
  }

  /**
   * @public
   * @status essential
   *
   * Render `target`'s icon into `element` and keep it current.
   *
   * `live` re-renders as providers come and go and as centrally derived path
   * metadata changes. An `{item}` target also follows its icon-name and path
   * events. Explicit target hints are read once; a caller changing one of those
   * calls `applyTo` again and replaces the old application on the element
   * wholesale.
   *
   * @param {Element} element - The element that receives the icon.
   * @param {Object} target - The icon target.
   * @param {Object} [options] - Rendering options.
   * @param {Array<String>} [options.classes] - Extra classes to add.
   * @param {String} [options.name] - An explicit `data-name`.
   * @param {Boolean} [options.setData=true] - Set `data-name` and `data-path`.
   * @param {Boolean} [options.live=true] - Re-render when a provider change alters the icon.
   * @param {Boolean} [options.render=true] - Render children and styles in
   *   addition to applying classes.
   * @param {Boolean} [options.skipFallback=false] - Render nothing unless a
   *   provider above the built-in answers.
   * @returns {Disposable} that removes everything the call added.
   */
  applyTo(element, target, options = {}) {
    if (!element) throw new TypeError("applyTo needs an element to render into");

    normalizeTarget(target);
    const resolved = {
      classes: options.classes ?? [],
      name: options.name,
      setData: options.setData !== false,
      live: options.live !== false,
      render: options.render !== false,
      skipFallback: options.skipFallback === true,
    };

    APPLICATIONS.get(element)?.dispose();

    const application = new Application(this, element, target, resolved);
    APPLICATIONS.set(element, application);
    if (resolved.live) this.bind(application);
    application.apply();
    return application;
  }

  bind(application) {
    let set = this.applications.get(application.key);
    if (!set) this.applications.set(application.key, (set = new Set()));
    // Weakly, so a transient row — a fuzzy-finder result, a symbol in a list
    // rebuilt on every keystroke — is collected with its element instead of
    // being pinned here until something happens to invalidate its key. A
    // consumer that wants a definite lifetime holds the returned Disposable.
    set.add(application.ref);
    this.pinApplicationPath(application);
    this.applicationFinalizer.register(
      application,
      {
        key: application.key,
        ref: application.ref,
        filePath: application.boundPath,
        generation: this.bindingGeneration,
      },
      application,
    );
  }

  unbind(application) {
    this.applicationFinalizer.unregister(application);
    this.unpinApplicationPath(application);
    const set = this.applications.get(application.key);
    if (!set) return;
    set.delete(application.ref);
    if (set.size === 0) {
      this.applications.delete(application.key);
      this.prunePathKey(application.key);
    }
  }

  finalizeBinding(key, ref, filePath, generation) {
    if (generation !== this.bindingGeneration) return;
    this.unpinPath(filePath);
    const set = this.applications.get(key);
    if (!set) return;
    set.delete(ref);
    if (set.size === 0) {
      this.applications.delete(key);
      this.prunePathKey(key);
    }
  }

  trackTargetSubscriptions(application) {
    this.targetSubscriptionFinalizer.register(
      application,
      application.targetSubscriptions,
      application,
    );
  }

  untrackTargetSubscriptions(application) {
    this.targetSubscriptionFinalizer.unregister(application);
  }

  pinApplicationPath(application) {
    const filePath = application.target.type === "path" ? application.target.path : null;
    application.boundPath = filePath;
    if (filePath == null) return;
    const count = this.activePathCounts.get(filePath) ?? 0;
    this.activePathCounts.set(filePath, count + 1);
    if (count > 0) return;

    const filesystem = this.filesystemMetadata.take(filePath);
    if (filesystem !== undefined) this.activeFilesystemMetadata.set(filePath, filesystem);
    const repository = this.repositoryMetadata.take(filePath);
    if (repository !== undefined) this.activeRepositoryMetadata.set(filePath, repository);
  }

  unpinApplicationPath(application) {
    const filePath = application.boundPath;
    application.boundPath = null;
    this.unpinPath(filePath);
  }

  unpinPath(filePath) {
    if (filePath == null) return;
    const count = this.activePathCounts.get(filePath);
    if (count == null) return;
    if (count > 1) {
      this.activePathCounts.set(filePath, count - 1);
      return;
    }
    this.activePathCounts.delete(filePath);
    const filesystem = this.activeFilesystemMetadata.get(filePath);
    if (filesystem !== undefined) {
      this.activeFilesystemMetadata.delete(filePath);
      this.filesystemMetadata.set(filePath, filesystem);
    }
    const repository = this.activeRepositoryMetadata.get(filePath);
    if (repository !== undefined) {
      this.activeRepositoryMetadata.delete(filePath);
      this.repositoryMetadata.set(filePath, repository);
    }
  }

  pathHasLiveApplications(filePath) {
    return (this.activePathCounts.get(filePath) ?? 0) > 0;
  }

  // Resolve a bound set, dropping the entries whose application has been
  // collected.
  liveApplications(key, into) {
    const set = this.applications.get(key);
    if (!set) return;
    for (const ref of set) {
      const application = ref.deref();
      if (application) into.add(application);
      else set.delete(ref);
    }
    if (set.size === 0) {
      this.applications.delete(key);
      this.prunePathKey(key);
    }
  }

  /**
   * @public
   * @status extended
   *
   * Drop cached answers and repaint what they were rendered into.
   *
   * `scope` is undefined or null for everything, or an object narrowing it to
   * `{types}`, `{paths}`, `{pathPrefixes}`, `{names}`, or `{kinds}`. Narrowing
   * matters: a provider that resolves one file extension asynchronously should
   * repaint the rows showing that extension, not every row in the tree.
   */
  invalidate(scope) {
    const affected = new Set();
    const resolvedScope =
      scope != null && typeof scope === "object" && Object.keys(scope).length === 0 ? null : scope;

    if (resolvedScope == null) {
      for (const cache of Object.values(this.caches)) cache.clear();
      for (const key of Array.from(this.applications.keys())) {
        this.liveApplications(key, affected);
      }
    } else {
      for (const type of resolvedScope.types ?? []) this.dropType(type, affected);
      for (const filePath of resolvedScope.paths ?? []) this.dropPath(filePath, affected);
      this.dropPathPrefixes(compactPrefixes(resolvedScope.pathPrefixes), affected);
      for (const name of resolvedScope.names ?? []) this.dropIdentity("name", name, affected);
      for (const kind of resolvedScope.kinds ?? []) this.dropIdentity("kind", kind, affected);
    }

    this.flush(affected);
    this.emitter.emit("did-change", resolvedScope ?? null);
  }

  invalidateAll() {
    this.invalidate(null);
  }

  dropType(type, affected) {
    const cache = this.caches[type];
    if (!cache) return;
    if (type === "path") {
      // A live application can outlast its bounded descriptor-cache entry. The
      // path index contains both cached and live keys, so a type invalidation
      // still repaints every bound element above the cache limit.
      for (const keys of Array.from(this.keysByPath.values())) {
        for (const key of Array.from(keys)) this.collect(key, affected);
      }
    } else {
      for (const key of Array.from(cache.keys())) this.collect(key, affected);
    }
    cache.clear();
  }

  dropPath(filePath, affected) {
    this.deleteFilesystemMetadata(filePath);
    this.deleteRepositoryMetadata(filePath);
    this.dropPathAnswer(filePath, affected);
  }

  dropPathAnswer(filePath, affected) {
    const keys = this.keysByPath.get(filePath);
    if (!keys) return;
    for (const key of Array.from(keys)) {
      this.caches.path.delete(key);
      this.collect(key, affected);
      this.prunePathKey(key);
    }
  }

  dropPathPrefixes(prefixes, affected) {
    if (prefixes.length === 0) return;
    const index = new PathPrefixIndex();
    for (const filePath of this.keysByPath.keys()) {
      index.add(filePath, normalizedPrefix(filePath));
    }
    const paths = new Set();
    for (const prefix of prefixes) {
      for (const filePath of index.pathsUnder(prefix)) paths.add(filePath);
    }
    for (const filePath of paths) this.dropPathAnswer(filePath, affected);
  }

  dropIdentity(type, identity, affected) {
    const cache = this.caches[type];
    if (!cache) return;
    const suffix = `\0${identity}`;
    for (const key of Array.from(cache.keys())) {
      if (!key.endsWith(suffix)) continue;
      cache.delete(key);
      this.collect(key, affected);
    }
  }

  collect(key, affected) {
    this.liveApplications(key, affected);
  }

  indexPathKey(filePath, key) {
    let keys = this.keysByPath.get(filePath);
    if (!keys) this.keysByPath.set(filePath, (keys = new Set()));
    keys.add(key);
    this.pathByKey.set(key, filePath);
  }

  ensureIndexedPath(filePath) {
    if (this.normalizedPaths.has(filePath)) return;
    const normalized = normalizedPrefix(filePath);
    this.normalizedPaths.set(filePath, normalized);
    this.pathIndex.add(filePath, normalized);
  }

  markRepositoryDependent(filePath) {
    this.repositoryDependentPaths.add(filePath);
    this.ensureIndexedPath(filePath);
  }

  hasRepositoryMetadata(filePath) {
    return this.activeRepositoryMetadata.has(filePath) || this.repositoryMetadata.has(filePath);
  }

  pruneRepositoryPath(filePath) {
    if (this.keysByPath.has(filePath) || this.hasRepositoryMetadata(filePath)) return;
    this.repositoryDependentPaths.delete(filePath);
    const normalized = this.normalizedPaths.get(filePath);
    if (normalized != null) this.pathIndex.delete(filePath, normalized);
    this.normalizedPaths.delete(filePath);
  }

  prunePathKey(key) {
    if (this.caches?.path?.has(key) || this.applications?.has(key)) return;
    const filePath = this.pathByKey?.get(key);
    if (filePath == null) return;
    this.pathByKey.delete(key);
    const keys = this.keysByPath.get(filePath);
    keys?.delete(key);
    if (keys?.size === 0) {
      this.keysByPath.delete(filePath);
      this.pruneRepositoryPath(filePath);
    }
  }

  queueRepositoryInvalidation(prefixes) {
    // Repository events unrelated to routing — operation providers are the
    // common case — cannot alter repository-root or submodule icons.
    if (!Array.isArray(prefixes) || prefixes.length === 0) return;
    for (const prefix of prefixes) {
      const normalized = normalizedPrefix(prefix);
      if (normalized != null) this.repositoryInvalidationPrefixes.add(normalized);
    }
    if (
      this.repositoryInvalidationPrefixes.size === 0 ||
      this.repositoryInvalidationTimer != null
    ) {
      return;
    }
    this.repositoryInvalidationTimer = setTimeout(
      () => this.flushRepositoryInvalidations(),
      REPOSITORY_INVALIDATION_DELAY,
    );
  }

  cancelRepositoryInvalidation() {
    if (this.repositoryInvalidationTimer != null) clearTimeout(this.repositoryInvalidationTimer);
    this.repositoryInvalidationTimer = null;
    this.repositoryInvalidationPrefixes.clear();
  }

  flushRepositoryInvalidations() {
    if (this.repositoryInvalidationTimer != null) clearTimeout(this.repositoryInvalidationTimer);
    this.repositoryInvalidationTimer = null;
    const prefixes = compactPrefixes(this.repositoryInvalidationPrefixes);
    this.repositoryInvalidationPrefixes.clear();
    if (prefixes.length === 0) return;

    const affected = new Set();
    const paths = new Set();
    for (const prefix of prefixes) {
      for (const filePath of this.pathIndex.pathsUnder(prefix)) {
        if (this.repositoryDependentPaths.has(filePath)) paths.add(filePath);
      }
    }
    for (const filePath of paths) {
      // Inactive cached answers can be dropped and recomputed lazily. Only live
      // elements need an eager repository lookup, and even those repaint only
      // when the two icon-relevant repository facts actually changed.
      if (!this.pathHasLiveApplications(filePath)) {
        this.deleteRepositoryMetadata(filePath);
        this.dropPathAnswer(filePath, affected);
        continue;
      }
      const previous = this.repositoryMetadataForPath(filePath);
      this.deleteRepositoryMetadata(filePath);
      const next = this.metadataForPath(filePath, { repositories: true });
      if (
        previous &&
        previous.repositoryRoot === next.repositoryRoot &&
        previous.submodule === next.submodule
      ) {
        continue;
      }
      this.dropPathAnswer(filePath, affected);
    }
    this.flush(affected);
    this.emitter.emit("did-change", { pathPrefixes: prefixes });
  }

  // Detached elements are repainted like any other. A consumer routinely builds
  // a row, gives it an icon and appends it afterwards — the tree view does
  // exactly that — so skipping what is not in the document yet means a row
  // built while one icon package was active keeps that package's classes for
  // the rest of its life, and shows nothing at all once the package is gone.
  // Bindings are weak, so an element nobody keeps is collected on its own and
  // needs no pruning here.
  flush(affected) {
    for (const application of affected) {
      if (!application.disposed) application.apply();
    }
  }

  /**
   * @public
   * @status extended
   *
   * Override the icon for one or more semantic names. Returns a
   * `Disposable` that restores the previous mapping. A `null` value means the
   * name renders no icon.
   */
  defineNames(entries) {
    return this.define("name", entries);
  }

  /**
   * @public
   * @status extended
   *
   * Override the icon for one or more kinds. Returns a `Disposable`.
   */
  defineKinds(entries) {
    return this.define("kind", entries);
  }

  define(type, entries) {
    const overrides = this.overrides[type];
    const previous = new Map();
    const keys = Object.keys(entries);
    for (const key of keys) {
      previous.set(key, overrides.get(key));
      overrides.set(key, entries[key]);
    }
    this.invalidate({ types: [type] });

    return new Disposable(() => {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) overrides.delete(key);
        else overrides.set(key, value);
      }
      this.invalidate({ types: [type] });
    });
  }

  /**
   * @public
   * @status extended
   *
   * Invoke `callback` when any icon may have changed.
   */
  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelRepositoryInvalidation();
    for (const set of Array.from(this.applications.values())) {
      for (const ref of Array.from(set)) ref.deref()?.dispose();
    }
    for (const registration of this.registrations) registration.subscription?.dispose();
    this.registrations = [];
    this.serviceSubscription?.dispose();
    this.projectSubscriptions.dispose();
    this.repositorySubscriptions.dispose();
    this.repositories = null;
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
};
