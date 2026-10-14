// Loaded only in the isolated, normal-mode Lumine renderer by script/demo.js.
const fs = require("node:fs");
const path = require("node:path");
const { assertPublicText } = require("./demo-privacy");

async function setup(options) {
  if (path.resolve(lumine.getConfigDirPath()) !== path.resolve(options.profile))
    throw new Error("Not the owned demo profile");
  if (lumine.window.isDevMode() || lumine.window.isSafeMode())
    throw new Error("Demos require normal mode");
  const recipe = require(options.recipePath);
  const waitFor = async (predicate, label = "expected view", timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const frame = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const fixture = (relative) => {
    const result = path.resolve(options.project, relative);
    if (!result.startsWith(options.project + path.sep))
      throw new Error("Fixture escapes the demo project");
    return result;
  };
  const context = {
    lumine,
    state: {},
    waitFor,
    fixture,
    project: options.project,
    profile: options.profile,
    nodePath: options.nodePath,
    packagePath: (name, relative = "") => {
      const directory = options.packagePaths[name];
      if (!directory) throw new Error(`Declare ${name} in demo dependencies`);
      return path.join(directory, relative);
    },
    open: (relative) => lumine.workspace.open(fixture(relative)),
    command: (name, target = lumine.views.getView(lumine.workspace)) =>
      lumine.commands.dispatch(target, name),
  };
  lumine.config.set("about.showOnStartup", false);
  lumine.config.set("theme.mode", "light");
  for (const name of ["editor.fontSize", "editor.fontFamily", "editor.softWrap"])
    lumine.config.unset(name);
  await lumine.themes.switchThemes();
  await lumine.window.unmaximize();
  await lumine.setWindowDimensions({ x: 80, y: 80, ...options.viewport });
  for (const pane of lumine.workspace.getPanes())
    for (const item of pane.getItems().slice()) await pane.destroyItem(item, true);
  for (const dock of [
    lumine.workspace.getLeftDock(),
    lumine.workspace.getRightDock(),
    lumine.workspace.getBottomDock(),
  ])
    dock.hide();
  await recipe.before?.(context);
  lumine.config.set(
    "core.disabledPackages",
    (lumine.config.get("core.disabledPackages") || []).filter(
      (name) => !options.packages.includes(name),
    ),
  );
  for (const name of options.packages) await lumine.packages.activatePackage(name);
  await waitFor(() => !document.querySelector("lumine-notification"), "startup notices to close");
  let current;
  globalThis.lumineDemo = {
    async scene(id) {
      current = recipe.scenes.find((s) => s.id === id);
      await current.run(context);
      if (!current.afterPointerMove && !current.drag)
        await waitFor(() => current.ready(context), `${id} ready()`, current.timeout || 15000);
      await frame();
      return current.drag?.(context) || null;
    },
    async check() {
      // Let real dock-reveal transitions finish after moving the pointer away.
      await new Promise((resolve) => setTimeout(resolve, 450));
      await current.afterPointerMove?.(context);
      await waitFor(
        () => current.ready(context),
        `${current.id} ready()`,
        current.timeout || 15000,
      );
      await frame();
      if (!(await current.ready(context))) throw new Error("Scene lost its expected state");
      if (document.querySelector(".lumine-dock-toggle-button-visible"))
        throw new Error("A dock reveal button is visible");
      if (!current.allowNotifications && document.querySelector("lumine-notification:not(.remove)"))
        throw new Error("Unexpected notification in the demo");
      const toolbar = lumine.packages.getActivePackage("toolbar")?.mainModule.view;
      if (toolbar?.panel && !toolbar.hasContent?.()) throw new Error("Empty toolbar in the demo");
      if (lumine.window.isDevMode()) throw new Error("Normal mode was lost");
      const visible = (element) =>
        element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
      const inputs = [...document.querySelectorAll("input,textarea,lumine-text-editor")]
        .filter(visible)
        .map((element) => element.getModel?.()?.getText?.() || element.value || "");
      assertPublicText(
        [document.body.innerText, ...inputs, (await recipe.privacyText?.(context)) || ""].join(
          "\n",
        ),
        options.privateRoots,
      );
    },
    async round(input, output) {
      // Only mask the outside corners of an authentic capture, preserving every interior pixel.
      const bitmap = await createImageBitmap(
        new Blob([fs.readFileSync(input)], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.beginPath();
      ctx.roundRect(0, 0, bitmap.width, bitmap.height, 10);
      ctx.clip();
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      fs.writeFileSync(
        output,
        Buffer.from(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()),
      );
    },
    async cleanup() {
      await recipe.cleanup?.(context);
    },
  };
  await recipe.prepare?.(context);
  return {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    devicePixelRatio,
    locale: navigator.language,
    fontFamily: lumine.config.get("editor.fontFamily"),
    fontSize: lumine.config.get("editor.fontSize"),
    themes: lumine.themes.getActiveThemeNames(),
  };
}

module.exports = { setup };
