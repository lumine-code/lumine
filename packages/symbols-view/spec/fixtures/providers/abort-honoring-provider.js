// A provider that does what `docs/symbol.provider.md` asks of one that gets
// cancelled: it stops working and returns nothing. It waits on its signal
// rather than on a clock, so it answers the instant `providerTimeout` runs out
// and a spec can await that answer instead of sleeping past it.
module.exports = {
  packageName: 'symbol-provider-abort-honoring',
  name: 'Abort Honoring',
  isExclusive: false,
  // The promise `getSymbols` last handed back, so a spec can wait for exactly
  // the moment this provider gave up.
  answered: null,
  canProvideSymbols () {
    return true;
  },
  getSymbols ({ signal }) {
    this.answered = new Promise(resolve => {
      if (signal.aborted) return resolve(null);
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    return this.answered;
  }
};
