const { Point } = require('atom');

// A provider that ignores its signal and answers well after `providerTimeout`
// has run out. It is the only kind whose symbols can still turn up once the
// list has been rendered and cached, so it is what pins that they don't.
const DELAY = 1500;

module.exports = {
  packageName: 'symbol-provider-late',
  name: 'Late',
  isExclusive: false,
  // The promise `getSymbols` last handed back, so a spec can wait for the
  // straggler to arrive rather than sleeping for longer than it takes.
  answered: null,
  canProvideSymbols () {
    return true;
  },
  getSymbols () {
    this.answered = new Promise(resolve => {
      setTimeout(() => {
        resolve([
          {
            position: new Point(0, 0),
            name: 'Late Symbol on Row 1'
          }
        ]);
      }, DELAY);
    });
    return this.answered;
  }
};
