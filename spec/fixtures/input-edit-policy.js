module.exports = (context) =>
  Object.isFrozen(context) && !`${context.before}${context.after}`.includes("reject-input-policy");
