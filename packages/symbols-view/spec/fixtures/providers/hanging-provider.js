// A provider whose `canProvideSymbols` never resolves. Used to verify that the
// provider broker times it out instead of waiting indefinitely.
module.exports = {
  packageName: 'symbol-provider-hanging',
  name: 'Hanging',
  isExclusive: false,
  canProvideSymbols () {
    return new Promise(() => {});
  },
  getSymbols () {
    return [];
  }
};
