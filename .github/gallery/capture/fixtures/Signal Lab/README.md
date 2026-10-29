# Signal Lab

Explore signals, write Python and keep your notes beside the code.

## From samples to insight

1. Generate a sine wave with evenly spaced samples.
2. Apply a moving average to reduce rapid changes.
3. Compare window sizes and record your observations.

## Try it

```python
from signal import moving_average, sample_wave

samples = sample_wave(frequency=2, duration=1)
smoothed = moving_average(samples, window=7)
print(f"Processed {len(smoothed)} samples.")
```

## Project files

| File | Purpose |
| --- | --- |
| `signal.py` | Signal generation and smoothing. |
| `notes.md` | Observations and experiment parameters. |

> Keep the source and its explanation together in one workspace.

## Next steps

- [x] Generate a reference signal.
- [x] Compare different averaging windows.
- [ ] Explore the effect of the sampling rate.
