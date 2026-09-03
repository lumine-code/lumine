const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);

describe("The spec window renderer", () => {
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
