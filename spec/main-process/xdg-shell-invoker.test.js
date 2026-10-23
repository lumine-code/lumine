const assert = require("./assert");
const sinon = require("sinon");
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

    await invoker.invoke("openPath", __filename);
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
      {
        env: { XDG_CURRENT_DESKTOP: "Unity", ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME" },
        platform: "win32",
      },
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

  it("rejects missing paths before invoking the operating system", async () => {
    const openPath = sinon.stub().resolves("");
    const invoker = new XdgShellInvoker({ openPath });

    await assert.rejects(invoker.invoke("openPath", `${__filename}.does-not-exist`), {
      code: "ENOENT",
    });

    assert.strictEqual(openPath.callCount, 0);
  });

  it("resolves successful path opens without a platform error string", async () => {
    const invoker = new XdgShellInvoker({ openPath: async () => "" });

    assert.strictEqual(await invoker.invoke("openPath", __filename), undefined);
  });

  it("rejects a platform refusal with its message", async () => {
    const invoker = new XdgShellInvoker({ openPath: async () => "No file association" });

    await assert.rejects(invoker.invoke("openPath", __filename), {
      message: "No file association",
      code: "EOPENFAILED",
    });
  });

  for (const action of ["openPath", "openExternal"]) {
    it(`bounds a pending ${action} and consumes a late failure`, async () => {
      const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let rejectOperation;
      const invoker = new XdgShellInvoker(
        {
          [action]: () =>
            new Promise((_, reject) => {
              rejectOperation = reject;
            }),
        },
        { timeout: 100, accessPath: async () => {} },
      );
      try {
        const rejected = assert.rejects(invoker.invoke(action, "target"), {
          code: "ETIMEDOUT",
          message: /operation may still complete/,
        });
        await clock.tickAsync(100);
        await rejected;
        rejectOperation(new Error("late system failure"));
        await clock.tickAsync(0);
        assert.strictEqual(clock.countTimers(), 0);
      } finally {
        clock.restore();
      }
    });
  }

  it("does not launch a path after its preflight has timed out", async () => {
    const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let releasePreflight;
    const openPath = sinon.stub().resolves("");
    const invoker = new XdgShellInvoker(
      { openPath },
      {
        timeout: 100,
        accessPath: () => new Promise((resolve) => (releasePreflight = resolve)),
      },
    );
    try {
      const rejected = assert.rejects(invoker.invoke("openPath", "target"), { code: "ETIMEDOUT" });
      await clock.tickAsync(100);
      await rejected;
      releasePreflight();
      await clock.tickAsync(0);
      assert.strictEqual(openPath.callCount, 0);
      assert.strictEqual(clock.countTimers(), 0);
    } finally {
      clock.restore();
    }
  });

  it("restores the desktop and releases queued opens after an operation times out", async () => {
    const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const env = { XDG_CURRENT_DESKTOP: "Unity", ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME" };
    const calls = [];
    const invoker = new XdgShellInvoker(
      {
        openExternal: (target) => {
          calls.push([target, env.XDG_CURRENT_DESKTOP]);
          if (target === "first") return new Promise(() => {});
        },
      },
      { env, platform: "linux", timeout: 100 },
    );
    try {
      const first = assert.rejects(invoker.invoke("openExternal", "first"), {
        code: "ETIMEDOUT",
      });
      const second = invoker.invoke("openExternal", "second");
      await clock.tickAsync(100);
      await first;
      await second;

      assert.deepEqual(calls, [
        ["first", "GNOME"],
        ["second", "GNOME"],
      ]);
      assert.strictEqual(env.XDG_CURRENT_DESKTOP, "Unity");
      assert.strictEqual(clock.countTimers(), 0);
    } finally {
      clock.restore();
    }
  });
});
