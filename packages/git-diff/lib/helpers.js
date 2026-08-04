module.exports = async function (goalPath) {
  return goalPath ? atom.repositories.resolveForPath(goalPath) : null;
};
