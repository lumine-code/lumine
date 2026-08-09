const getWindowLoadSettings = require("../src/get-window-load-settings");

describe("getWindowLoadSettings", () => {
  const bootstrapSettings = getWindowLoadSettings();

  afterEach(() => getWindowLoadSettings.set(bootstrapSettings));

  it("throws before bootstrap state is seeded", () => {
    getWindowLoadSettings.reset();
    expect(() => getWindowLoadSettings()).toThrowError(/have not been bootstrapped/);
  });

  it("returns the synchronously cached bootstrap object after it is seeded", () => {
    const settings = { windowId: 7, appLocale: "en-US" };
    getWindowLoadSettings.set(settings);
    expect(getWindowLoadSettings()).toBe(settings);
  });
});
