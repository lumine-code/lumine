const assert = require("./assert");
const XdgShellInvoker = require("../../src/xdg-shell-invoker");

describe("XdgShellInvoker", () => {
  it("uses the original Linux desktop for open operations and restores the environment", async () => {
    const env = {
      XDG_CURRENT_DESKTOP: "Unity",
      ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME",
    };
    const seenDesktops = [];
    const shell = {
      openPath: async () => {
        seenDesktops.push(env.XDG_CURRENT_DESKTOP);
        return "";
      },
      openExternal: async () => {
        seenDesktops.push(env.XDG_CURRENT_DESKTOP);
      },
    };
    const invoker = new XdgShellInvoker(shell, { env, platform: "linux" });

    await invoker.invoke("openPath", "/tmp/example.pdf");
    await invoker.invoke("openExternal", "https://example.test");

    assert.deepEqual(seenDesktops, ["GNOME", "GNOME"]);
    assert.strictEqual(env.XDG_CURRENT_DESKTOP, "Unity");
  });

  it("restores an initially absent desktop variable after failures", async () => {
    const env = { ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME" };
    const error = Object.assign(new Error("could not open"), { code: "OPEN_FAILED" });
    const shell = {
      openExternal: async () => {
        assert.strictEqual(env.XDG_CURRENT_DESKTOP, "GNOME");
        throw error;
      },
    };
    const invoker = new XdgShellInvoker(shell, { env, platform: "linux" });

    await assert.rejects(invoker.invoke("openExternal", "https://example.test"), error);
    assert.isFalse(Object.prototype.hasOwnProperty.call(env, "XDG_CURRENT_DESKTOP"));
  });

  it("does not alter the desktop outside Linux or without an original value", async () => {
    for (const options of [
      { env: { XDG_CURRENT_DESKTOP: "Unity", ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME" }, platform: "win32" },
      { env: { XDG_CURRENT_DESKTOP: "Unity" }, platform: "linux" },
    ]) {
      const seenDesktops = [];
      const shell = {
        openExternal: async () => seenDesktops.push(options.env.XDG_CURRENT_DESKTOP),
      };
      const invoker = new XdgShellInvoker(shell, options);

      await invoker.invoke("openExternal", "https://example.test");

      assert.deepEqual(seenDesktops, ["Unity"]);
      assert.strictEqual(options.env.XDG_CURRENT_DESKTOP, "Unity");
    }
  });

  it("delegates non-XDG shell actions without altering the desktop", async () => {
    const env = {
      XDG_CURRENT_DESKTOP: "Unity",
      ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME",
    };
    const shell = {
      trashItem: async (target) => {
        assert.strictEqual(env.XDG_CURRENT_DESKTOP, "Unity");
        return target;
      },
    };
    const invoker = new XdgShellInvoker(shell, { env, platform: "linux" });

    assert.strictEqual(await invoker.invoke("trashItem", "/tmp/old.txt"), "/tmp/old.txt");
    assert.strictEqual(env.XDG_CURRENT_DESKTOP, "Unity");
  });

  it("serializes corrected calls so their process-wide environment changes cannot overlap", async () => {
    const env = {
      XDG_CURRENT_DESKTOP: "Unity",
      ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME",
    };
    const calls = [];
    let releaseFirst;
    const firstPending = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const shell = {
      openExternal: async (target) => {
        calls.push({ target, desktop: env.XDG_CURRENT_DESKTOP });
        if (target === "first") await firstPending;
      },
    };
    const invoker = new XdgShellInvoker(shell, { env, platform: "linux" });

    const first = invoker.invoke("openExternal", "first");
    const second = invoker.invoke("openExternal", "second");
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(calls, [{ target: "first", desktop: "GNOME" }]);
    releaseFirst();
    await Promise.all([first, second]);

    assert.deepEqual(calls, [
      { target: "first", desktop: "GNOME" },
      { target: "second", desktop: "GNOME" },
    ]);
    assert.strictEqual(env.XDG_CURRENT_DESKTOP, "Unity");
  });
});
