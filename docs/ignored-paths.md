# Ignored paths

Lumine applies ignore policy to project-file discovery, not to a file the user explicitly opened or selected. An ignored file can therefore be absent from the file finder and project search while its open editor, watcher, and file-scoped tools continue to work normally.

`core.ignoredNames` is the shared discovery baseline. A pattern without `/` matches a path component at any depth, a pattern containing `/` is relative to a project root, and matching a directory excludes its descendants. Paths and patterns accept either path separator and use the glob syntax shared by picomatch and ripgrep; shell extglobs such as `@(src|spec)` are treated literally. Packages compile that behavior with `lumine.project.compileIgnoredNames(additionalIgnoredNames, {useCoreIgnoredNames})`; the returned matcher is a snapshot and must be compiled again after relevant configuration changes.

`core.excludeVcsIgnoredPaths` is the default VCS policy for the shared `FileIndex`, `project.crawl()`, and `workspace.scan()`. A caller can override it with `excludeVcsIgnoredPaths`; this is independent of `ignoredNames`. Disabling it commonly reveals dependency and build-output directories, including `node_modules` when the repository ignores it.

The Command Palette exposes `core:toggle-vcs-ignored-paths` to change that global policy. An existing file index observes the setting and re-crawls automatically, so the command does not start a second refresh; if no consumer has requested the index yet, it remains uninitialized. `core:refresh-file-index` forces a shared re-crawl when an external filesystem change escaped the watcher and initializes the index on demand. Neither command has a default key binding or menu item.

The shared `FileIndex` contains the core discovery population only. A package that needs a narrower view filters index snapshots and deltas with its own ignored names; a package that needs a different VCS population performs its own `project.crawl()` with explicit options.

`project.crawl()` and `workspace.scan()` treat `ignoredNames` as additions to the core list and accept `useCoreIgnoredNames: false` to omit that list. VCS metadata directories `.git`, `.hg`, and `.svn` remain technical exclusions from bulk discovery regardless of these options.

`PathWatcher` and `project.onDidChangeFiles()` remain raw event sources. They report changes under ignored names, VCS-ignored paths, and VCS metadata so open buffers, repository state, ignore-rule changes, and consumers with different policies stay correct; filtering belongs to the index or the operation consuming those events.
