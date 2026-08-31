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
// a few dozen entries and live in plain Maps.
const PATH_CACHE_SIZE = 4000;

class LRUCache {
  constructor(maxSize) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, value);
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  keys() {
    return this.cache.keys();
  }
}

const CORE_NONE = Object.freeze({ descriptor: NONE, core: true });

// Everything one `applyTo` call put on one element, so disposing it can put the
// element back exactly as it was. Tracking additions rather than rewriting
// `className` is what keeps `status-modified`, `squashed-dir` and `selected`
// alive across an icon change.
class Application {
  constructor(registry, element, target, options) {
    this.registry = registry;
    this.element = element;
    this.target = target;
    this.options = options;
    this.key = cacheKeyFor(target, { context: registry.contextSensitive });
    this.descriptor = null;
    this.addedClasses = [];
    this.previousAttributes = new Map();
    this.styleProperties = [];
    this.child = null;
    this.disposed = false;
    // Held by the registry's bindings, so it must not close over anything the
    // application does not already own.
    this.ref = new WeakRef(this);
  }

  apply() {
    if (this.disposed) return;

    const target = this.registry.enrichTarget(this.target);
    // The cache key folds in whether any provider varies by context, which can
    // change when a provider is added or removed.
    const key = cacheKeyFor(target, { context: this.registry.contextSensitive });
    if (key !== this.key) {
      this.registry.unbind(this);
      this.key = key;
      if (this.options.live) this.registry.bind(this);
    }

    const descriptor = this.registry.descriptorFor(target, this.options);
    if (Icon.equal(descriptor, this.descriptor)) return;
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

    if (this.options.setData) {
      this.setAttribute("data-name", this.options.name ?? defaultDataName(this.target));
      this.setAttribute("data-path", this.target.path);
    }
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
    if (APPLICATIONS.get(this.element) === this) APPLICATIONS.delete(this.element);
  }
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
  constructor({ config, themeManager, grammarRegistry, packageManager } = {}) {
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
    this.repositorySubscriptions.dispose();
    this.repositorySubscriptions = new CompositeDisposable();
    this.repositories = repositories ?? null;
    if (this.repositories?.onDidChange) {
      this.repositorySubscriptions.add(
        this.repositories.onDidChange(() => {
          this.repositoryMetadata.clear();
          this.invalidate({ types: ["path"] });
        }),
      );
    }
    this.repositoryMetadata.clear();
    this.invalidate({ types: ["path"] });
  }

  // Drop every package-supplied provider and cached answer, leaving the core
  // chain. Called when the window is reset.
  clear() {
    for (const registration of this.registrations ?? []) registration.subscription?.dispose();
    for (const set of this.applications?.values() ?? []) {
      for (const ref of Array.from(set)) ref.deref()?.dispose();
    }
    this.applications = new Map();
    this.keysByPath = new Map();
    this.registrations = [];
    this.nextRegistrationOrder = 0;
    this.contextSensitive = false;
    this.caches = { path: new LRUCache(PATH_CACHE_SIZE), name: new Map(), kind: new Map() };
    this.filesystemMetadata = new LRUCache(PATH_CACHE_SIZE);
    this.repositoryMetadata = new LRUCache(PATH_CACHE_SIZE);

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
   * registration order. `iconFor(target)` returns an icon descriptor, a class
   * string or array, or `null` to defer to the next provider.
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
    return this.descriptorFor(this.enrichTarget(normalizeTarget(target)), options);
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

    if ((directory === undefined || symlink === undefined) && path.isAbsolute(normalized.path)) {
      const metadata = this.metadataForPath(normalized.path, { filesystem: true });
      directory ??= metadata.directory;
      symlink ??= metadata.symlink;
    }

    if (
      directory !== false &&
      (repositoryRoot === undefined || submodule === undefined) &&
      this.repositories?.getForPath
    ) {
      const metadata = this.metadataForPath(normalized.path, { repositories: true });
      repositoryRoot ??= metadata.repositoryRoot;
      submodule ??= metadata.submodule;
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

  metadataForPath(filePath, { filesystem = false, repositories = false } = {}) {
    let metadata = {};

    if (filesystem) {
      let resolved = this.filesystemMetadata.get(filePath);
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
        this.filesystemMetadata.set(filePath, resolved);
      }
      metadata = { ...metadata, ...resolved };
    }

    if (repositories) {
      let resolved = this.repositoryMetadata.get(filePath);
      if (!resolved) {
        const repository = this.repositories?.getForPath?.(filePath) ?? null;
        resolved = {
          repositoryRoot: repository != null && repository.relativize?.(filePath) === "",
          submodule: repository?.isSubmodule?.(filePath) === true,
        };
        this.repositoryMetadata.set(filePath, resolved);
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

    const entry = this.resolveUncached(normalized);
    cache.set(key, entry);
    if (normalized.type === "path") {
      let keys = this.keysByPath.get(normalized.path);
      if (!keys) this.keysByPath.set(normalized.path, (keys = new Set()));
      keys.add(key);
    }
    return entry;
  }

  resolveUncached(normalized) {
    for (const registration of this.registrations) {
      if (registration.handles && !registration.handles.has(normalized.type)) continue;

      let answer;
      try {
        answer = registration.provider.iconFor(normalized);
      } catch (error) {
        // One misbehaving provider costs its own icon, not the whole chain.
        if (!this.warnedProviders.has(registration.id)) {
          this.warnedProviders.add(registration.id);
          console.error(`Icon provider "${registration.id}" threw`, error);
        }
        continue;
      }

      if (answer == null) continue;
      const descriptor = Icon.coerce(answer, { providerId: registration.id });
      if (descriptor == null) continue;
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
   * metadata changes. Explicit target hints are read once; a caller changing
   * one of those calls `applyTo` again and replaces the old application on the
   * element wholesale.
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

    const normalized = normalizeTarget(target);
    const resolved = {
      classes: options.classes ?? [],
      name: options.name,
      setData: options.setData !== false,
      live: options.live !== false,
      render: options.render !== false,
      skipFallback: options.skipFallback === true,
    };

    APPLICATIONS.get(element)?.dispose();

    const application = new Application(this, element, normalized, resolved);
    APPLICATIONS.set(element, application);
    if (resolved.live && application.key != null) this.bind(application);
    application.apply();
    return application;
  }

  bind(application) {
    if (application.key == null) return;
    let set = this.applications.get(application.key);
    if (!set) this.applications.set(application.key, (set = new Set()));
    // Weakly, so a transient row — a fuzzy-finder result, a symbol in a list
    // rebuilt on every keystroke — is collected with its element instead of
    // being pinned here until something happens to invalidate its key. A
    // consumer that wants a definite lifetime holds the returned Disposable.
    set.add(application.ref);
  }

  unbind(application) {
    const set = this.applications.get(application.key);
    if (!set) return;
    set.delete(application.ref);
    if (set.size === 0) this.applications.delete(application.key);
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
    if (set.size === 0) this.applications.delete(key);
  }

  /**
   * @public
   * @status extended
   *
   * Drop cached answers and repaint what they were rendered into.
   *
   * `scope` is undefined or null for everything, or an object narrowing it to
   * `{types}`, `{paths}`, `{names}`, or `{kinds}`. Narrowing matters: a
   * provider that resolves one file extension asynchronously should repaint the
   * rows showing that extension, not every row in the tree.
   */
  invalidate(scope) {
    const affected = new Set();

    if (scope == null) {
      for (const cache of Object.values(this.caches)) cache.clear();
      this.keysByPath.clear();
      for (const key of Array.from(this.applications.keys())) {
        this.liveApplications(key, affected);
      }
    } else {
      for (const type of scope.types ?? []) this.dropType(type, affected);
      for (const filePath of scope.paths ?? []) this.dropPath(filePath, affected);
      for (const name of scope.names ?? []) this.dropIdentity("name", name, affected);
      for (const kind of scope.kinds ?? []) this.dropIdentity("kind", kind, affected);
    }

    this.flush(affected);
    this.emitter.emit("did-change", scope ?? null);
  }

  invalidateAll() {
    this.invalidate(null);
  }

  dropType(type, affected) {
    const cache = this.caches[type];
    if (!cache) return;
    for (const key of Array.from(cache.keys())) this.collect(key, affected);
    cache.clear();
    if (type === "path") this.keysByPath.clear();
  }

  dropPath(filePath, affected) {
    this.filesystemMetadata.delete(filePath);
    this.repositoryMetadata.delete(filePath);
    const keys = this.keysByPath.get(filePath);
    if (!keys) return;
    for (const key of keys) {
      this.caches.path.delete(key);
      this.collect(key, affected);
    }
    this.keysByPath.delete(filePath);
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
