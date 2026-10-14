# Reproducible package screenshots

The editor owns the capture runner, `script/demo.js`. Each package owns its root-level `demo.js` recipe and small public fixtures in `demo/`. The runner uses `script/drive.js` to operate a real Lumine window. It has no dependency on the ecosystem manager or a private repository.

## Capture, review, accept

Install the editor's development dependencies and each participating package's dependencies using their normal setup instructions. Keep package checkouts beside the editor, or pass `--workspace` with their parent directory. The runner finds packages by their manifest name and requires local checkouts of the target, `one-theme` and every declared dependency. The editor supplies its remaining bundled packages from its installed dependencies.

From the editor checkout:

```sh
node script/demo.js capture ../bookmarks
node script/demo.js capture ../markdown-preview
node script/demo.js capture ../open-with
```

Each command creates a new ignored `.dev/demos/` directory, copies the fixtures into a disposable project with a clean local Git baseline, launches a fresh isolated profile in normal mode, checks each scene, and saves raw and rounded PNGs. It uses default fonts, the One theme, a fixed window size and a 10-pixel corner mask. It closes its window afterward. Your normal editor profile and dev-mode setup remain untouched. `--out <new-directory>` chooses another output location; an existing directory is rejected.

Inspect every PNG in `images/`. Check the logo, rounded edges, readable content, expected feature, and absence of unwanted selections, notifications or dock buttons. The raw captures remain in `raw/` for comparison. A failed capture has `status: "failed"`, an error and, when possible, `failure.png`; it cannot be accepted.

```sh
node script/demo.js check .dev/demos/<run>
node script/demo.js accept .dev/demos/<run> ../bookmarks
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

The context provides `lumine`, a shared `state` object, `open(relativeFixturePath)`, `fixture(relativePath)`, `command(name, optionalTargetElement)` and `waitFor(predicate, label, timeoutMs = 15000)`. Paths stay inside the copied fixture project. Use real package APIs for features that do not have a command, and assert their visible output. Recipes with external tools must check that those tools and suitable public data are available; never replace a missing response with simulated content.

Scene ids are unique lowercase slugs. Output filenames are unique `demo*.png` basenames, such as `demo.png`, `demo-2.png` or `demo-hover.png`. Captions are plain, single-line text. Fixtures must be regular files beneath their directory; symlinks are rejected. Do not include credentials, user paths or private data.

## What can be reproduced

`run.json` records the recipe and fixture hashes, editor/package/theme revisions, working-tree hashes and dirty flags, Electron/Chromium versions, OS, architecture, locale, display scale, fonts and window size. Source changes during a capture fail the run. `.github/demo.json` retains this provenance without local absolute paths. The fresh profile and copied project remain local for diagnosis.

The same recipe reproduces the workflow and framing. Pixel-identical output additionally needs the same OS, installed fonts, display scaling, editor dependencies and external tool versions. Prefer clean committed sources for published captures; a dirty-tree hash identifies a local state but cannot reconstruct uncommitted work. Review remains necessary: automated readiness checks cannot judge every visual defect.

The first examples are `bookmarks` (editor decorations), `markdown-preview` (split panes and two theme modes), and `open-with` (a real action picker). Migrate further packages one at a time, preserving these checks and each package's visible purpose.
