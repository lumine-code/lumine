let windowLoadSettings = null;

module.exports = () => {
  if (!windowLoadSettings) throw new Error("Window load settings have not been bootstrapped");
  return windowLoadSettings;
};

module.exports.set = (settings) => {
  if (!settings || typeof settings !== "object") {
    throw new TypeError("Window load settings must be an object");
  }
  windowLoadSettings = settings;
};

module.exports.reset = () => {
  windowLoadSettings = null;
};
