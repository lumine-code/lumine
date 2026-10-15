# Reproducible package screenshots

The editor owns the capture runner, `script/demo.js`. Each package owns its root-level `demo.js` recipe and small public fixtures in `demo/`. The runner uses `script/drive.js` to operate a real Lumine window. It has no dependency on the ecosystem manager or a private repository.

## Capture, review, accept

Install the editor's development dependencies and each participating package's dependencies using their normal setup instructions. Keep package checkouts beside the editor, or pass `--workspace` with their parent directory. The runner finds packages by their manifest name and requires local checkouts of the target, `one-theme` and every declared dependency. The editor supplies its remaining bundled packages from its installed dependencies.

From the editor checkout:

```sh
node script/demo.js capture ../bookmarks
node script/demo.js capture ../markdown-preview
node script/demo.js capture ../launcher
```

Each command creates a new directory below `<drive>:\Lumine-Demos` on Windows or `/tmp/Lumine-Demos` on macOS and Linux, copies the fixtures into a disposable project with a clean local Git baseline, launches a fresh isolated profile in normal mode, checks each scene, and saves raw and rounded PNGs. It uses default fonts, the One theme, a fixed window size and a 10-pixel corner mask. It closes its window afterward. Your normal editor profile and dev-mode setup remain untouched. `--out <new-directory>` chooses another neutral output location; existing directories and locations inside the source workspace or user profile are rejected, including junction aliases. If the default root is not writable, pass a writable neutral directory outside those private roots.

Demo processes set `LUMINE_DISABLE_URI_HANDLER_REGISTRATION=1`, so startup never checks, registers or removes the system's `lumine://` association. This is process-local and does not change the normal profile's preferences. Automatic update checks are also disabled in the disposable profile; the updater's own demo invokes its check explicitly.

Inspect every PNG in `images/`. Check the logo, rounded edges, readable content, expected feature, and absence of unwanted selections, notifications or dock buttons. Also inspect paths in prompts, pickers, input fields, notifications and diagnostics: only public fixture paths in the neutral capture tree may appear, never personal directories, account names, source checkout paths, machine-specific tool locations or private data. Fix the real scene and capture again; do not paint over the image. The raw captures remain in `raw/` for comparison. A failed capture has `status: "failed"`, an error and, when possible, `failure.png`; it cannot be accepted.

```sh
node script/demo.js check <capture-directory>
node script/demo.js accept <capture-directory> ../bookmarks
```

`check` verifies completeness, dimensions, hashes and exact duplicate images. `accept` verifies the target package and recipe, copies images to `.github/`, writes `.github/demo.json`, and replaces the standalone demo image paragraphs beneath `## Features` in the existing README. It preserves the other prose and never deletes other assets. Remove obsolete image files explicitly when retiring a scene. It never stages, commits or pushes files. Review the diff before publishing, especially when someone else is editing the same README.

The website uses stable image paths on `master`. Pushing a replacement image updates existing gallery entries after GitHub's cache expires. Additions, removals and caption changes require regenerating the website's gallery catalogue. Keep source revisions in capture metadata even though the public image URL follows the branch.

## Recipe contract

Recipes are trusted executable CommonJS modules, loaded in both Node and the editor renderer. Keep module loading free of side effects and access the editor only inside hooks. A recipe can use module-level constants and closures. Do not import the editor runtime at module scope.

```js
module.exports = {
  version: 1,
  dependencies: ["language-javascript"],
  fixtures: "demo", // default
  viewport: { width: 1100, height: 730 },
  async prepare({ open, state }) {
    state.editor = await open("example.js");
  },
  scenes: [
    {
      id: "primary-feature",
      file: "demo.png",
      caption: "Describe the feature visible in this image.",
      async run({ command }) {
        command("example:show");
      },
      ready() {
        return Boolean(document.querySelector(".example-view"));
      },
    },
  ],
  async cleanup() {},
};
```

`prepare(context)` runs once. Each scene's `run(context)` performs real actions, then `ready(context)` must report the observable result within 15 seconds. Readiness is checked again after the pointer moves away from dock edges. Scenes run in declared order; explicitly choose modes such as Grid/Line or light/dark rather than relying on remembered singleton state. `cleanup(context)` runs before closing the window, including after a scene fails.

The context provides `lumine`, a shared `state` object, `open(relativeFixturePath)`, `fixture(relativePath)`, `command(name, optionalTargetElement)` and `waitFor(predicate, label, timeoutMs = 15000)`. It also provides the disposable `project` and `profile` directories, the host's `nodePath`, and `packagePath(name, relativePath)` for declared dependencies. Fixture paths stay inside the copied project. Use real package APIs for features that do not have a command, and assert their visible output. Recipes with external tools must check that those tools and suitable public data are available; never replace a missing response with simulated content.

`before(context)` runs before the requested packages activate, for configuration that must precede activation. A scene can provide `drag(context)`, returning `[fromX, fromY, toX, toY]` in viewport coordinates; the driver performs an actual pointer gesture. `afterPointerMove(context)` opens hover details after the pointer leaves dock edges. In either case the readiness check waits until that action finishes. `timeout` may increase readiness polling up to 90000 ms. Use `allowNotifications: true` only when a real notification is the feature being demonstrated.

Before every screenshot, the runner rejects known workspace, user-profile and Node installation paths in visible DOM text and editor/input values. A recipe rendering text on a canvas supplies `privacyText(context)`, returning its actual visible buffer text; the terminal recipe demonstrates this with xterm's buffer. This guard supplements visual review and does not detect arbitrary secrets or every external tool's paths. Use executable names from PATH in visible commands, and keep actual fixture paths under the neutral project. Accepted metadata records the privacy-check version without publishing the private path list.

## Local tools and authenticated examples

Use `--settings <json>` to supply local package configuration, keyed by package name, for example `{"ide-jdtls":{"javaPath":"/path/to/java"}}`. Machine paths belong in this untracked operator file, never in a published recipe. Default editor fonts and normal mode remain enforced. `--server-cache <directory>` shares an existing managed `language-servers` cache through the disposable profile, avoiding repeated downloads; prepare servers using the IDE package's normal installer first. The cache may be updated by the packages that use it.

Jupyter examples use a real Python interpreter with `ipykernel`, `numpy` and `matplotlib`; `LUMINE_DEMO_PYTHON` chooses it, defaulting to `python` on PATH. Document compilation uses the actual tools required by the package; `LUMINE_DEMO_LATEXMK` and `LUMINE_DEMO_TYPST` can select the compilers, otherwise the package's configured tool path is used. SOFiSTiK examples require `LUMINE_DEMO_CDB` pointing to a real model approved for screenshots. That model is copied only into the disposable project and is not published with the recipe or accepted media.

For an authenticated example such as `github-panel`, the recipe declares the exact encrypted store keys in `secrets`. Pass `--secrets-file <profile>/secret-store.json` from a profile already authenticated for that example on the same machine. Only declared ciphertext entries and the required OS-protected Chromium crypto metadata are copied to the disposable profile; the runner never decrypts them or includes them in media metadata. Authentication still goes through the real package and operating system. Keep capture directories private and discard disposable authenticated profiles when they are no longer needed.

Scene ids are unique lowercase slugs. Output filenames are unique `demo*.png` basenames, such as `demo.png`, `demo-2.png` or `demo-hover.png`. Captions are plain, single-line text. Fixtures must be regular files beneath their directory; symlinks are rejected. Do not include credentials, user paths or private data.

Treat `demo/` as fixture data in package lint and formatting configuration, just like `spec/fixtures/`; examples may deliberately contain diagnostics or preserve particular spacing. Keep the root `demo.js` recipe covered by normal source checks. Acceptance formats generated metadata with the editor's installed Prettier and the target repository's configuration.

## What can be reproduced

`run.json` records the recipe and fixture hashes, editor/package/theme revisions, working-tree hashes and dirty flags, Electron/Chromium versions, OS, architecture, locale, display scale, fonts and window size. Source changes during a capture fail the run. `.github/demo.json` retains this provenance without local absolute paths. The fresh profile and copied project remain local for diagnosis.

The same recipe reproduces the workflow and framing. Pixel-identical output additionally needs the same OS, installed fonts, display scaling, editor dependencies and external tool versions. Prefer clean committed sources for published captures; a dirty-tree hash identifies a local state but cannot reconstruct uncommitted work. Review remains necessary: automated readiness checks cannot judge every visual defect.

Recipes live alongside the visual packages, grammars and themes. `bookmarks` illustrates editor decorations, `markdown-preview` split panes and two theme modes, and `launcher` a real action picker. Use those as starting points for new packages. Pure libraries and packages with no clear visible effect need no recipe; developer-mode-only and private maintainer packages stay outside the public gallery.
