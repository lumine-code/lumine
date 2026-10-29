export class SignalBuffer {
  constructor(samples = []) {
    this.samples = [...samples];
  }

  append(value) {
    this.samples.push(Number(value));
    return this;
  }

  smooth(window = 3) {
    return this.samples.map((value, index) => {
      const start = Math.max(0, index - window + 1);
      const slice = this.samples.slice(start, index + 1);
      return slice.reduce((sum, sample) => sum + sample, 0) / slice.length;
    });
  }
}

const signal = new SignalBuffer([0.2, 0.8, -0.5, 1.0]);
const smoothed = signal.append(0.4).smooth(3);
console.log(`Processed ${smoothed.length} samples.`);
