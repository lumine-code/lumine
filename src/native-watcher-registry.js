const path = require("path");

/**
 * re-join the segments split from an absolute path to form another absolute path.
 *
 * @private
 */
function absolute(...parts) {
  const candidate = path.join(...parts);
  return path.isAbsolute(candidate) ? candidate : path.join(path.sep, candidate);
}

/**
 * Map userland filesystem watcher subscriptions efficiently to
 * deliver filesystem change notifications to each watcher with the most
 * efficient coverage of native watchers.
 *
 * * If two watchers subscribe to the same directory, use a single native
 *   watcher for each.
 * * Re-use a native watcher watching a parent directory for a watcher on a
 *   child directory. If the parent directory watcher is removed, it will be
 *   split into child watchers.
 * * If any child directories already being watched, stop and replace them with
 *   a watcher on the parent directory.
 *
 * Uses a trie whose structure mirrors the directory structure.
 *
 * @private
 */
class RegistryTree {
  /**
   * Construct a tree with no native watchers.
   *
   * @param basePathSegments - the position of this tree's root relative to the filesystem's root as an `Array` of directory names.
   * @param {Function} createNative - used to construct new native watchers. It should accept an absolute path as an argument and return a new `NativeWatcher`.
   * @private
   */
  constructor(basePathSegments, createNative, getChildPaths) {
    this.basePathSegments = basePathSegments;
    this.root = new RegistryNode();
    this.createNative = createNative;
    this.getChildPaths = getChildPaths;
  }

  /**
   * Identify the native watcher that should be used to produce events
   * at a watched path, creating a new one if necessary.
   *
   * @param pathSegments - the path to watch represented as an `Array` of directory names relative to this `RegistryTree`'s root.
   * @param {Function} attachToNative - invoked with the appropriate native watcher and the absolute path to its watch root.
   * @private
   */
  add(pathSegments, attachToNative) {
    const absolutePathSegments = this.basePathSegments.concat(pathSegments);
    const absolutePath = absolute(...absolutePathSegments);

    const attachToNew = (childPaths) => {
      const native = this.createNative(absolutePath);
      const leaf = new RegistryWatcherNode(native, absolutePathSegments, childPaths);
      this.root = this.root.insert(pathSegments, leaf);

      const sub = native.onWillStop(() => {
        sub.dispose();
        const childPaths = this.getChildPaths(absolutePathSegments);
        this.root = this.root.remove(pathSegments) || new RegistryNode();

        // Rebuild still-requested descendants in this tree. Building a nested
        // RegistryTree here would leave its future removal callbacks updating
        // a detached root reference, which retains empty structural nodes.
        for (const childPath of childPaths) {
          this.add(pathSegments.concat(childPath), (replacement, attachmentPath) => {
            native.reattachTo(replacement, attachmentPath);
          });
        }
      });

      attachToNative(native, absolutePath);
      return native;
    };

    this.root.lookup(pathSegments).when({
      parent: (parent, remaining) => {
        // An existing NativeWatcher is watching the same directory or a parent directory of the requested path.
        // Attach this Watcher to it as a filtering watcher and record it as a dependent child path.
        const native = parent.getNativeWatcher();
        parent.addChildPath(remaining);
        attachToNative(native, absolute(...parent.getAbsolutePathSegments()));
      },
      children: (children) => {
        // One or more NativeWatchers exist on child directories of the requested path. Create a new native watcher
        // on the parent directory, note the subscribed child paths, and cleanly stop the child native watchers.
        const newNative = attachToNew(children.map((child) => child.path));

        for (let i = 0; i < children.length; i++) {
          const childNode = children[i].node;
          const childNative = childNode.getNativeWatcher();
          childNative.reattachTo(newNative, absolutePath);
          childNative.stop().then(
            () => childNative.dispose(),
            () => childNative.dispose(),
          );
        }
      },
      missing: () => attachToNew([]),
    });
  }

  /**
   * Access the root node of the tree.
   *
   * @private
   */
  getRoot() {
    return this.root;
  }

  release(pathSegments, pathStillWatched) {
    if (pathStillWatched) return;
    this.root.lookup(pathSegments).when({
      parent: (parent, remaining) => parent.removeChildPath(remaining),
      children: () => {},
      missing: () => {},
    });
  }

  /**
   * @returns {String} representation of this tree's structure for diagnostics and testing.
   * @private
   */
  print() {
    return this.root.print();
  }
}

/**
 * Non-leaf node in a `RegistryTree` used by the `NativeWatcherRegistry` to cover the allocated `Watcher`
 * instances with the most efficient set of `NativeWatcher` instances possible. Each `RegistryNode` maps to a directory
 * in the filesystem tree.
 *
 * @private
 */
class RegistryNode {
  /**
   * Construct a new, empty node representing a node with no watchers.
   *
   * @private
   */
  constructor() {
    this.children = {};
  }

  /**
   * Recursively discover any existing watchers corresponding to a path.
   *
   * @param pathSegments - filesystem path of a new `Watcher` already split into an Array of directory names.
   * @returns {ParentResult|ChildrenResult|MissingResult} The matching watcher relationship.
   * @private
   */
  lookup(pathSegments) {
    if (pathSegments.length === 0) {
      return new ChildrenResult(this.leaves([]));
    }

    const child = this.children[pathSegments[0]];
    if (child === undefined) {
      return new MissingResult(this);
    }

    return child.lookup(pathSegments.slice(1));
  }

  /**
   * Insert a new `RegistryWatcherNode` into the tree, creating new intermediate `RegistryNode` instances as
   * needed. Any existing children of the watched directory are removed.
   *
   * @param pathSegments - filesystem path of the new `Watcher`, already split into an Array of directory names.
   * @param leaf - initialized `RegistryWatcherNode` to insert
   * @returns {RegistryNode|RegistryWatcherNode} The updated tree root.
   * @private
   */
  insert(pathSegments, leaf) {
    if (pathSegments.length === 0) {
      return leaf;
    }

    const pathKey = pathSegments[0];
    let child = this.children[pathKey];
    if (child === undefined) {
      child = new RegistryNode();
    }
    this.children[pathKey] = child.insert(pathSegments.slice(1), leaf);
    return this;
  }

  /**
   * Remove a `RegistryWatcherNode` by its exact watched directory.
   *
   * @param pathSegments - absolute pre-split filesystem path of the node to remove.
   * @returns {RegistryNode|RegistryWatcherNode|null} The updated tree root.
   * @private
   */
  remove(pathSegments) {
    if (pathSegments.length === 0) {
      // Attempt to remove a path with child watchers. Do nothing.
      return this;
    }

    const pathKey = pathSegments[0];
    const child = this.children[pathKey];
    if (child === undefined) {
      // Attempt to remove a path that isn't watched. Do nothing.
      return this;
    }

    // Recurse
    const newChild = child.remove(pathSegments.slice(1));
    if (newChild === null) {
      delete this.children[pathKey];
    } else {
      this.children[pathKey] = newChild;
    }

    // Remove this node if all of its children have been removed
    return Object.keys(this.children).length === 0 ? null : this;
  }

  /**
   * Discover all `RegistryWatcherNode` instances beneath this tree node and the child paths
   *  that they are watching.
   *
   * @param {Array} prefix - of intermediate path segments to prepend to the resulting child paths.
   * @returns {Array<Object>} The watcher nodes beneath this node and their paths.
   * @private
   */
  leaves(prefix) {
    const results = [];
    for (const p of Object.keys(this.children)) {
      results.push(...this.children[p].leaves(prefix.concat([p])));
    }
    return results;
  }

  /**
   * @returns {String} representation of this subtree for diagnostics and testing.
   * @private
   */
  print(indent = 0) {
    let spaces = "";
    for (let i = 0; i < indent; i++) {
      spaces += " ";
    }

    let result = "";
    for (const p of Object.keys(this.children)) {
      result += `${spaces}${p}\n${this.children[p].print(indent + 2)}`;
    }
    return result;
  }
}

/**
 * Leaf node within a `NativeWatcherRegistry` tree. Represents a directory that is covered by a
 * `NativeWatcher`.
 *
 * @private
 */
class RegistryWatcherNode {
  /**
   * Allocate a new node to track a `NativeWatcher`.
   *
   * @param nativeWatcher - An existing `NativeWatcher` instance.
   * @param absolutePathSegments - The absolute path to this `NativeWatcher`'s directory as an `Array` of path segments.
   * @param {Array} childPaths - of child directories that are currently the responsibility of this `NativeWatcher`, if any. Directories are represented as arrays of the path segments between this node's directory and the watched child path.
   * @private
   */
  constructor(nativeWatcher, absolutePathSegments, childPaths) {
    this.nativeWatcher = nativeWatcher;
    this.absolutePathSegments = absolutePathSegments;

    // Store child paths as joined strings so they work as Set members.
    this.childPaths = new Set();
    for (let i = 0; i < childPaths.length; i++) {
      this.childPaths.add(path.join(...childPaths[i]));
    }
  }

  /**
   * Record responsibility for a new child path for diagnostics. Active watcher ownership in
   * {@link NativeWatcherRegistry.watchedPaths} is authoritative when this native watcher is replaced.
   *
   * @param childPathSegments - the `Array` of path segments between this node's directory and the watched child directory.
   * @private
   */
  addChildPath(childPathSegments) {
    // An exact-path duplicate watcher (empty `childPathSegments`) shares this
    // node's native watcher without occupying a distinct child directory, so it
    // is not a child path. `path.join()` of zero segments is ".", which would
    // later be split back out into a phantom self-watcher on this same
    // directory when the node is removed — a native watcher nobody owns or
    // disposes (it leaks and prints as a stray `.` child). Record only real
    // sub-directories.
    if (childPathSegments.length === 0) return;
    this.childPaths.add(path.join(...childPathSegments));
  }

  /**
   * Stop recording responsibility for a previously assigned child path.
   *
   * @param childPathSegments - the `Array` of path segments between this node's directory and the no longer watched child directory.
   * @private
   */
  removeChildPath(childPathSegments) {
    // Symmetric with `addChildPath`: an exact-path share is not a child path,
    // so there is nothing to forget.
    if (childPathSegments.length === 0) return;
    this.childPaths.delete(path.join(...childPathSegments));
  }

  /**
   * Accessor for the `NativeWatcher`.
   *
   * @private
   */
  getNativeWatcher() {
    return this.nativeWatcher;
  }

  /**
   * @returns {Array} absolute path watched by this `NativeWatcher` as an `Array` of directory names.
   * @private
   */
  getAbsolutePathSegments() {
    return this.absolutePathSegments;
  }

  /**
   * Identify how this watcher relates to a request to watch a directory tree.
   *
   * @param pathSegments - filesystem path of a new `Watcher` already split into an Array of directory names.
   * @returns {ParentResult} A result referencing this node.
   * @private
   */
  lookup(pathSegments) {
    return new ParentResult(this, pathSegments);
  }

  /**
   * Remove this leaf node if the watcher's exact path matches. RegistryTree rebuilds any
   * still-owned descendants after removing this node from the main tree.
   *
   * @param pathSegments - filesystem path of the node to remove.
   * @returns {RegistryWatcherNode|null} `null` for an exact match, or this unchanged node otherwise.
   * @private
   */
  remove(pathSegments) {
    if (pathSegments.length !== 0) {
      return this;
    }
    return null;
  }

  /**
   * Discover this `RegistryWatcherNode` instance.
   *
   * @param {Array} prefix - of intermediate path segments to prepend to the resulting child paths.
   * @returns {Array<Object>} This node and its path.
   * @private
   */
  leaves(prefix) {
    return [{ node: this, path: prefix }];
  }

  /**
   * @returns {String} representation of this watcher for diagnostics and testing. Indicates the number of child paths that this node's `NativeWatcher` is responsible for.
   * @private
   */
  print(indent = 0) {
    let result = "";
    for (let i = 0; i < indent; i++) {
      result += " ";
    }
    result += "[watcher";
    if (this.childPaths.size > 0) {
      result += ` +${this.childPaths.size}`;
    }
    result += "]\n";

    return result;
  }
}

/**
 * A `RegistryNode` traversal result that's returned when neither a directory, its children, nor its parents
 * are present in the tree.
 *
 * @private
 */
class MissingResult {
  /**
   * Instantiate a new `MissingResult`.
   *
   * @param lastParent - the final successfully traversed `RegistryNode`.
   * @private
   */
  constructor(lastParent) {
    this.lastParent = lastParent;
  }

  /**
   * Dispatch within a map of callback actions.
   *
   * @param {Object} actions - containing a `missing` key that maps to a callback to be invoked when no results were returned by {@link RegistryNode.lookup}. The callback will be called with the last parent node that was encountered during the traversal.
   * @returns {*} The result of the `actions.missing` callback.
   * @private
   */
  when(actions) {
    return actions.missing(this.lastParent);
  }
}

/**
 * A {@link RegistryNode.lookup} traversal result that's returned when a parent or an exact match of the requested
 * directory is being watched by an existing `RegistryWatcherNode`.
 *
 * @private
 */
class ParentResult {
  /**
   * Instantiate a new `ParentResult`.
   *
   * @param parent - the `RegistryWatcherNode` that was discovered.
   * @param remainingPathSegments - an `Array` of the directories that lie between the leaf node's watched directory and the requested directory. This will be empty for exact matches.
   * @private
   */
  constructor(parent, remainingPathSegments) {
    this.parent = parent;
    this.remainingPathSegments = remainingPathSegments;
  }

  /**
   * Dispatch within a map of callback actions.
   *
   * @param {Object} actions - containing a `parent` key that maps to a callback to be invoked when a parent of a requested requested directory is returned by a {@link RegistryNode.lookup} call. The callback will be called with the `RegistryWatcherNode` instance and an `Array` of the `String` path segments that separate the parent node and the requested directory.
   * @returns {*} The result of the `actions.parent` callback.
   * @private
   */
  when(actions) {
    return actions.parent(this.parent, this.remainingPathSegments);
  }
}

/**
 * A {@link RegistryNode.lookup} traversal result that's returned when one or more children of the requested
 * directory are already being watched.
 *
 * @private
 */
class ChildrenResult {
  /**
   * Instantiate a new `ChildrenResult`.
   *
   * @param {Array} children - of the `RegistryWatcherNode` instances that were discovered.
   * @private
   */
  constructor(children) {
    this.children = children;
  }

  /**
   * Dispatch within a map of callback actions.
   *
   * @param {Object} actions - containing a `children` key that maps to a callback to be invoked when a parent of a requested requested directory is returned by a {@link RegistryNode.lookup} call. The callback will be called with the `RegistryWatcherNode` instance.
   * @returns {*} The result of the `actions.children` callback.
   * @private
   */
  when(actions) {
    return actions.children(this.children);
  }
}

/**
 * Track the directories being monitored by native filesystem watchers. Minimize the number of native watchers
 * allocated to receive events for a desired set of directories by:
 *
 * 1. Subscribing to the same underlying `NativeWatcher` when watching the same directory multiple times.
 * 2. Subscribing to an existing `NativeWatcher` on a parent of a desired directory.
 * 3. Replacing multiple `NativeWatcher` instances on child directories with a single new `NativeWatcher` on the
 *    parent.
 *
 * @private
 */
class NativeWatcherRegistry {
  /**
   * Instantiate an empty registry.
   *
   * @param {Function} createNative - that will be called with a normalized filesystem path to create a new native filesystem watcher.
   * @private
   */
  constructor(createNative) {
    this.watchedPaths = new Map();
    this.tree = new RegistryTree([], createNative, (parentPath) => this.getChildPaths(parentPath));
  }

  /**
   * Attach a watcher to a directory, assigning it a `NativeWatcher`. If a suitable `NativeWatcher` already
   * exists, it will be attached to the new `Watcher` with an appropriate subpath configuration. Otherwise, the
   * `createWatcher` callback will be invoked to create a new `NativeWatcher`, which will be registered in the tree
   * and attached to the watcher.
   *
   * If any pre-existing child watchers are removed as a result of this operation, {@link NativeWatcher.onWillReattach} will
   * be broadcast on each with the new parent watcher as an event payload to give child watchers a chance to attach to
   * the new watcher.
   *
   * @param watcher - an unattached `Watcher`.
   * @private
   */
  async attach(watcher) {
    const normalizedDirectory = await watcher.getNormalizedPathPromise();
    if (typeof normalizedDirectory !== "string" || normalizedDirectory.length === 0) {
      throw new TypeError(
        `A watcher's normalized path must be a non-empty string. Received ${String(normalizedDirectory)}`,
      );
    }
    const pathSegments = normalizedDirectory
      .split(path.sep)
      .filter((segment) => segment.length > 0);
    this.watchedPaths.set(watcher, pathSegments);

    this.tree.add(pathSegments, (native, nativePath) => {
      watcher.attachToNative(native, nativePath);
    });
  }

  detach(watcher) {
    const pathSegments = this.watchedPaths.get(watcher);
    if (!pathSegments) return;

    this.watchedPaths.delete(watcher);
    const pathStillWatched = Array.from(this.watchedPaths.values()).some((candidate) =>
      pathsEqual(candidate, pathSegments),
    );
    this.tree.release(pathSegments, pathStillWatched);
  }

  getChildPaths(parentPath) {
    const children = new Map();
    for (const watchedPath of this.watchedPaths.values()) {
      if (watchedPath.length <= parentPath.length || !pathStartsWith(watchedPath, parentPath)) {
        continue;
      }
      const relativePath = watchedPath.slice(parentPath.length);
      children.set(relativePath.join("\0"), relativePath);
    }
    return Array.from(children.values()).sort((a, b) => a.length - b.length);
  }

  /**
   * Generate a visual representation of the currently active watchers managed by this
   * registry.
   *
   * @returns {String} showing the tree structure.
   * @private
   */
  print() {
    return this.tree.print();
  }
}

function pathsEqual(left, right) {
  return left.length === right.length && pathStartsWith(left, right);
}

function pathStartsWith(candidate, prefix) {
  for (let i = 0; i < prefix.length; i++) {
    if (candidate[i] !== prefix[i]) return false;
  }
  return true;
}

module.exports = { NativeWatcherRegistry };
