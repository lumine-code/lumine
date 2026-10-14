const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);

describe("The spec window renderer", () => {
  it("keeps local Windows command-line windows hidden even when CI is set", async () => {
    const settings = require("../src/get-window-load-settings")();
    if (
      process.platform !== "win32" ||
      !settings.headless ||
      process.env.GITHUB_ACTIONS === "true"
    ) {
      return;
    }

    expect(settings.enforceDocumentFocus).toBe(false);
    expect(settings.offscreen).toBe(true);
    expect((await lumine.window.getState()).visible).toBe(false);
  });

  it("delivers animation frames promptly while running offscreen", async () => {
    if (!require("../src/get-window-load-settings")().offscreen) return;

    const frames = new Promise((resolve) => {
      let remaining = 5;
      const next = () => {
        if (--remaining === 0) {
          resolve();
        } else {
          requestAnimationFrame(next);
        }
      };
      requestAnimationFrame(next);
    });
    let timeoutId;
    const timeout = new Promise((resolve, reject) => {
      timeoutId = nativeSetTimeout(
        () =>
          reject(new Error("The offscreen spec window delivered fewer than five frames in 1.5s")),
        1500,
      );
    });

    try {
      await Promise.race([frames, timeout]);
    } finally {
      nativeClearTimeout(timeoutId);
    }
  });
});
